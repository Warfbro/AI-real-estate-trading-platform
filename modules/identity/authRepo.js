const { STORAGE_KEYS, get, set } = require("../../utils/storage");

let _sessionCache = null;
let _cacheExpireAt = 0;
const SESSION_CACHE_TTL_MS = 5 * 60 * 1000;

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

function readSessionFromStorage() {
  try {
    const session = get(STORAGE_KEYS.AUTH_SESSION, null);
    if (!session) {
      return null;
    }

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
    console.error("[identity.authRepo] readSessionFromStorage failed", err);
    return null;
  }
}

function writeSessionToStorage(session) {
  try {
    const toWrite = {
      ...session,
      version: String(parseInt(session.version || "0", 10) + 1),
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
    console.error("[identity.authRepo] writeSessionToStorage failed", err);
    return {
      status: "error",
      error: err.message
    };
  }
}

function getSession() {
  if (isCacheValid()) {
    return _sessionCache;
  }

  return readSessionFromStorage();
}

function isLoggedIn() {
  const session = getSession();
  return Boolean(session && session.login_code);
}

function updateSession(diff) {
  const session = getSession() || {};
  const updated = {
    ...session,
    ...diff,
    updated_at: nowISOTime(),
    version: String(parseInt(session.version || "0", 10) + 1)
  };

  return writeSessionToStorage(updated);
}

function clearSession() {
  invalidateCache();
  set(STORAGE_KEYS.AUTH_SESSION, null);
  return {
    status: "success"
  };
}

function getLastRoute(fallback = "/pages/home/index") {
  try {
    const route = get(STORAGE_KEYS.LAST_ROUTE, fallback);
    return route || fallback;
  } catch (err) {
    return fallback;
  }
}

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

function getDraft(draftType) {
  const key = draftType === "intake"
    ? STORAGE_KEYS.DRAFT_INTAKE
    : STORAGE_KEYS.DRAFT_IMPORT;

  try {
    return get(key, null);
  } catch (err) {
    return null;
  }
}

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
