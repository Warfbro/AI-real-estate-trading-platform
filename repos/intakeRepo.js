/**
 * intakeRepo.js - 需求管理仓库
 *
 * 职责：
 * 1) 管理 BUYER_INTAKES 需求列表
 * 2) 提供查询、创建、更新需求的接口
 * 3) 支持需求状态转换和标记草稿
 */

const { STORAGE_KEYS, get, set } = require("../utils/storage");

let _intakesCache = null;
let _intakeCacheExpireAt = 0;

const INTAKES_CACHE_TTL_MS = 5 * 60 * 1000; // 5分钟

function nowISOTime() {
  return new Date().toISOString();
}

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function isCacheValid() {
  return _intakesCache && Date.now() < _intakeCacheExpireAt;
}

/**
 * 获取所有需求
 */
function getIntakes({ userId, status = "submitted" } = {}) {
  // 第一层：内存缓存
  if (isCacheValid()) {
    let result = _intakesCache;
    if (userId) {
      result = result.filter((item) => item.user_id === userId);
    }
    if (status) {
      result = result.filter((item) => item.status === status);
    }
    return {
      status: "success",
      data: result,
      source: "memory"
    };
  }

  // 第二层：storage 缓存
  try {
    const intakes = get(STORAGE_KEYS.BUYER_INTAKES, []);
    if (Array.isArray(intakes)) {
      _intakesCache = intakes;
      _intakeCacheExpireAt = Date.now() + INTAKES_CACHE_TTL_MS;

      let result = intakes;
      if (userId) {
        result = result.filter((item) => item.user_id === userId);
      }
      if (status) {
        result = result.filter((item) => item.status === status);
      }

      return {
        status: "success",
        data: result,
        source: "storage"
      };
    }
  } catch (err) {
    console.warn("[intakeRepo] getIntakes failed", err);
  }

  return {
    status: "success",
    data: [],
    source: "none"
  };
}

/**
 * 获取单个需求
 */
function getIntake(intakeId) {
  const result = getIntakes();
  if (result.status !== "success") {
    return result;
  }

  const intake = result.data.find((item) => item.intake_id === intakeId);
  return {
    status: intake ? "success" : "not_found",
    data: intake || null
  };
}

/**
 * 创建或更新需求
 */
function upsertIntake(intake) {
  try {
    const result = getIntakes({ status: null }); // 获取所有
    const intakes = result.data || [];

    const now = nowISOTime();
    const intakeId = intake.intake_id || `intake_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const existing = intakes.findIndex((i) => i.intake_id === intakeId);

    let updated;
    if (existing >= 0) {
      updated = {
        ...intakes[existing],
        ...intake,
        intake_id: intakeId,
        updated_at: now,
        version: String((parseInt(intakes[existing].version || "0") + 1))
      };
      intakes[existing] = updated;
    } else {
      updated = {
        intake_id: intakeId,
        status: "draft",
        created_at: now,
        updated_at: now,
        version: "1",
        ...intake
      };
      intakes.push(updated);
    }

    set(STORAGE_KEYS.BUYER_INTAKES, intakes);
    _intakesCache = intakes;
    _intakeCacheExpireAt = Date.now() + INTAKES_CACHE_TTL_MS;

    return {
      status: "success",
      data: updated
    };
  } catch (err) {
    return {
      status: "error",
      error: err.message
    };
  }
}

/**
 * 更新需求状态
 */
function updateIntakeStatus(intakeId, newStatus) {
  try {
    const result = getIntakes({ status: null });
    const intakes = result.data || [];

    const intake = intakes.find((i) => i.intake_id === intakeId);
    if (!intake) {
      return {
        status: "not_found"
      };
    }

    const updated = {
      ...intake,
      status: newStatus,
      updated_at: nowISOTime(),
      version: String((parseInt(intake.version || "0") + 1))
    };

    const idx = intakes.indexOf(intake);
    intakes[idx] = updated;

    set(STORAGE_KEYS.BUYER_INTAKES, intakes);
    _intakesCache = intakes;
    _intakeCacheExpireAt = Date.now() + INTAKES_CACHE_TTL_MS;

    return {
      status: "success",
      data: updated
    };
  } catch (err) {
    return {
      status: "error",
      error: err.message
    };
  }
}

/**
 * 删除需求
 */
function deleteIntake(intakeId) {
  try {
    const result = getIntakes({ status: null });
    const intakes = result.data || [];

    const filtered = intakes.filter((i) => i.intake_id !== intakeId);

    set(STORAGE_KEYS.BUYER_INTAKES, filtered);
    _intakesCache = filtered;
    _intakeCacheExpireAt = Date.now() + INTAKES_CACHE_TTL_MS;

    return {
      status: "success",
      deleted: true
    };
  } catch (err) {
    return {
      status: "error",
      error: err.message
    };
  }
}

/**
 * 批量更新需求列表（通常来自云端同步）
 */
function updateIntakes(intakes) {
  try {
    const normalized = Array.isArray(intakes) ? intakes : [];
    
    // 补充版本信息
    const withVersion = normalized.map((item) => ({
      ...item,
      version: item.version || "1",
      updated_at: item.updated_at || nowISOTime()
    }));

    set(STORAGE_KEYS.BUYER_INTAKES, withVersion);
    _intakesCache = withVersion;
    _intakeCacheExpireAt = Date.now() + INTAKES_CACHE_TTL_MS;

    return {
      status: "success",
      count: withVersion.length
    };
  } catch (err) {
    return {
      status: "error",
      error: err.message
    };
  }
}

/**
 * 缓存失效
 */
function invalidateCache() {
  _intakesCache = null;
  _intakeCacheExpireAt = 0;
}

module.exports = {
  getIntakes,
  getIntake,
  upsertIntake,
  updateIntakeStatus,
  deleteIntake,
  updateIntakes,
  invalidateCache
};
