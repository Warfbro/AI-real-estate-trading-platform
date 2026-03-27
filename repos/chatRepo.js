/**
 * chatRepo.js - AI 对话管理
 *
 * 职责：
 * 1) 管理 AI_CHAT_THREADS、AI_CHAT_ACTIVE_SESSION_ID、chat_messages
 * 2) 提供线程/消息的读写、激活切换接口
 * 3) 自动处理最近消息聚合、会话摘要
 */

const { STORAGE_KEYS, get, set } = require("../utils/storage");

let _threadsCache = null;
let _activeSessionCache = null;

const MAX_THREADS = 20;
const MAX_MESSAGES_PER_THREAD = 80;
const RECENT_MESSAGE_LIMIT = 5;

function nowISOTime() {
  return new Date().toISOString();
}

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

/**
 * 获取所有对话线程
 */
function getThreads() {
  if (_threadsCache !== null) {
    return {
      status: "success",
      data: _threadsCache,
      source: "memory"
    };
  }

  try {
    const threads = get(STORAGE_KEYS.AI_CHAT_THREADS, []);
    if (Array.isArray(threads)) {
      _threadsCache = threads.slice(0, MAX_THREADS);
      return {
        status: "success",
        data: _threadsCache,
        source: "storage"
      };
    }
  } catch (err) {
    console.warn("[chatRepo] getThreads failed", err);
  }

  return {
    status: "success",
    data: [],
    source: "none"
  };
}

/**
 * 获取当前激活会话 ID
 */
function getActiveSessionId() {
  if (_activeSessionCache !== null) {
    return _activeSessionCache;
  }

  try {
    const sessionId = get(STORAGE_KEYS.AI_CHAT_ACTIVE_SESSION_ID, "");
    _activeSessionCache = normalizeText(sessionId);
    return _activeSessionCache;
  } catch (err) {
    return "";
  }
}

/**
 * 设置激活会话
 */
function setActiveSessionId(sessionId) {
  try {
    const id = normalizeText(sessionId);
    set(STORAGE_KEYS.AI_CHAT_ACTIVE_SESSION_ID, id);
    _activeSessionCache = id;

    return {
      status: "success",
      session_id: id
    };
  } catch (err) {
    return {
      status: "error",
      error: err.message
    };
  }
}

/**
 * 获取线程（通过 session_id）
 */
function getThread(sessionId) {
  const result = getThreads();
  if (result.status !== "success") {
    return result;
  }

  const thread = result.data.find((t) => t.session_id === sessionId);
  return {
    status: thread ? "success" : "not_found",
    data: thread || null
  };
}

/**
 * 创建或更新线程
 */
function upsertThread(sessionId, updates) {
  try {
    const result = getThreads();
    const threads = result.data || [];

    const existing = threads.findIndex((t) => t.session_id === sessionId);
    const now = nowISOTime();

    let thread;
    if (existing >= 0) {
      thread = {
        ...threads[existing],
        ...updates,
        session_id: sessionId,
        updated_at: now,
        version: String((parseInt(threads[existing].version || "0") + 1))
      };
      threads[existing] = thread;
    } else {
      thread = {
        session_id: sessionId,
        title: updates.title || "New Chat",
        preview: updates.preview || "",
        compact_context: updates.compact_context || null,
        created_at: now,
        updated_at: now,
        version: "1",
        ...updates
      };
      threads.unshift(thread);
    }

    // 保持在限制内
    const trimmed = threads.slice(0, MAX_THREADS);
    set(STORAGE_KEYS.AI_CHAT_THREADS, trimmed);
    _threadsCache = trimmed;

    return {
      status: "success",
      data: thread
    };
  } catch (err) {
    return {
      status: "error",
      error: err.message
    };
  }
}

/**
 * 删除线程
 */
function deleteThread(sessionId) {
  try {
    const result = getThreads();
    const threads = result.data || [];

    const filtered = threads.filter((t) => t.session_id !== sessionId);
    set(STORAGE_KEYS.AI_CHAT_THREADS, filtered);
    _threadsCache = filtered;

    // 如果删除的是激活会话，清空
    if (normalizeText(getActiveSessionId()) === normalizeText(sessionId)) {
      set(STORAGE_KEYS.AI_CHAT_ACTIVE_SESSION_ID, "");
      _activeSessionCache = "";
    }

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
 * 获取线程的消息列表（从存储中读取）
 * 约定：消息存储在 STORAGE_KEYS[`chat_messages_${sessionId}`]
 */
function getThreadMessages(sessionId) {
  try {
    const key = `chat_messages_${sessionId}`;
    const messages = get(key, []);
    return {
      status: "success",
      data: Array.isArray(messages) ? messages : [],
      count: Array.isArray(messages) ? messages.length : 0
    };
  } catch (err) {
    return {
      status: "error",
      error: err.message,
      data: []
    };
  }
}

/**
 * 追加消息到线程
 */
function appendMessage(sessionId, message) {
  try {
    const key = `chat_messages_${sessionId}`;
    const messages = get(key, []);
    const list = Array.isArray(messages) ? messages : [];

    const msg = {
      ...message,
      message_id: message.message_id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      created_at: message.created_at || nowISOTime(),
      version: "1"
    };

    list.push(msg);

    // 保持在限制内
    const trimmed = list.slice(-MAX_MESSAGES_PER_THREAD);
    set(key, trimmed);

    return {
      status: "success",
      data: msg
    };
  } catch (err) {
    return {
      status: "error",
      error: err.message
    };
  }
}

/**
 * 获取最近 N 条消息
 */
function getRecentMessages(sessionId, limit = RECENT_MESSAGE_LIMIT) {
  try {
    const result = getThreadMessages(sessionId);
    if (result.status !== "success") {
      return result;
    }

    const recent = result.data.slice(-limit);
    return {
      status: "success",
      data: recent,
      count: recent.length
    };
  } catch (err) {
    return {
      status: "error",
      error: err.message,
      data: []
    };
  }
}

/**
 * 清空线程所有消息
 */
function clearThreadMessages(sessionId) {
  try {
    const key = `chat_messages_${sessionId}`;
    set(key, []);
    return { status: "success" };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

/**
 * 缓存失效
 */
function invalidateCache() {
  _threadsCache = null;
  _activeSessionCache = null;
}

module.exports = {
  getThreads,
  getActiveSessionId,
  setActiveSessionId,
  getThread,
  upsertThread,
  deleteThread,
  getThreadMessages,
  appendMessage,
  getRecentMessages,
  clearThreadMessages,
  invalidateCache,
  MAX_THREADS,
  MAX_MESSAGES_PER_THREAD,
  RECENT_MESSAGE_LIMIT
};
