/**
 * repos/workflowRepo.js - 工作流状态仓库
 *
 * 职责：
 * 1) 管理 workflow_sessions / workflow_events / workflow_checkpoints
 * 2) 提供会话恢复、事件记录、快照查询的统一接口
 * 3) 维护三层缓存：内存 -> storage -> 云端
 *
 * 数据流：
 * 页面/服务调用 -> workflowRepo -> 内存/storage/云端
 */

const { STORAGE_KEYS, get, set } = require("../utils/storage");

// 内存缓存
let _sessionsCache = null;
let _sessionsCacheExpireAt = 0;
let _eventsCache = null;
let _checkpointsCache = null;

const SESSIONS_CACHE_TTL_MS = 5 * 60 * 1000; // 5分钟
const MAX_EVENTS_PER_SESSION = 100;
const MAX_CHECKPOINTS_PER_SESSION = 10;

// Storage keys
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
  return _sessionsCache && Date.now() < _sessionsCacheExpireAt;
}

function invalidateCache() {
  _sessionsCache = null;
  _sessionsCacheExpireAt = 0;
  _eventsCache = null;
  _checkpointsCache = null;
}

// ============================================================
// Workflow Sessions
// ============================================================

/**
 * 获取所有工作流会话
 */
function getSessions({ userId = "", status = null } = {}) {
  if (isSessionsCacheValid()) {
    let result = _sessionsCache;
    if (userId) {
      result = result.filter((s) => s.user_id === userId);
    }
    if (status) {
      result = result.filter((s) => s.status === status);
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
        result = result.filter((s) => s.user_id === userId);
      }
      if (status) {
        result = result.filter((s) => s.status === status);
      }
      return { status: "success", data: result, source: "storage" };
    }
  } catch (err) {
    console.warn("[workflowRepo] getSessions failed", err);
  }

  return { status: "success", data: [], source: "none" };
}

/**
 * 获取单个工作流会话
 */
function getSession(workflowSessionId) {
  const sessionId = normalizeText(workflowSessionId);
  if (!sessionId) {
    return { status: "not_found", data: null };
  }

  const result = getSessions();
  const session = (result.data || []).find((s) => s.workflow_session_id === sessionId);

  return {
    status: session ? "success" : "not_found",
    data: session || null,
    source: result.source
  };
}

/**
 * 创建或更新工作流会话
 */
function upsertSession(sessionData) {
  const sessionId = normalizeText(sessionData.workflow_session_id);
  if (!sessionId) {
    return { status: "error", error: "workflow_session_id is required" };
  }

  try {
    const sessions = get(WORKFLOW_SESSIONS_KEY, []);
    const existingIndex = sessions.findIndex((s) => s.workflow_session_id === sessionId);
    const now = nowISOTime();

    const session = {
      ...sessionData,
      workflow_session_id: sessionId,
      version: String((parseInt(sessionData.version || "0") + 1)),
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

/**
 * 更新会话状态
 */
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

/**
 * 删除会话
 */
function deleteSession(workflowSessionId) {
  const sessionId = normalizeText(workflowSessionId);
  if (!sessionId) {
    return { status: "error", error: "workflow_session_id is required" };
  }

  try {
    const sessions = get(WORKFLOW_SESSIONS_KEY, []);
    const filtered = sessions.filter((s) => s.workflow_session_id !== sessionId);
    set(WORKFLOW_SESSIONS_KEY, filtered);
    _sessionsCache = filtered;
    _sessionsCacheExpireAt = Date.now() + SESSIONS_CACHE_TTL_MS;

    // 同时清理关联的事件和检查点
    cleanupSessionEvents(sessionId);
    cleanupSessionCheckpoints(sessionId);

    return { status: "success" };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

// ============================================================
// Workflow Events
// ============================================================

/**
 * 获取会话的所有事件
 */
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

/**
 * 记录工作流事件
 */
function recordEvent({
  workflowSessionId,
  eventType,
  eventData = {},
  userId = ""
}) {
  const sessionId = normalizeText(workflowSessionId);
  if (!sessionId) {
    return { status: "error", error: "workflow_session_id is required" };
  }

  try {
    const allEvents = get(WORKFLOW_EVENTS_KEY, {});
    const sessionEvents = allEvents[sessionId] || [];
    const now = nowISOTime();

    const event = {
      event_id: generateId("evt"),
      workflow_session_id: sessionId,
      event_type: normalizeText(eventType),
      event_data: eventData,
      user_id: normalizeText(userId),
      created_at: now
    };

    sessionEvents.push(event);
    // 限制每个会话的事件数量
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

/**
 * 清理会话事件
 */
function cleanupSessionEvents(workflowSessionId) {
  try {
    const allEvents = get(WORKFLOW_EVENTS_KEY, {});
    delete allEvents[workflowSessionId];
    set(WORKFLOW_EVENTS_KEY, allEvents);
    _eventsCache = allEvents;
  } catch (err) {
    // Best effort
  }
}

// ============================================================
// Workflow Checkpoints
// ============================================================

/**
 * 获取会话的所有检查点
 */
function getSessionCheckpoints(workflowSessionId) {
  const sessionId = normalizeText(workflowSessionId);
  if (!sessionId) {
    return { status: "success", data: [] };
  }

  if (_checkpointsCache) {
    const checkpoints = _checkpointsCache[sessionId] || [];
    return { status: "success", data: checkpoints, source: "memory" };
  }

  try {
    const allCheckpoints = get(WORKFLOW_CHECKPOINTS_KEY, {});
    _checkpointsCache = allCheckpoints;
    const checkpoints = allCheckpoints[sessionId] || [];
    return { status: "success", data: checkpoints, source: "storage" };
  } catch (err) {
    return { status: "success", data: [], source: "none" };
  }
}

/**
 * 获取最新检查点
 */
function getLatestCheckpoint(workflowSessionId) {
  const result = getSessionCheckpoints(workflowSessionId);
  const checkpoints = result.data || [];
  if (!checkpoints.length) {
    return { status: "not_found", data: null };
  }
  return { status: "success", data: checkpoints[checkpoints.length - 1] };
}

/**
 * 创建检查点
 */
function createCheckpoint({
  workflowSessionId,
  stage,
  stateSnapshot,
  reason = ""
}) {
  const sessionId = normalizeText(workflowSessionId);
  if (!sessionId) {
    return { status: "error", error: "workflow_session_id is required" };
  }

  try {
    const allCheckpoints = get(WORKFLOW_CHECKPOINTS_KEY, {});
    const sessionCheckpoints = allCheckpoints[sessionId] || [];
    const now = nowISOTime();

    const checkpoint = {
      checkpoint_id: generateId("chk"),
      workflow_session_id: sessionId,
      stage: normalizeText(stage),
      state_snapshot: stateSnapshot || {},
      reason: normalizeText(reason),
      created_at: now
    };

    sessionCheckpoints.push(checkpoint);
    // 限制检查点数量
    if (sessionCheckpoints.length > MAX_CHECKPOINTS_PER_SESSION) {
      sessionCheckpoints.splice(0, sessionCheckpoints.length - MAX_CHECKPOINTS_PER_SESSION);
    }

    allCheckpoints[sessionId] = sessionCheckpoints;
    set(WORKFLOW_CHECKPOINTS_KEY, allCheckpoints);
    _checkpointsCache = allCheckpoints;

    // 更新会话的 latest_checkpoint_id
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

/**
 * 恢复到检查点
 */
function restoreToCheckpoint(workflowSessionId, checkpointId) {
  const sessionId = normalizeText(workflowSessionId);
  const result = getSessionCheckpoints(sessionId);
  const checkpoint = (result.data || []).find((c) => c.checkpoint_id === checkpointId);

  if (!checkpoint) {
    return { status: "not_found", error: "checkpoint not found" };
  }

  const sessionResult = getSession(sessionId);
  if (!sessionResult.data) {
    return { status: "not_found", error: "session not found" };
  }

  // 恢复状态
  const restored = upsertSession({
    ...sessionResult.data,
    current_stage: checkpoint.stage,
    state_json: checkpoint.state_snapshot,
    restored_from_checkpoint_id: checkpointId
  });

  // 记录恢复事件
  recordEvent({
    workflowSessionId: sessionId,
    eventType: "checkpoint_restored",
    eventData: { checkpoint_id: checkpointId, stage: checkpoint.stage }
  });

  return restored;
}

/**
 * 清理会话检查点
 */
function cleanupSessionCheckpoints(workflowSessionId) {
  try {
    const allCheckpoints = get(WORKFLOW_CHECKPOINTS_KEY, {});
    delete allCheckpoints[workflowSessionId];
    set(WORKFLOW_CHECKPOINTS_KEY, allCheckpoints);
    _checkpointsCache = allCheckpoints;
  } catch (err) {
    // Best effort
  }
}

// ============================================================
// 便捷方法
// ============================================================

/**
 * 获取用户的活跃会话
 */
function getActiveSession(userId) {
  const result = getSessions({ userId, status: "active" });
  const sessions = result.data || [];
  if (!sessions.length) {
    return { status: "not_found", data: null };
  }
  // 返回最新的活跃会话
  sessions.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  return { status: "success", data: sessions[0] };
}

/**
 * 创建新会话
 */
function createSession({
  userId,
  threadId = "",
  intakeId = "",
  initialStage = "clarifying",
  initialState = {}
}) {
  const now = nowISOTime();
  const session = {
    workflow_session_id: generateId("wf"),
    thread_id: normalizeText(threadId),
    user_id: normalizeText(userId),
    intake_id: normalizeText(intakeId),
    status: "active",
    current_stage: normalizeText(initialStage),
    current_node: "",
    state_json: initialState,
    latest_checkpoint_id: "",
    created_at: now,
    updated_at: now,
    version: "1"
  };

  const result = upsertSession(session);
  if (result.status === "success") {
    // 记录创建事件
    recordEvent({
      workflowSessionId: session.workflow_session_id,
      eventType: "session_created",
      eventData: { initial_stage: initialStage },
      userId
    });
  }

  return result;
}

module.exports = {
  // Sessions
  getSessions,
  getSession,
  upsertSession,
  updateSessionStatus,
  deleteSession,
  getActiveSession,
  createSession,

  // Events
  getSessionEvents,
  recordEvent,

  // Checkpoints
  getSessionCheckpoints,
  getLatestCheckpoint,
  createCheckpoint,
  restoreToCheckpoint,

  // Cache
  invalidateCache
};
