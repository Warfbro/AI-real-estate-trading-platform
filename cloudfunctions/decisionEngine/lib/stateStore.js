const MEMORY_SESSIONS = new Map();

const COLLECTIONS = {
  DECISION_SESSIONS: "decision_sessions",
  LISTINGS: "listings"
};

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function sanitizeSessionForWrite(session) {
  if (!session || typeof session !== "object") {
    return null;
  }

  const next = {
    ...session
  };

  delete next._id;
  delete next._openid;

  return next;
}

async function getSessionFromDb(db, decisionSessionId) {
  try {
    const result = await db.collection(COLLECTIONS.DECISION_SESSIONS).doc(decisionSessionId).get();
    return (result && result.data) || null;
  } catch (err) {
    return null;
  }
}

async function saveSessionToDb(db, session) {
  const safeSession = sanitizeSessionForWrite(session);
  await db.collection(COLLECTIONS.DECISION_SESSIONS).doc(session.decision_session_id).set({
    data: safeSession
  });
  return safeSession;
}

async function listActiveListingsFromDb(db, userId) {
  try {
    const result = await db
      .collection(COLLECTIONS.LISTINGS)
      .where({
        user_id: userId,
        status: "active"
      })
      .limit(100)
      .get();
    return Array.isArray(result && result.data) ? result.data : [];
  } catch (err) {
    return [];
  }
}

function createStateStore({ db = null } = {}) {
  return {
    async getSession(decisionSessionId) {
      const sessionId = normalizeText(decisionSessionId);
      if (!sessionId) {
        return null;
      }
      if (db) {
        return getSessionFromDb(db, sessionId);
      }
      return MEMORY_SESSIONS.get(sessionId) || null;
    },

    async saveSession(session) {
      if (!session || !session.decision_session_id) {
        return null;
      }
      if (db) {
        return saveSessionToDb(db, session);
      }
      const safeSession = sanitizeSessionForWrite(session);
      MEMORY_SESSIONS.set(session.decision_session_id, safeSession);
      return safeSession;
    },

    async listActiveListings({ userId = "", localListings = [] } = {}) {
      if (Array.isArray(localListings) && localListings.length) {
        return localListings;
      }
      const safeUserId = normalizeText(userId);
      if (!db || !safeUserId) {
        return [];
      }
      return listActiveListingsFromDb(db, safeUserId);
    }
  };
}

module.exports = {
  createStateStore
};
