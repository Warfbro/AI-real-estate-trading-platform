const { STORAGE_KEYS, get, set } = require("../../utils/storage");

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
    console.warn("[aiAssistant.chatRepo] getThreads failed", err);
  }

  return {
    status: "success",
    data: [],
    source: "none"
  };
}

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

function getThread(sessionId) {
  const result = getThreads();
  if (result.status !== "success") {
    return result;
  }

  const thread = result.data.find((item) => item.session_id === sessionId);
  return {
    status: thread ? "success" : "not_found",
    data: thread || null
  };
}

function upsertThread(sessionId, updates) {
  try {
    const result = getThreads();
    const threads = result.data || [];
    const existing = threads.findIndex((item) => item.session_id === sessionId);
    const now = nowISOTime();

    let thread;
    if (existing >= 0) {
      thread = {
        ...threads[existing],
        ...updates,
        session_id: sessionId,
        updated_at: now,
        version: String(parseInt(threads[existing].version || "0", 10) + 1)
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

function deleteThread(sessionId) {
  try {
    const result = getThreads();
    const threads = result.data || [];
    const filtered = threads.filter((item) => item.session_id !== sessionId);
    set(STORAGE_KEYS.AI_CHAT_THREADS, filtered);
    _threadsCache = filtered;

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

function clearThreadMessages(sessionId) {
  try {
    const key = `chat_messages_${sessionId}`;
    set(key, []);
    return { status: "success" };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

function replaceSessionId(oldSessionId, newSessionId) {
  const fromId = normalizeText(oldSessionId);
  const toId = normalizeText(newSessionId);
  if (!fromId || !toId || fromId === toId) {
    return {
      status: "success",
      session_id: toId || fromId
    };
  }

  try {
    const threadResult = getThread(fromId);
    const messageResult = getThreadMessages(fromId);
    const targetThreadResult = getThread(toId);
    const sourceThread =
      threadResult && threadResult.status === "success" ? threadResult.data : null;
    const targetThread =
      targetThreadResult && targetThreadResult.status === "success" ? targetThreadResult.data : null;
    const sourceMessages =
      messageResult && messageResult.status === "success" ? messageResult.data : [];

    if (sourceThread) {
      upsertThread(toId, {
        ...sourceThread,
        ...(targetThread || {}),
        session_id: toId
      });
      deleteThread(fromId);
    }

    const fromKey = `chat_messages_${fromId}`;
    const toKey = `chat_messages_${toId}`;
    const targetMessages = targetThread ? (getThreadMessages(toId).data || []) : [];
    set(toKey, Array.isArray(targetMessages) && targetMessages.length ? targetMessages : sourceMessages);
    set(fromKey, []);

    if (normalizeText(getActiveSessionId()) === fromId) {
      setActiveSessionId(toId);
    }

    return {
      status: "success",
      session_id: toId
    };
  } catch (err) {
    return {
      status: "error",
      error: err.message
    };
  }
}

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
  replaceSessionId,
  invalidateCache,
  MAX_THREADS,
  MAX_MESSAGES_PER_THREAD,
  RECENT_MESSAGE_LIMIT
};
