/**
 * authRepo.js - 认证与会话管理
 * 
 * 职责：
 * 1) 维护 AUTH_SESSION 缓存（内存 + storage）
 * 2) 处理登录状态、LAST_ROUTE、DRAFT_* 草稿数据
 * 3) 提供统一的 getSession、isLoggedIn、updateSession 接口
 * 
 * 数据流：
 * 页面 -> authRepo -> 内存缓存 / storage -> 返回结果
 */

const { STORAGE_KEYS, get, set } = require("../utils/storage");

let _sessionCache = null;
let _cacheExpireAt = 0;
const SESSION_CACHE_TTL_MS = 5 * 60 * 1000; // 5分钟缓存

function nowISOTime() {
  return new Date().toISOString();
}

function isCacheValid() {
  return _sessionCache && Date.now() < _cacheExpireAt;
}

function invalidateCache() {
  _sessionCache = null;
  _cacheExpireAt = 0;
}

/**
 * 从 storage 读取会话（带版本检查）
 */
function readSessionFromStorage() {
  try {
    const session = get(STORAGE_KEYS.AUTH_SESSION, null);
    if (!session) {
      return null;
    }

    // 补充缺失的版本信息
    if (!session.version) {
      session.version = "1";
    }
    if (!session.updated_at) {
      session.updated_at = nowISOTime();
    }
    if (!session.user_id && session.login_code) {
      session.user_id = session.login_code;
    }

    _sessionCache = session;
    _cacheExpireAt = Date.now() + SESSION_CACHE_TTL_MS;
    return session;
  } catch (err) {
    console.error("[authRepo] readSessionFromStorage failed", err);
    return null;
  }
}

/**
 * 写入会话到 storage（带版本更新）
 */
function writeSessionToStorage(session) {
  try {
    const toWrite = {
      ...session,
      version: String((parseInt(session.version || "0") + 1)),
      updated_at: nowISOTime()
    };

    set(STORAGE_KEYS.AUTH_SESSION, toWrite);
    
    _sessionCache = toWrite;
    _cacheExpireAt = Date.now() + SESSION_CACHE_TTL_MS;

    return {
      status: "success",
      data: toWrite
    };
  } catch (err) {
    console.error("[authRepo] writeSessionToStorage failed", err);
    return {
      status: "error",
      error: err.message
    };
  }
}

/**
 * 获取当前会话
 * 读取优先级：内存缓存 -> storage -> null
 */
function getSession() {
  if (isCacheValid()) {
    return _sessionCache;
  }

  return readSessionFromStorage();
}

/**
 * 检查是否登录
 */
function isLoggedIn() {
  const session = getSession();
  return Boolean(session && session.login_code);
}

/**
 * 更新会话（合并字段）
 */
function updateSession(diff) {
  const session = getSession() || {};
  const updated = {
    ...session,
    ...diff,
    updated_at: nowISOTime(),
    version: String((parseInt(session.version || "0") + 1))
  };

  return writeSessionToStorage(updated);
}

/**
 * 清空会话（登出）
 */
function clearSession() {
  invalidateCache();
  set(STORAGE_KEYS.AUTH_SESSION, null);
  return {
    status: "success"
  };
}

/**
 * 读取 LAST_ROUTE（登录回跳）
 */
function getLastRoute(fallback = "/pages/home/index") {
  try {
    const route = get(STORAGE_KEYS.LAST_ROUTE, fallback);
    return route || fallback;
  } catch (err) {
    return fallback;
  }
}

/**
 * 设置 LAST_ROUTE
 */
function setLastRoute(route) {
  try {
    set(STORAGE_KEYS.LAST_ROUTE, route);
    return {
      status: "success",
      data: route
    };
  } catch (err) {
    return {
      status: "error",
      error: err.message
    };
  }
}

/**
 * 读取草稿（DRAFT_INTAKE / DRAFT_IMPORT）
 */
function getDraft(draftType) {
  const key = draftType === "intake"
    ? STORAGE_KEYS.DRAFT_INTAKE
    : STORAGE_KEYS.DRAFT_IMPORT;

  try {
    const draft = get(key, null);
    return draft;
  } catch (err) {
    return null;
  }
}

/**
 * 保存草稿
 */
function saveDraft(draftType, content) {
  const key = draftType === "intake"
    ? STORAGE_KEYS.DRAFT_INTAKE
    : STORAGE_KEYS.DRAFT_IMPORT;

  try {
    set(key, {
      ...content,
      saved_at: nowISOTime()
    });
    return {
      status: "success"
    };
  } catch (err) {
    return {
      status: "error",
      error: err.message
    };
  }
}

/**
 * 清空草稿
 */
function clearDraft(draftType) {
  const key = draftType === "intake"
    ? STORAGE_KEYS.DRAFT_INTAKE
    : STORAGE_KEYS.DRAFT_IMPORT;

  try {
    set(key, null);
    return {
      status: "success"
    };
  } catch (err) {
    return {
      status: "error",
      error: err.message
    };
  }
}

module.exports = {
  getSession,
  isLoggedIn,
  updateSession,
  clearSession,
  invalidateCache,
  getLastRoute,
  setLastRoute,
  getDraft,
  saveDraft,
  clearDraft
};
