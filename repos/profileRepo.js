/**
 * profileRepo.js - 用户个人资料与设置
 *
 * 职责：
 * 1) 管理 AI_MEMORY_PROFILE、AI_ACTIVE_REQUIREMENT 等用户业务资料
 * 2) 维护搜索偏好、区域选择等用户设置
 * 3) 提供统一读写接口
 */

const { STORAGE_KEYS, get, set } = require("../utils/storage");

let _profileCache = null;
let _requirementCache = null;
let _preferencesCache = null;

function nowISOTime() {
  return new Date().toISOString();
}

/**
 * 获取 AI 记忆资料
 */
function getAIMemoryProfile() {
  if (_profileCache !== null) {
    return {
      status: "success",
      data: _profileCache,
      source: "memory"
    };
  }

  try {
    const profile = get(STORAGE_KEYS.AI_MEMORY_PROFILE, null);
    if (profile) {
      _profileCache = profile;
      return {
        status: "success",
        data: profile,
        source: "storage"
      };
    }
  } catch (err) {
    console.warn("[profileRepo] getAIMemoryProfile failed", err);
  }

  return {
    status: "success",
    data: null,
    source: "none"
  };
}

/**
 * 更新 AI 记忆资料
 */
function updateAIMemoryProfile(profile) {
  try {
    const updated = {
      ...profile,
      version: String((parseInt(profile.version || "0") + 1)),
      updated_at: nowISOTime()
    };

    set(STORAGE_KEYS.AI_MEMORY_PROFILE, updated);
    _profileCache = updated;

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
 * 获取当前活跃需求(requirement)
 */
function getActiveRequirement() {
  if (_requirementCache !== null) {
    return {
      status: "success",
      data: _requirementCache,
      source: "memory"
    };
  }

  try {
    const req = get(STORAGE_KEYS.AI_ACTIVE_REQUIREMENT, null);
    if (req) {
      _requirementCache = req;
      return {
        status: "success",
        data: req,
        source: "storage"
      };
    }
  } catch (err) {
    console.warn("[profileRepo] getActiveRequirement failed", err);
  }

  return {
    status: "success",
    data: null,
    source: "none"
  };
}

/**
 * 更新活跃需求
 */
function updateActiveRequirement(requirement) {
  try {
    const updated = {
      ...requirement,
      version: String((parseInt(requirement.version || "0") + 1)),
      updated_at: nowISOTime()
    };

    set(STORAGE_KEYS.AI_ACTIVE_REQUIREMENT, updated);
    _requirementCache = updated;

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
 * 获取用户搜索偏好
 */
function getPreferences() {
  if (_preferencesCache !== null) {
    return _preferencesCache;
  }

  try {
    const prefs = {
      search_history: get(STORAGE_KEYS.SEARCH_HISTORY, []),
      home_city_region: get(STORAGE_KEYS.HOME_CITY_REGION, []),
      search_region_filter: get(STORAGE_KEYS.SEARCH_REGION_FILTER, [])
    };

    _preferencesCache = prefs;
    return prefs;
  } catch (err) {
    return {
      search_history: [],
      home_city_region: [],
      search_region_filter: []
    };
  }
}

/**
 * 更新搜索历史
 */
function updateSearchHistory(keyword, maxItems = 20) {
  try {
    const history = get(STORAGE_KEYS.SEARCH_HISTORY, []);
    const list = Array.isArray(history) ? history : [];
    
    const normalized = String(keyword).trim();
    if (!normalized) {
      return { status: "skip" };
    }

    // 去重 & 从前移
    const idx = list.indexOf(normalized);
    if (idx >= 0) {
      list.splice(idx, 1);
    }
    list.unshift(normalized);

    // 截断
    const trimmed = list.slice(0, maxItems);
    set(STORAGE_KEYS.SEARCH_HISTORY, trimmed);

    _preferencesCache = null;

    return {
      status: "success",
      count: trimmed.length
    };
  } catch (err) {
    return {
      status: "error",
      error: err.message
    };
  }
}

/**
 * 更新主城市区域选择
 */
function updateHomeCityRegion(regionArray) {
  try {
    set(STORAGE_KEYS.HOME_CITY_REGION, regionArray);
    _preferencesCache = null;
    return { status: "success" };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

/**
 * 更新搜索区域过滤
 */
function updateSearchRegionFilter(regionArray) {
  try {
    set(STORAGE_KEYS.SEARCH_REGION_FILTER, regionArray);
    _preferencesCache = null;
    return { status: "success" };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

/**
 * 清空搜索历史
 */
function clearSearchHistory() {
  try {
    set(STORAGE_KEYS.SEARCH_HISTORY, []);
    _preferencesCache = null;
    return { status: "success" };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

/**
 * 缓存失效
 */
function invalidateCache() {
  _profileCache = null;
  _requirementCache = null;
  _preferencesCache = null;
}

module.exports = {
  getAIMemoryProfile,
  updateAIMemoryProfile,
  getActiveRequirement,
  updateActiveRequirement,
  getPreferences,
  updateSearchHistory,
  updateHomeCityRegion,
  updateSearchRegionFilter,
  clearSearchHistory,
  invalidateCache
};
