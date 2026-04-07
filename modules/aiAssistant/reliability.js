/**
 * modules/aiAssistant/reliability.js - 可靠性基础设施
 *
 * 职责：
 * 1) 超时与重试
 * 2) 降级处理
 * 3) 断路器
 * 4) 可观测性日志
 *
 * 每个云调用都应通过此模块包装
 */

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG = {
  timeout: 10000,
  retries: 2,
  retryDelay: 1000,
  circuitThreshold: 5,
  circuitResetTime: 30000
};

/**
 * 断路器状态
 */
const circuitState = {
  failures: {},
  openUntil: {},
  halfOpenAttempts: {}
};

/**
 * 可观测性日志队列
 */
const observabilityLogs = [];
const MAX_LOGS = 100;

/**
 * 记录可观测性日志
 */
function logObservability(entry) {
  const log = {
    timestamp: Date.now(),
    ...entry
  };

  observabilityLogs.push(log);
  if (observabilityLogs.length > MAX_LOGS) {
    observabilityLogs.shift();
  }

  // 输出到控制台（开发环境）
  if (typeof console !== "undefined" && console.log) {
    const level = entry.level || "info";
    const msg = `[${level.toUpperCase()}] ${entry.operation || "unknown"}: ${entry.message || ""}`;
    if (level === "error") {
      console.error(msg, entry);
    } else if (level === "warn") {
      console.warn(msg, entry);
    } else {
      console.log(msg, entry);
    }
  }

  return log;
}

/**
 * 获取可观测性日志
 */
function getObservabilityLogs(filter = {}) {
  let logs = [...observabilityLogs];

  if (filter.operation) {
    logs = logs.filter((l) => l.operation === filter.operation);
  }
  if (filter.level) {
    logs = logs.filter((l) => l.level === filter.level);
  }
  if (filter.since) {
    logs = logs.filter((l) => l.timestamp >= filter.since);
  }

  return logs;
}

/**
 * 检查断路器状态
 */
function checkCircuit(operationKey) {
  const now = Date.now();
  const openUntil = circuitState.openUntil[operationKey];

  if (openUntil && now < openUntil) {
    return { open: true, reason: "circuit_open", resetAt: openUntil };
  }

  if (openUntil && now >= openUntil) {
    // 半开状态：允许一次尝试
    circuitState.halfOpenAttempts[operationKey] =
      (circuitState.halfOpenAttempts[operationKey] || 0) + 1;
    return { open: false, halfOpen: true };
  }

  return { open: false };
}

/**
 * 记录断路器成功
 */
function recordCircuitSuccess(operationKey) {
  circuitState.failures[operationKey] = 0;
  circuitState.openUntil[operationKey] = 0;
  circuitState.halfOpenAttempts[operationKey] = 0;
}

/**
 * 记录断路器失败
 */
function recordCircuitFailure(operationKey, config = {}) {
  const threshold = config.circuitThreshold || DEFAULT_CONFIG.circuitThreshold;
  const resetTime = config.circuitResetTime || DEFAULT_CONFIG.circuitResetTime;

  circuitState.failures[operationKey] = (circuitState.failures[operationKey] || 0) + 1;

  if (circuitState.failures[operationKey] >= threshold) {
    circuitState.openUntil[operationKey] = Date.now() + resetTime;
    logObservability({
      level: "warn",
      operation: operationKey,
      message: `断路器已打开，将在 ${resetTime / 1000}s 后重置`,
      failures: circuitState.failures[operationKey]
    });
  }
}

/**
 * 延迟函数
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带超时的 Promise
 */
function withTimeout(promise, ms, operationKey = "unknown") {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`操作超时 (${ms}ms): ${operationKey}`));
    }, ms);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * 可靠调用包装器
 */
async function reliableCall(operationKey, fn, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  const startTime = Date.now();

  // 检查断路器
  const circuitStatus = checkCircuit(operationKey);
  if (circuitStatus.open) {
    logObservability({
      level: "warn",
      operation: operationKey,
      message: "断路器已打开，跳过调用",
      resetAt: circuitStatus.resetAt
    });

    // 尝试降级
    if (typeof config.fallback === "function") {
      const fallbackResult = await config.fallback();
      return {
        success: true,
        data: fallbackResult,
        degraded: true,
        reason: "circuit_open"
      };
    }

    return {
      success: false,
      error: { code: "CIRCUIT_OPEN", message: "服务暂时不可用，请稍后重试" },
      degraded: true
    };
  }

  let lastError = null;
  let attempt = 0;

  while (attempt <= config.retries) {
    attempt++;

    try {
      logObservability({
        level: "info",
        operation: operationKey,
        message: `开始调用 (尝试 ${attempt}/${config.retries + 1})`,
        attempt
      });

      const result = await withTimeout(fn(), config.timeout, operationKey);

      const duration = Date.now() - startTime;
      logObservability({
        level: "info",
        operation: operationKey,
        message: `调用成功`,
        duration,
        attempt
      });

      recordCircuitSuccess(operationKey);

      return {
        success: true,
        data: result,
        degraded: false,
        duration,
        attempts: attempt
      };
    } catch (err) {
      lastError = err;
      const duration = Date.now() - startTime;

      logObservability({
        level: "error",
        operation: operationKey,
        message: normalizeText(err && (err.message || err.errMsg), "调用失败"),
        duration,
        attempt,
        error: err
      });

      if (attempt <= config.retries) {
        await delay(config.retryDelay * attempt);
      }
    }
  }

  // 所有重试都失败
  recordCircuitFailure(operationKey, config);

  // 尝试降级
  if (typeof config.fallback === "function") {
    try {
      const fallbackResult = await config.fallback();
      logObservability({
        level: "warn",
        operation: operationKey,
        message: "使用降级结果",
        lastError: normalizeText(lastError && lastError.message)
      });
      return {
        success: true,
        data: fallbackResult,
        degraded: true,
        reason: "all_retries_failed"
      };
    } catch (fallbackErr) {
      logObservability({
        level: "error",
        operation: operationKey,
        message: "降级也失败",
        error: fallbackErr
      });
    }
  }

  return {
    success: false,
    error: {
      code: "CALL_FAILED",
      message: normalizeText(lastError && (lastError.message || lastError.errMsg), "服务调用失败")
    },
    degraded: false,
    attempts: attempt
  };
}

/**
 * 创建可靠的云函数调用器
 */
function createReliableCloudCaller(cloudCallFn, defaultOptions = {}) {
  return async function reliableCloudCall(functionName, data = {}, options = {}) {
    const operationKey = `cloud:${functionName}`;
    const mergedOptions = { ...defaultOptions, ...options };

    return reliableCall(
      operationKey,
      () => cloudCallFn({ name: functionName, data }),
      {
        ...mergedOptions,
        fallback: mergedOptions.fallback || (() => ({
          success: false,
          fallback: true,
          message: `${functionName} 服务暂时不可用`
        }))
      }
    );
  };
}

/**
 * 健康检查
 */
function getHealthStatus() {
  const now = Date.now();
  const openCircuits = [];

  Object.keys(circuitState.openUntil).forEach((key) => {
    if (circuitState.openUntil[key] > now) {
      openCircuits.push({
        operation: key,
        failures: circuitState.failures[key],
        resetAt: circuitState.openUntil[key]
      });
    }
  });

  const recentErrors = observabilityLogs.filter(
    (l) => l.level === "error" && l.timestamp > now - 60000
  );

  return {
    healthy: openCircuits.length === 0,
    openCircuits,
    recentErrorCount: recentErrors.length,
    timestamp: now
  };
}

/**
 * 重置断路器
 */
function resetCircuit(operationKey) {
  if (operationKey) {
    circuitState.failures[operationKey] = 0;
    circuitState.openUntil[operationKey] = 0;
    circuitState.halfOpenAttempts[operationKey] = 0;
  } else {
    Object.keys(circuitState.failures).forEach((key) => {
      circuitState.failures[key] = 0;
      circuitState.openUntil[key] = 0;
      circuitState.halfOpenAttempts[key] = 0;
    });
  }
}

module.exports = {
  DEFAULT_CONFIG,
  logObservability,
  getObservabilityLogs,
  checkCircuit,
  recordCircuitSuccess,
  recordCircuitFailure,
  reliableCall,
  createReliableCloudCaller,
  getHealthStatus,
  resetCircuit,
  delay,
  withTimeout
};
