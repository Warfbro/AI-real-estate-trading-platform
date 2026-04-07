const { get, set } = require("../../utils/storage");

let _sessionsCache = null;
let _sessionsCacheExpireAt = 0;
let _eventsCache = null;
let _checkpointsCache = null;

const SESSIONS_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_EVENTS_PER_SESSION = 100;
const MAX_CHECKPOINTS_PER_SESSION = 10;

const WORKFLOW_SESSIONS_KEY = "WORKFLOW_SESSIONS";
const WORKFLOW_EVENTS_KEY = "WORKFLOW_EVENTS";
const WORKFLOW_CHECKPOINTS_KEY = "WORKFLOW_CHECKPOINTS";

function nowISOTime() {
  return new Date().toISOString();
}

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function isSessionsCacheValid() {
  return Boolean(_sessionsCache) && Date.now() < _sessionsCacheExpireAt;
}

function invalidateCache() {
  _sessionsCache = null;
  _sessionsCacheExpireAt = 0;
  _eventsCache = null;
  _checkpointsCache = null;
}

function getSessions({ userId = "", status = null } = {}) {
  if (isSessionsCacheValid()) {
    let result = _sessionsCache;
    if (userId) {
      result = result.filter((item) => item.user_id === userId);
    }
    if (status) {
      result = result.filter((item) => item.status === status);
    }
    return { status: "success", data: result, source: "memory" };
  }

  try {
    const sessions = get(WORKFLOW_SESSIONS_KEY, []);
    if (Array.isArray(sessions)) {
      _sessionsCache = sessions;
      _sessionsCacheExpireAt = Date.now() + SESSIONS_CACHE_TTL_MS;

      let result = sessions;
      if (userId) {
        result = result.filter((item) => item.user_id === userId);
      }
      if (status) {
        result = result.filter((item) => item.status === status);
      }
      return { status: "success", data: result, source: "storage" };
    }
  } catch (err) {
    console.warn("[aiAssistant.workflowRepo] getSessions failed", err);
  }

  return { status: "success", data: [], source: "none" };
}

function getSession(workflowSessionId) {
  const sessionId = normalizeText(workflowSessionId);
  if (!sessionId) {
    return { status: "not_found", data: null };
  }

  const result = getSessions();
  const session = (result.data || []).find((item) => item.workflow_session_id === sessionId);

  return {
    status: session ? "success" : "not_found",
    data: session || null,
    source: result.source
  };
}

function upsertSession(sessionData) {
  const sessionId = normalizeText(sessionData.workflow_session_id);
  if (!sessionId) {
    return { status: "error", error: "workflow_session_id is required" };
  }

  try {
    const sessions = get(WORKFLOW_SESSIONS_KEY, []);
    const existingIndex = sessions.findIndex((item) => item.workflow_session_id === sessionId);
    const now = nowISOTime();

    const session = {
      ...sessionData,
      workflow_session_id: sessionId,
      version: String(parseInt(sessionData.version || "0", 10) + 1),
      updated_at: now,
      created_at: sessionData.created_at || now
    };

    if (existingIndex >= 0) {
      sessions[existingIndex] = session;
    } else {
      sessions.push(session);
    }

    set(WORKFLOW_SESSIONS_KEY, sessions);
    _sessionsCache = sessions;
    _sessionsCacheExpireAt = Date.now() + SESSIONS_CACHE_TTL_MS;

    return { status: "success", data: session };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

function updateSessionStatus(workflowSessionId, status) {
  const result = getSession(workflowSessionId);
  if (result.status !== "success" || !result.data) {
    return { status: "not_found" };
  }

  return upsertSession({
    ...result.data,
    status
  });
}

function cleanupSessionEvents(workflowSessionId) {
  try {
    const allEvents = get(WORKFLOW_EVENTS_KEY, {});
    delete allEvents[workflowSessionId];
    set(WORKFLOW_EVENTS_KEY, allEvents);
    _eventsCache = allEvents;
  } catch (err) {
    // best effort
  }
}

function cleanupSessionCheckpoints(workflowSessionId) {
  try {
    const allCheckpoints = get(WORKFLOW_CHECKPOINTS_KEY, {});
    delete allCheckpoints[workflowSessionId];
    set(WORKFLOW_CHECKPOINTS_KEY, allCheckpoints);
    _checkpointsCache = allCheckpoints;
  } catch (err) {
    // best effort
  }
}

function deleteSession(workflowSessionId) {
  const sessionId = normalizeText(workflowSessionId);
  if (!sessionId) {
    return { status: "error", error: "workflow_session_id is required" };
  }

  try {
    const sessions = get(WORKFLOW_SESSIONS_KEY, []);
    const filtered = sessions.filter((item) => item.workflow_session_id !== sessionId);
    set(WORKFLOW_SESSIONS_KEY, filtered);
    _sessionsCache = filtered;
    _sessionsCacheExpireAt = Date.now() + SESSIONS_CACHE_TTL_MS;

    cleanupSessionEvents(sessionId);
    cleanupSessionCheckpoints(sessionId);

    return { status: "success" };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

function getSessionEvents(workflowSessionId, { limit = 50 } = {}) {
  const sessionId = normalizeText(workflowSessionId);
  if (!sessionId) {
    return { status: "success", data: [] };
  }

  if (_eventsCache) {
    const events = (_eventsCache[sessionId] || []).slice(-limit);
    return { status: "success", data: events, source: "memory" };
  }

  try {
    const allEvents = get(WORKFLOW_EVENTS_KEY, {});
    _eventsCache = allEvents;
    const events = (allEvents[sessionId] || []).slice(-limit);
    return { status: "success", data: events, source: "storage" };
  } catch (err) {
    return { status: "success", data: [], source: "none" };
  }
}

function normalizeRecordEventInput(inputOrWorkflowSessionId, legacyEvent) {
  if (typeof inputOrWorkflowSessionId === "string") {
    const payload = legacyEvent && typeof legacyEvent === "object" ? legacyEvent : {};
    return {
      workflowSessionId: inputOrWorkflowSessionId,
      eventType: payload.eventType || payload.event_type || "",
      eventData: payload.eventData || payload.event_data || payload.payload || {},
      userId: payload.userId || payload.user_id || ""
    };
  }

  return inputOrWorkflowSessionId || {};
}

function recordEvent(inputOrWorkflowSessionId, legacyEvent) {
  const {
    workflowSessionId,
    eventType,
    eventData = {},
    userId = ""
  } = normalizeRecordEventInput(inputOrWorkflowSessionId, legacyEvent);

  const sessionId = normalizeText(workflowSessionId);
  if (!sessionId) {
    return { status: "error", error: "workflow_session_id is required" };
  }

  try {
    const allEvents = get(WORKFLOW_EVENTS_KEY, {});
    const sessionEvents = allEvents[sessionId] || [];
    const event = {
      event_id: generateId("evt"),
      workflow_session_id: sessionId,
      event_type: normalizeText(eventType),
      event_data: eventData,
      user_id: normalizeText(userId),
      created_at: nowISOTime()
    };

    sessionEvents.push(event);
    if (sessionEvents.length > MAX_EVENTS_PER_SESSION) {
      sessionEvents.splice(0, sessionEvents.length - MAX_EVENTS_PER_SESSION);
    }

    allEvents[sessionId] = sessionEvents;
    set(WORKFLOW_EVENTS_KEY, allEvents);
    _eventsCache = allEvents;

    return { status: "success", data: event };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

function getSessionCheckpoints(workflowSessionId) {
  const sessionId = normalizeText(workflowSessionId);
  if (!sessionId) {
    return { status: "success", data: [] };
  }

  if (_checkpointsCache) {
    return {
      status: "success",
      data: _checkpointsCache[sessionId] || [],
      source: "memory"
    };
  }

  try {
    const allCheckpoints = get(WORKFLOW_CHECKPOINTS_KEY, {});
    _checkpointsCache = allCheckpoints;
    return {
      status: "success",
      data: allCheckpoints[sessionId] || [],
      source: "storage"
    };
  } catch (err) {
    return { status: "success", data: [], source: "none" };
  }
}

function getCheckpoints(workflowSessionId) {
  const result = getSessionCheckpoints(workflowSessionId);
  return result.data || [];
}

function getLatestCheckpoint(workflowSessionId) {
  const result = getSessionCheckpoints(workflowSessionId);
  const checkpoints = result.data || [];
  if (!checkpoints.length) {
    return { status: "not_found", data: null };
  }
  return { status: "success", data: checkpoints[checkpoints.length - 1] };
}

function normalizeCheckpointInput(inputOrWorkflowSessionId, legacyCheckpoint) {
  if (typeof inputOrWorkflowSessionId === "string") {
    const payload = legacyCheckpoint && typeof legacyCheckpoint === "object" ? legacyCheckpoint : {};
    const stateSnapshot = payload.stateSnapshot || payload.state_snapshot || {};
    return {
      workflowSessionId: inputOrWorkflowSessionId,
      stage: payload.stage || stateSnapshot.state || "",
      stateSnapshot,
      reason: payload.reason || payload.checkpoint_type || ""
    };
  }

  return inputOrWorkflowSessionId || {};
}

function createCheckpoint(inputOrWorkflowSessionId, legacyCheckpoint) {
  const {
    workflowSessionId,
    stage,
    stateSnapshot,
    reason = ""
  } = normalizeCheckpointInput(inputOrWorkflowSessionId, legacyCheckpoint);

  const sessionId = normalizeText(workflowSessionId);
  if (!sessionId) {
    return { status: "error", error: "workflow_session_id is required" };
  }

  try {
    const allCheckpoints = get(WORKFLOW_CHECKPOINTS_KEY, {});
    const sessionCheckpoints = allCheckpoints[sessionId] || [];
    const checkpoint = {
      checkpoint_id: generateId("chk"),
      workflow_session_id: sessionId,
      stage: normalizeText(stage),
      state_snapshot: stateSnapshot || {},
      reason: normalizeText(reason),
      created_at: nowISOTime()
    };

    sessionCheckpoints.push(checkpoint);
    if (sessionCheckpoints.length > MAX_CHECKPOINTS_PER_SESSION) {
      sessionCheckpoints.splice(0, sessionCheckpoints.length - MAX_CHECKPOINTS_PER_SESSION);
    }

    allCheckpoints[sessionId] = sessionCheckpoints;
    set(WORKFLOW_CHECKPOINTS_KEY, allCheckpoints);
    _checkpointsCache = allCheckpoints;

    const sessionResult = getSession(sessionId);
    if (sessionResult.data) {
      upsertSession({
        ...sessionResult.data,
        latest_checkpoint_id: checkpoint.checkpoint_id
      });
    }

    return { status: "success", data: checkpoint };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

function restoreToCheckpoint(workflowSessionId, checkpointId) {
  const sessionId = normalizeText(workflowSessionId);
  const result = getSessionCheckpoints(sessionId);
  const checkpoint = (result.data || []).find((item) => item.checkpoint_id === checkpointId);

  if (!checkpoint) {
    return { status: "not_found", error: "checkpoint not found" };
  }

  const sessionResult = getSession(sessionId);
  if (!sessionResult.data) {
    return { status: "not_found", error: "session not found" };
  }

  const restored = upsertSession({
    ...sessionResult.data,
    current_stage: checkpoint.stage,
    state_json: checkpoint.state_snapshot,
    restored_from_checkpoint_id: checkpointId
  });

  recordEvent({
    workflowSessionId: sessionId,
    eventType: "checkpoint_restored",
    eventData: { checkpoint_id: checkpointId, stage: checkpoint.stage }
  });

  return restored;
}

function getActiveSession(userId) {
  const result = getSessions({ userId, status: "active" });
  const sessions = result.data || [];
  if (!sessions.length) {
    return { status: "not_found", data: null };
  }

  sessions.sort((left, right) => (right.updated_at || "").localeCompare(left.updated_at || ""));
  return { status: "success", data: sessions[0] };
}

function normalizeSessionInput(input = {}) {
  const now = nowISOTime();
  return {
    workflow_session_id: normalizeText(input.workflow_session_id) || generateId("wf"),
    workflow_type: normalizeText(input.workflow_type, "decision"),
    thread_id: normalizeText(input.thread_id || input.threadId),
    user_id: normalizeText(input.user_id || input.userId),
    intake_id: normalizeText(input.intake_id || input.intakeId),
    status: normalizeText(input.status, "active"),
    current_stage: normalizeText(input.current_stage || input.initialStage, "clarifying"),
    current_node: normalizeText(input.current_node),
    state_json: input.state_json || input.initialState || {},
    latest_checkpoint_id: normalizeText(input.latest_checkpoint_id),
    created_at: input.created_at || now,
    updated_at: input.updated_at || now,
    version: input.version || "1"
  };
}

function createSession(input = {}) {
  const session = normalizeSessionInput(input);
  const result = upsertSession(session);

  if (result.status === "success") {
    recordEvent({
      workflowSessionId: session.workflow_session_id,
      eventType: "session_created",
      eventData: { initial_stage: session.current_stage },
      userId: session.user_id
    });
  }

  return result;
}

module.exports = {
  getSessions,
  getSession,
  upsertSession,
  updateSessionStatus,
  deleteSession,
  getActiveSession,
  createSession,
  getSessionEvents,
  recordEvent,
  getSessionCheckpoints,
  getCheckpoints,
  getLatestCheckpoint,
  createCheckpoint,
  restoreToCheckpoint,
  invalidateCache
};
