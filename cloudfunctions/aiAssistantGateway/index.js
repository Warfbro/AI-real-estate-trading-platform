"use strict";

const cloud = require("wx-server-sdk");
const http = require("http");
const https = require("https");
const { URL } = require("url");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

const COLLECTIONS = {
  CHAT_SESSIONS: "chat_sessions",
  CHAT_MESSAGES: "chat_messages",
  DECISION_SESSIONS: "decision_sessions",
  ACTIVITY_LOGS: "activity_logs",
  LISTINGS: "listings"
};

const AGENT_ENDPOINT_ENV_KEYS = [
  "AI_ASSISTANT_AGENT_ENDPOINT_URL",
  "CLOUD_AI_ASSISTANT_AGENT_ENDPOINT_URL",
  "CLOUD_MANAGED_AGENT_ENDPOINT_URL",
  "AI_MANAGED_AGENT_ENDPOINT_URL",
  "PROPERTY_RECOMMEND_WEBHOOK_URL"
];
const AGENT_TOKEN_ENV_KEYS = [
  "AI_ASSISTANT_AGENT_TOKEN",
  "CLOUD_AI_ASSISTANT_AGENT_TOKEN",
  "CLOUD_MANAGED_AGENT_TOKEN",
  "AI_MANAGED_AGENT_TOKEN"
];
const REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.AI_ASSISTANT_AGENT_TIMEOUT_MS || process.env.AI_AGENT_TIMEOUT_MS || "30000",
  10
);
const MAX_QUERY_LENGTH = 1000;
const MAX_RECENT_MESSAGE_IDS = 10;
const MAX_BUCKET_ITEMS = 3;

function normalizeText(value, fallback = "") {
  const text = String(value == null ? "" : value).trim();
  return text || fallback;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeStringArray(value, limit = 20) {
  const source = Array.isArray(value) ? value : [value];
  const list = [];

  for (let i = 0; i < source.length; i += 1) {
    const text = normalizeText(source[i]);
    if (text && !list.includes(text)) {
      list.push(text);
    }
    if (list.length >= limit) {
      break;
    }
  }

  return list;
}

function pickFirstText(...values) {
  for (let i = 0; i < values.length; i += 1) {
    const text = normalizeText(values[i]);
    if (text) {
      return text;
    }
  }
  return "";
}

function randomId() {
  return Math.random().toString(36).slice(2, 8);
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${randomId()}`;
}

function createTraceId(prefix) {
  return createId(prefix);
}

function nowISOTime() {
  return new Date().toISOString();
}

function pickUserId(event = {}, context = {}) {
  return normalizeText(
    event.user_id ||
      event.uid ||
      event.userId ||
      context.OPENID
  );
}

function getEnvValue(keys) {
  for (let i = 0; i < keys.length; i += 1) {
    const value = normalizeText(process.env[keys[i]]);
    if (value) {
      return value;
    }
  }
  return "";
}

function getAgentEndpoint() {
  const rawUrl = getEnvValue(AGENT_ENDPOINT_ENV_KEYS);
  if (!rawUrl) {
    return "";
  }

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    return parsed.toString();
  } catch (err) {
    return "";
  }
}

function getAgentToken() {
  return getEnvValue(AGENT_TOKEN_ENV_KEYS);
}

function parseJson(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }
  try {
    return JSON.parse(normalized);
  } catch (err) {
    return null;
  }
}

function toPreviewText(value, maxLen = 160) {
  const text = normalizeText(value);
  if (!text) {
    return "";
  }
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen)}...`;
}

function postJson(url, payload, timeoutMs = REQUEST_TIMEOUT_MS, token = "") {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = JSON.stringify(payload);
    const requester = parsed.protocol === "https:" ? https : http;
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    };

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const request = requester.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: "POST",
        headers
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode || 0,
            body: text
          });
        });
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`request timeout: ${timeoutMs}ms`));
    });

    request.on("error", (err) => reject(err));
    request.write(body);
    request.end();
  });
}

async function safeGetDoc(collectionName, docId) {
  if (!collectionName || !docId) {
    return null;
  }

  try {
    const result = await db.collection(collectionName).doc(docId).get();
    return (result && result.data) || null;
  } catch (err) {
    return null;
  }
}

async function safeQueryFirst(collectionName, where = {}, orderByField = "updated_at") {
  try {
    const result = await db
      .collection(collectionName)
      .where(where)
      .orderBy(orderByField, "desc")
      .limit(1)
      .get();
    const list = (result && result.data) || [];
    return list[0] || null;
  } catch (err) {
    return null;
  }
}

function buildError(code, message, extra = {}) {
  return {
    success: false,
    type: "error",
    data: null,
    error: {
      code: normalizeText(code, "UNKNOWN_ERROR"),
      message: normalizeText(message, "request failed"),
      details: extra.details
    },
    meta: extra.meta || {}
  };
}

function buildSuccess(type, data = {}, meta = {}) {
  return {
    success: true,
    type: normalizeText(type, "recommendation"),
    data: isPlainObject(data) ? data : {},
    error: null,
    meta
  };
}

function buildSessionPreview(messages, fallback = "") {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = normalizeText(messages[i] && messages[i].content);
    if (text) {
      return toPreviewText(text, 60);
    }
  }
  return toPreviewText(fallback, 60);
}

function buildSessionTitle(existingTitle, firstUserText) {
  const title = normalizeText(existingTitle);
  if (title) {
    return title;
  }
  const text = normalizeText(firstUserText, "New Chat");
  return text.length > 24 ? `${text.slice(0, 24)}...` : text;
}

async function writeActivityLog({
  traceId,
  actionType,
  userId,
  objectType = "ai_assistant_gateway",
  objectId = "",
  detailJson = {}
}) {
  try {
    await db.collection(COLLECTIONS.ACTIVITY_LOGS).add({
      data: {
        log_id: createId("log"),
        actor_type: userId ? "user" : "system",
        actor_id: normalizeText(userId),
        action_type: actionType,
        object_type: objectType,
        object_id: normalizeText(objectId || traceId),
        detail_json: detailJson,
        created_at: nowISOTime()
      }
    });
  } catch (err) {
    // best effort
  }
}

async function saveChatSession(session) {
  await db.collection(COLLECTIONS.CHAT_SESSIONS).doc(session.session_id).set({
    data: session
  });
  return session;
}

async function saveChatMessage(message) {
  await db.collection(COLLECTIONS.CHAT_MESSAGES).doc(message.message_id).set({
    data: message
  });
  return message;
}

async function getConversation(userId, sessionId) {
  const safeSessionId = normalizeText(sessionId);
  if (!safeSessionId) {
    return null;
  }
  const byDoc = await safeGetDoc(COLLECTIONS.CHAT_SESSIONS, safeSessionId);
  if (byDoc && normalizeText(byDoc.user_id) === normalizeText(userId)) {
    return byDoc;
  }
  return safeQueryFirst(COLLECTIONS.CHAT_SESSIONS, {
    session_id: safeSessionId,
    user_id: normalizeText(userId)
  });
}

async function ensureConversation(event = {}, context = {}) {
  const userId = pickUserId(event, context);
  if (!userId) {
    throw new Error("user_id is required");
  }

  const requestedSessionId = normalizeText(event.session_id || event.conversation_id);
  const existing = requestedSessionId
    ? await getConversation(userId, requestedSessionId)
    : null;
  const now = nowISOTime();

  if (existing) {
    const updated = {
      ...existing,
      source: normalizeText(event.source || existing.source, "ai"),
      title: buildSessionTitle(existing.title, event.title),
      summary: normalizeText(event.summary || existing.summary),
      preview: normalizeText(event.preview || existing.preview),
      updated_at: now
    };
    await saveChatSession(updated);
    return updated;
  }

  const sessionId = createId("conversation");
  const session = {
    session_id: sessionId,
    conversation_id: sessionId,
    user_id: userId,
    source: normalizeText(event.source, "ai"),
    title: buildSessionTitle(event.title, ""),
    summary: normalizeText(event.summary),
    preview: normalizeText(event.preview),
    status: "active",
    message_count: 0,
    recent_message_ids: [],
    last_message_at: now,
    created_at: now,
    updated_at: now
  };
  await saveChatSession(session);
  return session;
}

function sanitizeContext(context) {
  return isPlainObject(context) ? context : {};
}

function normalizeAgentPayload(raw, traceId, durationMs, statusCode) {
  const root = isPlainObject(raw) ? raw : {};
  const data = isPlainObject(root.data) ? { ...root.data } : {};
  const success = typeof root.success === "boolean" ? root.success : !root.error;
  if (!success) {
    return buildError(
      normalizeText(root.error && root.error.code, "UPSTREAM_ERROR"),
      normalizeText(root.error && root.error.message, "agent service failed"),
      {
        details:
          root.error && Object.prototype.hasOwnProperty.call(root.error, "details")
            ? root.error.details
            : null,
        meta: {
          trace_id: traceId,
          duration_ms: durationMs,
          upstream_status: statusCode,
          mode: "external_agent"
        }
      }
    );
  }

  const responseType = normalizeText(
    root.type ||
      data.response_type ||
      data.reply_type,
    Array.isArray(data.questions) && data.questions.length ? "clarification_needed" : "recommendation"
  );

  if (!data.message) {
    data.message = normalizeText(
      data.summary ||
        data.reply ||
        data.reply_text ||
        root.message ||
        root.reply ||
        root.reply_text
    );
  }

  return buildSuccess(responseType, data, {
    trace_id: traceId,
    duration_ms: durationMs,
    upstream_status: statusCode,
    mode: "external_agent"
  });
}

async function requestAgentService({
  traceId,
  userId,
  sessionId,
  query,
  source,
  context
}) {
  const endpoint = getAgentEndpoint();
  if (!endpoint) {
    return buildError("AGENT_ENDPOINT_MISSING", "agent endpoint is not configured", {
      meta: {
        trace_id: traceId,
        duration_ms: 0,
        mode: "external_agent"
      }
    });
  }

  const startedAt = Date.now();
  try {
    const upstream = await postJson(
      endpoint,
      {
        conversation_id: sessionId,
        session_id: sessionId,
        user_id: userId,
        query,
        source: normalizeText(source, "wechat"),
        context: sanitizeContext(context),
        timestamp: nowISOTime()
      },
      REQUEST_TIMEOUT_MS,
      getAgentToken()
    );
    const parsed = parseJson(upstream.body);
    if (!parsed || !isPlainObject(parsed)) {
      return buildError("UPSTREAM_INVALID_JSON", "agent service returned invalid json", {
        details: toPreviewText(upstream.body),
        meta: {
          trace_id: traceId,
          duration_ms: Date.now() - startedAt,
          upstream_status: upstream.statusCode,
          mode: "external_agent"
        }
      });
    }
    return normalizeAgentPayload(parsed, traceId, Date.now() - startedAt, upstream.statusCode);
  } catch (err) {
    return buildError("AGENT_REQUEST_FAILED", "request to agent service failed", {
      details: normalizeText(err && (err.message || err.errMsg)),
      meta: {
        trace_id: traceId,
        duration_ms: Date.now() - startedAt,
        mode: "external_agent"
      }
    });
  }
}

function buildStoredAiContent(result) {
  const data = isPlainObject(result && result.data) ? result.data : {};
  return normalizeText(
    data.message ||
      data.summary ||
      data.reply ||
      data.reply_text,
    result && result.success ? "AI 已返回结果" : normalizeText(result && result.error && result.error.message, "AI 服务暂不可用")
  );
}

function sanitizeListingItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }
  const listingId = normalizeText(item.listing_id || item.houseId || item.house_id);
  if (!listingId) {
    return null;
  }
  return {
    listing_id: listingId,
    title: normalizeText(item.title, "房源待补充"),
    price_total:
      item.price_total == null || Number.isNaN(Number(item.price_total))
        ? null
        : Number(item.price_total),
    area_sqm:
      item.area_sqm == null || Number.isNaN(Number(item.area_sqm))
        ? Number(item.area) || null
        : Number(item.area_sqm),
    district: normalizeText(item.district || item.city),
    city: normalizeText(item.city),
    cover_image_url: normalizeText(item.cover_image_url || item.image_url)
  };
}

async function loadDecisionListings(userId, selectedListingIds = [], localListings = []) {
  const localList = (Array.isArray(localListings) ? localListings : [])
    .map((item) => sanitizeListingItem(item))
    .filter(Boolean);
  if (localList.length) {
    return localList;
  }

  const ids = sanitizeStringArray(selectedListingIds, 20);
  if (!ids.length) {
    return [];
  }

  const items = [];
  for (let i = 0; i < ids.length; i += 1) {
    const listing = await safeGetDoc(COLLECTIONS.LISTINGS, ids[i]);
    if (!listing || normalizeText(listing.user_id) !== normalizeText(userId)) {
      continue;
    }
    const normalized = sanitizeListingItem(listing);
    if (normalized) {
      items.push(normalized);
    }
  }
  return items;
}

function buildDecisionBuckets(listings) {
  const safe = (Array.isArray(listings) ? listings : []).filter(Boolean);
  const stable = safe.slice(0, MAX_BUCKET_ITEMS);
  const balanced = safe.slice(MAX_BUCKET_ITEMS, MAX_BUCKET_ITEMS * 2);
  const value = safe.slice(MAX_BUCKET_ITEMS * 2, MAX_BUCKET_ITEMS * 3);

  return {
    stable: stable.length ? stable : safe.slice(0, MAX_BUCKET_ITEMS),
    balanced: balanced.length ? balanced : safe.slice(0, MAX_BUCKET_ITEMS),
    value: value.length ? value : safe.slice(-MAX_BUCKET_ITEMS)
  };
}

async function saveDecisionSnapshot({
  userId,
  chatSessionId,
  selectedListingIds,
  localListings,
  existingSession = null,
  action = "start",
  text = "",
  winnerListingId = "",
  loserListingId = ""
}) {
  const listings = await loadDecisionListings(userId, selectedListingIds, localListings);
  if (!listings.length) {
    return buildError("DECISION_NO_LISTINGS", "no active listings available for decision");
  }

  const now = nowISOTime();
  const session = existingSession || {
    decision_session_id: createId("decision"),
    user_id: userId,
    chat_session_id: normalizeText(chatSessionId),
    status: "active",
    current_stage: "ranking",
    selected_listing_ids: sanitizeStringArray(selectedListingIds, 20),
    candidate_listing_ids: listings.map((item) => item.listing_id),
    state_json: {},
    result_json: {},
    created_at: now,
    updated_at: now
  };

  const buckets = buildDecisionBuckets(listings);
  session.current_stage = "ranking";
  session.candidate_listing_ids = listings.map((item) => item.listing_id);
  session.state_json = {
    ...(isPlainObject(session.state_json) ? session.state_json : {}),
    last_action: normalizeText(action, "state"),
    last_text: normalizeText(text),
    last_pairwise: {
      winner_listing_id: normalizeText(winnerListingId),
      loser_listing_id: normalizeText(loserListingId)
    }
  };
  session.result_json = {
    candidate_buckets: buckets,
    top_listing_ids: buckets.stable.map((item) => item.listing_id)
  };
  session.updated_at = now;

  await db.collection(COLLECTIONS.DECISION_SESSIONS).doc(session.decision_session_id).set({
    data: session
  });

  return buildSuccess("recommendation", {
    decision_session_id: session.decision_session_id,
    current_stage: session.current_stage,
    selected_listing_ids: session.selected_listing_ids,
    candidate_listing_ids: session.candidate_listing_ids,
    candidate_buckets: buckets,
    top_listing_ids: session.result_json.top_listing_ids,
    blockers: [],
    relaxation_options: [],
    next_pairwise_question: null
  });
}

async function handleDecisionDispatch(event = {}, context = {}, traceId = "") {
  const userId = pickUserId(event, context);
  if (!userId) {
    return buildError("USER_ID_REQUIRED", "user_id is required", {
      meta: { trace_id: traceId }
    });
  }

  const action = normalizeText(event.decision_action || event.action_name || event.subaction || event.action, "state")
    .toLowerCase();
  const decisionSessionId = normalizeText(event.decision_session_id);
  const existingSession = decisionSessionId
    ? await safeGetDoc(COLLECTIONS.DECISION_SESSIONS, decisionSessionId)
    : null;

  if (action !== "start" && !existingSession) {
    return buildError("DECISION_SESSION_NOT_FOUND", "decision session not found", {
      meta: { trace_id: traceId }
    });
  }

  const selectedListingIds =
    action === "start"
      ? sanitizeStringArray(event.selected_listing_ids, 20)
      : sanitizeStringArray(existingSession && existingSession.selected_listing_ids, 20);

  return saveDecisionSnapshot({
    userId,
    chatSessionId: normalizeText(event.chat_session_id || existingSession && existingSession.chat_session_id),
    selectedListingIds,
    localListings: Array.isArray(event.local_listings) ? event.local_listings : [],
    existingSession,
    action,
    text: normalizeText(event.text),
    winnerListingId: normalizeText(event.winner_listing_id),
    loserListingId: normalizeText(event.loser_listing_id)
  });
}

exports.main = async (event = {}, context = {}) => {
  const traceId = createTraceId("ai_assistant");
  const action = normalizeText(event.action, "send_message").toLowerCase();

  try {
    if (action === "ensure_conversation") {
      const session = await ensureConversation(event, context);
      await writeActivityLog({
        traceId,
        actionType: "ai_conversation_ensure",
        userId: session.user_id,
        objectType: "chat_session",
        objectId: session.session_id,
        detailJson: {
          source: session.source
        }
      });
      return buildSuccess("recommendation", {
        session_id: session.session_id,
        conversation_id: session.session_id,
        title: session.title,
        summary: session.summary,
        preview: session.preview
      }, {
        trace_id: traceId,
        action
      });
    }

    if (action === "send_message") {
      const query = normalizeText(event.query);
      if (!query) {
        return buildError("INVALID_QUERY", "query is required", {
          meta: {
            trace_id: traceId,
            action
          }
        });
      }
      if (query.length > MAX_QUERY_LENGTH) {
        return buildError("QUERY_TOO_LONG", `query exceeds max length: ${MAX_QUERY_LENGTH}`, {
          meta: {
            trace_id: traceId,
            action
          }
        });
      }

      const session = await ensureConversation(event, context);
      const userId = normalizeText(session.user_id);
      const userMessage = {
        message_id: createId("message"),
        session_id: session.session_id,
        user_id: userId,
        role: "user",
        content: query,
        raw_model_output: "",
        created_at: nowISOTime()
      };
      await saveChatMessage(userMessage);

      const result = await requestAgentService({
        traceId,
        userId,
        sessionId: session.session_id,
        query,
        source: event.source,
        context: event.context
      });

      const aiMessage = {
        message_id: createId("message"),
        session_id: session.session_id,
        user_id: userId,
        role: "ai",
        content: buildStoredAiContent(result),
        raw_model_output: JSON.stringify(
          result && isPlainObject(result.data) ? result.data : result.error || {}
        ),
        created_at: nowISOTime()
      };
      await saveChatMessage(aiMessage);

      const updatedSession = {
        ...session,
        title: buildSessionTitle(session.title, query),
        summary: normalizeText(
          result && result.data && result.data.session_summary,
          session.summary
        ),
        preview: buildSessionPreview([userMessage, aiMessage], session.preview),
        message_count: Number(session.message_count || 0) + 2,
        recent_message_ids: []
          .concat(Array.isArray(session.recent_message_ids) ? session.recent_message_ids : [])
          .concat([userMessage.message_id, aiMessage.message_id])
          .slice(-MAX_RECENT_MESSAGE_IDS),
        last_message_at: aiMessage.created_at,
        updated_at: nowISOTime()
      };
      await saveChatSession(updatedSession);

      await writeActivityLog({
        traceId,
        actionType: result.success ? "ai_message_success" : "ai_message_fail",
        userId,
        objectType: "chat_session",
        objectId: session.session_id,
        detailJson: {
          query_length: query.length,
          response_type: normalizeText(result.type),
          error_code: normalizeText(result.error && result.error.code)
        }
      });

      return {
        ...result,
        data: {
          ...(isPlainObject(result.data) ? result.data : {}),
          session_id: session.session_id,
          conversation_id: session.session_id,
          user_message_id: userMessage.message_id,
          ai_message_id: aiMessage.message_id
        },
        meta: {
          ...(isPlainObject(result.meta) ? result.meta : {}),
          trace_id: normalizeText(
            result.meta && result.meta.trace_id,
            traceId
          ),
          action
        }
      };
    }

    if (action === "decision_dispatch") {
      const result = await handleDecisionDispatch(event, context, traceId);
      result.meta = {
        ...(isPlainObject(result.meta) ? result.meta : {}),
        trace_id: traceId,
        action
      };
      return result;
    }

    if (action === "archive_conversation") {
      const userId = pickUserId(event, context);
      const session = await getConversation(
        userId,
        event.session_id || event.conversation_id
      );
      if (!session) {
        return buildError("SESSION_NOT_FOUND", "conversation not found", {
          meta: {
            trace_id: traceId,
            action
          }
        });
      }
      const next = {
        ...session,
        status: "archived",
        updated_at: nowISOTime()
      };
      await saveChatSession(next);
      return buildSuccess("recommendation", {
        session_id: next.session_id,
        conversation_id: next.session_id,
        status: next.status
      }, {
        trace_id: traceId,
        action
      });
    }

    return buildError("UNSUPPORTED_ACTION", `unsupported action: ${action || "(empty)"}`, {
      meta: {
        trace_id: traceId,
        action
      }
    });
  } catch (err) {
    console.error("[aiAssistantGateway] execution failed", {
      trace_id: traceId,
      action,
      message: normalizeText(err && (err.message || err.errMsg)),
      stack: normalizeText(err && err.stack)
    });
    return buildError("AI_ASSISTANT_GATEWAY_FAILED", "ai assistant gateway execution failed", {
      details: normalizeText(err && (err.message || err.errMsg)),
      meta: {
        trace_id: traceId,
        action
      }
    });
  }
};
