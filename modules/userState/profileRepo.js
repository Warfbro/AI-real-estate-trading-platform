const { STORAGE_KEYS, get, set } = require("../../utils/storage");

let _profileCache = null;
let _requirementCache = null;
let _preferencesCache = null;

function nowISOTime() {
  return new Date().toISOString();
}

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
    console.warn("[userState.profileRepo] getAIMemoryProfile failed", err);
  }

  return {
    status: "success",
    data: null,
    source: "none"
  };
}

function updateAIMemoryProfile(profile) {
  try {
    const updated = {
      ...profile,
      version: String(parseInt(profile.version || "0", 10) + 1),
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
    console.warn("[userState.profileRepo] getActiveRequirement failed", err);
  }

  return {
    status: "success",
    data: null,
    source: "none"
  };
}

function updateActiveRequirement(requirement) {
  try {
    const updated = {
      ...requirement,
      version: String(parseInt(requirement.version || "0", 10) + 1),
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

function updateSearchHistory(keyword, maxItems = 20) {
  try {
    const history = get(STORAGE_KEYS.SEARCH_HISTORY, []);
    const list = Array.isArray(history) ? history : [];
    const normalized = String(keyword || "").trim();
    if (!normalized) {
      return { status: "skip" };
    }

    const idx = list.indexOf(normalized);
    if (idx >= 0) {
      list.splice(idx, 1);
    }
    list.unshift(normalized);

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

function updateHomeCityRegion(regionArray) {
  try {
    set(STORAGE_KEYS.HOME_CITY_REGION, regionArray);
    _preferencesCache = null;
    return { status: "success" };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

function updateSearchRegionFilter(regionArray) {
  try {
    set(STORAGE_KEYS.SEARCH_REGION_FILTER, regionArray);
    _preferencesCache = null;
    return { status: "success" };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

function clearSearchHistory() {
  try {
    set(STORAGE_KEYS.SEARCH_HISTORY, []);
    _preferencesCache = null;
    return { status: "success" };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

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
