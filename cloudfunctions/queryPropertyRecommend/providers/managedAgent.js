const http = require("http");
const https = require("https");
const { URL } = require("url");

const MODE = "managed_agent";
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.AI_AGENT_TIMEOUT_MS || "30000", 10);
const AGENT_ENDPOINT_ENV_KEYS = [
  "CLOUD_MANAGED_AGENT_ENDPOINT_URL",
  "AI_MANAGED_AGENT_ENDPOINT_URL",
  "PROPERTY_RECOMMEND_WEBHOOK_URL"
];
const AGENT_TOKEN_ENV_KEYS = [
  "CLOUD_MANAGED_AGENT_TOKEN",
  "AI_MANAGED_AGENT_TOKEN"
];
const BUY_PURPOSE_ENUM = [
  "self_use",
  "school_self_use",
  "improve",
  "investment",
  "parent_support",
  "marriage_home"
];
const CURRENT_STAGE_ENUM = [
  "clarifying",
  "searching",
  "comparing",
  "risk_review",
  "action_ready"
];
const CURRENT_STAGE_ALIAS_MAP = {
  init: "clarifying",
  intake: "clarifying",
  clarifying: "clarifying",
  empathize_and_clarify: "clarifying",
  preference_elicitation: "clarifying",
  import: "searching",
  imported: "searching",
  search: "searching",
  searching: "searching",
  initial_candidates: "searching",
  compare: "comparing",
  comparing: "comparing",
  comparison: "comparing",
  critique: "comparing",
  pairwise: "comparing",
  critique_and_refinement: "comparing",
  risk: "risk_review",
  risk_review: "risk_review",
  relaxation: "risk_review",
  relaxation_if_needed: "risk_review",
  recommendation: "action_ready",
  final_recommendation: "action_ready",
  action: "action_ready",
  action_ready: "action_ready",
  action_guidance: "action_ready"
};
const MEMORY_PATCH_FIELD_ALIAS_MAP = {
  target_city: "city",
  districts: "district",
  preferred_districts: "district",
  target_areas: "target_area",
  preferred_areas: "target_area",
  min_budget: "budget_min",
  max_budget: "budget_max",
  purchase_purpose: "buy_purpose",
  purpose: "buy_purpose",
  needs_school: "school_priority",
  school_required: "school_priority",
  needs_commute: "commute_priority",
  commute_required: "commute_priority",
  need_elevator: "elevator_required",
  elevator_needed: "elevator_required",
  accept_old: "accept_old_house",
  old_house_acceptable: "accept_old_house",
  layout_preference: "preferred_layout",
  layout: "preferred_layout",
  note: "notes",
  stage: "current_stage",
  flow_stage: "current_stage",
  candidate_listing_ids: "candidate_house_ids",
  candidate_ids: "candidate_house_ids"
};

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
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

function getEnvValue(keys) {
  for (let i = 0; i < keys.length; i += 1) {
    const value = normalizeText(process.env[keys[i]]);
    if (value) {
      return value;
    }
  }
  return "";
}

function getManagedAgentEndpoint() {
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

function getManagedAgentToken() {
  return getEnvValue(AGENT_TOKEN_ENV_KEYS);
}

function sanitizeContext(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return {};
  }
  return context;
}

function sanitizeCompactContext(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    const summary = normalizeText(value);
    return summary ? { history_summary: summary } : null;
  }
  if (Array.isArray(value)) {
    return value.length ? { history_turns: value.slice(0, 50) } : null;
  }
  if (typeof value === "object") {
    const historySummary = normalizeText(
      value.history_summary || value.session_summary || value.summary || value.reply_text || value.reply
    );
    if (historySummary && !value.history_summary) {
      return {
        ...value,
        history_summary: historySummary
      };
    }
    return value;
  }
  return null;
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  return null;
}

function normalizeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeCurrentStage(value) {
  const text = normalizeText(value).toLowerCase();
  if (!text) {
    return "";
  }
  return CURRENT_STAGE_ALIAS_MAP[text] || "";
}

function resolveMemoryPatchField(field) {
  const normalized = normalizeText(field).toLowerCase();
  return MEMORY_PATCH_FIELD_ALIAS_MAP[normalized] || normalized;
}

function sanitizeStringArray(value, limit = 10) {
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

function extractMemoryPatch(raw, data) {
  const root = raw && typeof raw === "object" ? raw : {};
  const body = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const candidates = [
    body.memory_patch,
    body.memoryPatch,
    body.memory,
    body.structured_memory,
    body.profile_patch,
    body.preference_update,
    root.memory_patch,
    root.memoryPatch,
    root.memory,
    root.structured_memory,
    root.profile_patch,
    root.preference_update
  ];

  for (let i = 0; i < candidates.length; i += 1) {
    const current = candidates[i];
    if (current && typeof current === "object" && !Array.isArray(current)) {
      return current;
    }
  }

  return {};
}

function extractCompactContext(raw, data) {
  const root = raw && typeof raw === "object" ? raw : {};
  const body = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const candidates = [
    body.compact_context,
    body.next_context,
    body.context_snapshot,
    body.compact_history,
    body.condensed_history,
    body.context_for_next_turn,
    body.next_turn_context,
    body.context_for_next_round,
    root.compact_context,
    root.next_context,
    root.context_snapshot,
    root.compact_history,
    root.condensed_history,
    root.context_for_next_turn,
    root.next_turn_context,
    root.context_for_next_round
  ];

  for (let i = 0; i < candidates.length; i += 1) {
    const compact = sanitizeCompactContext(candidates[i]);
    if (compact) {
      return compact;
    }
  }
  return null;
}

function extractSessionSummary(raw, data) {
  const root = raw && typeof raw === "object" ? raw : {};
  const body = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const compactContext = extractCompactContext(root, body);
  const candidates = [
    body.session_summary,
    body.history_summary,
    body.summary_context,
    body.conversation_summary,
    body.summary_text,
    root.session_summary,
    root.history_summary,
    root.summary_context,
    root.conversation_summary,
    root.summary_text,
    compactContext && compactContext.history_summary
  ];

  for (let i = 0; i < candidates.length; i += 1) {
    const summary = normalizeText(candidates[i]);
    if (summary) {
      return summary;
    }
  }

  return "";
}

function validateMemoryPatch(raw, data) {
  const patch = extractMemoryPatch(raw, data);
  const accepted = {};
  const rejected = [];

  function rejectField(field, reason) {
    rejected.push({ field, reason });
  }

  Object.keys(patch).forEach((field) => {
    const value = patch[field];
    const resolvedField = resolveMemoryPatchField(field);

    switch (resolvedField) {
      case "city": {
        const text = normalizeText(value);
        if (!text) {
          rejectField(field, "invalid_string");
          return;
        }
        accepted.city = text;
        return;
      }
      case "district":
      case "target_area": {
        const list = sanitizeStringArray([].concat(accepted[resolvedField] || [], value), 10);
        if (!list.length) {
          rejectField(field, "invalid_string_array");
          return;
        }
        accepted[resolvedField] = list;
        return;
      }
      case "budget_min":
      case "budget_max": {
        const num = normalizeNumber(value);
        if (num == null) {
          rejectField(field, "invalid_number");
          return;
        }
        accepted[field] = num;
        return;
      }
      case "buy_purpose": {
        const text = normalizeText(value);
        if (!BUY_PURPOSE_ENUM.includes(text)) {
          rejectField(field, "invalid_enum");
          return;
        }
        accepted.buy_purpose = text;
        return;
      }
      case "school_priority":
      case "commute_priority":
      case "elevator_required":
      case "accept_old_house": {
        const bool = normalizeBoolean(value);
        if (bool == null) {
          rejectField(field, "invalid_boolean");
          return;
        }
        accepted[field] = bool;
        return;
      }
      case "preferred_layout":
      case "notes": {
        const text = normalizeText(value);
        if (!text) {
          rejectField(field, "invalid_string");
          return;
        }
        accepted[resolvedField] = text;
        return;
      }
      case "current_stage": {
        const text = normalizeCurrentStage(value) || normalizeText(value);
        if (!CURRENT_STAGE_ENUM.includes(text)) {
          rejectField(field, "invalid_enum");
          return;
        }
        accepted.current_stage = text;
        return;
      }
      case "candidate_house_ids": {
        const list = sanitizeStringArray([].concat(accepted.candidate_house_ids || [], value), 20);
        if (!list.length) {
          rejectField(field, "invalid_string_array");
          return;
        }
        accepted.candidate_house_ids = list;
        return;
      }
      default:
        rejectField(field, "not_allowed");
    }
  });

  if (
    Object.prototype.hasOwnProperty.call(accepted, "budget_min") &&
    Object.prototype.hasOwnProperty.call(accepted, "budget_max") &&
    accepted.budget_min > accepted.budget_max
  ) {
    delete accepted.budget_min;
    delete accepted.budget_max;
    rejectField("budget_min", "budget_range_conflict");
    rejectField("budget_max", "budget_range_conflict");
  }

  return {
    accepted,
    rejected
  };
}

function extractQuestionText(value) {
  if (typeof value === "string") {
    return normalizeText(value);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }

  const direct = normalizeText(
    value.prompt || value.message || value.text || value.title || value.reply_text
  );
  if (direct) {
    return direct;
  }

  const left = normalizeText(value.left);
  const right = normalizeText(value.right);
  if (left && right) {
    return `请在“${left}”和“${right}”之间做一个选择。`;
  }

  const options = Array.isArray(value.options) ? sanitizeStringArray(value.options, 5) : [];
  if (options.length) {
    return `请在以下选项中选择：${options.join(" / ")}`;
  }

  return "";
}

function extractQuestions(raw, data) {
  const root = raw && typeof raw === "object" ? raw : {};
  const body = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const questions = [];
  const directCandidates = [body.questions, root.questions];

  for (let i = 0; i < directCandidates.length; i += 1) {
    const current = directCandidates[i];
    if (!Array.isArray(current)) {
      continue;
    }
    for (let j = 0; j < current.length; j += 1) {
      const text = extractQuestionText(current[j]);
      if (text && !questions.includes(text)) {
        questions.push(text);
      }
    }
    if (questions.length) {
      return questions;
    }
  }

  const singleQuestion = extractQuestionText(body.question || root.question);
  if (singleQuestion) {
    questions.push(singleQuestion);
  }

  return questions;
}

function extractRecommendations(raw, data) {
  const root = raw && typeof raw === "object" ? raw : {};
  const body = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const candidates = [
    body.recommendations,
    root.recommendations,
    body.candidates,
    root.candidates
  ];

  for (let i = 0; i < candidates.length; i += 1) {
    const current = Array.isArray(candidates[i]) ? candidates[i] : null;
    if (!current || !current.length) {
      continue;
    }

    return current
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const normalized = { ...item };
        if (!normalized.recommendation) {
          normalized.recommendation = normalizeText(item.reason || item.explanation);
        }
        return normalized;
      });
  }

  return [];
}

function extractActionText(value) {
  if (typeof value === "string") {
    return normalizeText(value);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  return normalizeText(value.code || value.action || value.type || value.label || value.name);
}

function extractNextSteps(raw, data) {
  const root = raw && typeof raw === "object" ? raw : {};
  const body = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const candidates = [
    body.next_steps,
    root.next_steps,
    body.actions,
    root.actions,
    body.recommended_actions,
    root.recommended_actions
  ];

  for (let i = 0; i < candidates.length; i += 1) {
    const current = Array.isArray(candidates[i]) ? candidates[i] : null;
    if (!current || !current.length) {
      continue;
    }

    const list = [];
    for (let j = 0; j < current.length; j += 1) {
      const text = extractActionText(current[j]);
      if (text && !list.includes(text)) {
        list.push(text);
      }
    }
    if (list.length) {
      return list;
    }
  }

  return [];
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

    request.on("error", (err) => {
      reject(err);
    });

    request.write(body);
    request.end();
  });
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

function hasErrorCode(code) {
  if (typeof code === "number") {
    return code !== 0;
  }
  const text = normalizeText(code);
  if (!text) {
    return false;
  }
  const normalized = text.toLowerCase();
  return normalized !== "0" && normalized !== "ok" && normalized !== "success";
}

function extractRawError(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  if (raw.error && typeof raw.error === "object") {
    return {
      code: normalizeText(raw.error.code || raw.code || "UPSTREAM_ERROR"),
      message: normalizeText(raw.error.message || raw.message || "managed agent error"),
      details:
        Object.prototype.hasOwnProperty.call(raw.error, "details") ? raw.error.details : null
    };
  }

  if (hasErrorCode(raw.code)) {
    return {
      code: normalizeText(raw.code, "UPSTREAM_ERROR"),
      message: normalizeText(raw.message || "managed agent error"),
      details: null
    };
  }

  return null;
}

function buildNormalizedData(raw) {
  const base = raw && typeof raw.data === "object" && raw.data && !Array.isArray(raw.data)
    ? { ...raw.data }
    : {};

  const understanding = normalizeText(
    base.understanding ||
      raw.understanding ||
      raw.intent ||
      raw.intent_summary ||
      base.message ||
      raw.message
  );
  const summary = normalizeText(
    base.summary ||
      base.reply ||
      base.reply_text ||
      raw.summary ||
      raw.reply ||
      raw.reply_text ||
      raw.output_text ||
      raw.answer ||
      raw.message
  );
  const advice = normalizeText(base.advice || raw.advice || base.suggestion || raw.suggestion);
  const message = normalizeText(base.message || raw.message || raw.reply_text || raw.reply);

  const questions = extractQuestions(raw, base);
  const recommendations = extractRecommendations(raw, base);
  const nextSteps = extractNextSteps(raw, base);

  if (understanding && !base.understanding) {
    base.understanding = understanding;
  }

  if (summary && !base.summary) {
    base.summary = summary;
  }

  if (advice && !base.advice) {
    base.advice = advice;
  }

  if (message && !base.message) {
    base.message = message;
  }

  if (questions.length && !Array.isArray(base.questions)) {
    base.questions = questions;
  }

  if (recommendations.length && !Array.isArray(base.recommendations)) {
    base.recommendations = recommendations;
  }

  if (nextSteps.length && !Array.isArray(base.next_steps)) {
    base.next_steps = nextSteps;
  }

  if (!Object.keys(base).length && summary) {
    base.summary = summary;
  }

  const compactContext = extractCompactContext(raw, base);
  if (compactContext) {
    base.compact_context = compactContext;
  }

  const sessionSummary = extractSessionSummary(raw, base);
  if (sessionSummary) {
    base.session_summary = sessionSummary;
  }

  const memoryPatchResult = validateMemoryPatch(raw, base);
  if (Object.keys(memoryPatchResult.accepted).length) {
    base.memory_patch = memoryPatchResult.accepted;
  }
  if (memoryPatchResult.rejected.length) {
    base.memory_patch_rejected = memoryPatchResult.rejected;
  }

  return base;
}

function resolveResponseType(raw, data) {
  const explicit = normalizeText(raw.type || data.reply_type || raw.reply_type).toLowerCase();
  const clarificationTypes = [
    "clarification_needed",
    "clarification",
    "ask_clarification",
    "ask_more",
    "ask_pairwise",
    "ask_critique",
    "pairwise",
    "critique"
  ];
  const recommendationTypes = [
    "recommendation",
    "recommend",
    "advice",
    "answer",
    "relaxation",
    "final_recommendation",
    "action_guidance"
  ];

  if (clarificationTypes.includes(explicit)) {
    return "clarification_needed";
  }
  if (recommendationTypes.includes(explicit)) {
    return "recommendation";
  }
  if (Array.isArray(data.questions) && data.questions.length) {
    return "clarification_needed";
  }
  if (data.question || raw.question) {
    return "clarification_needed";
  }
  return "recommendation";
}

function normalizeManagedAgentResponse(raw, traceId, durationMs, statusCode) {
  const object = raw && typeof raw === "object" ? raw : {};
  const explicitSuccess = typeof object.success === "boolean" ? object.success : null;
  const extractedError = extractRawError(object);

  const success = explicitSuccess != null ? explicitSuccess : !extractedError;
  if (!success) {
    const error = extractedError || {
      code: "UPSTREAM_ERROR",
      message: "managed agent request failed",
      details: null
    };

    return {
      success: false,
      type: "error",
      data: null,
      error,
      meta: {
        ...(object.meta || {}),
        trace_id: traceId,
        duration_ms: durationMs,
        upstream_status: statusCode,
        mode: MODE
      }
    };
  }

  const data = buildNormalizedData(object);
  const inferredType = resolveResponseType(object, data);

  return {
    success: true,
    type: normalizeText(object.type, inferredType),
    data,
    error: null,
    meta: {
      ...(object.meta || {}),
      trace_id: traceId,
      duration_ms: durationMs,
      upstream_status: statusCode,
      mode: MODE
    }
  };
}

async function request(payload, { traceId, buildErrorResult, startTime }) {
  const endpoint = getManagedAgentEndpoint();
  const durationMs = () => Date.now() - startTime;

  if (!endpoint) {
    return buildErrorResult({
      code: "AGENT_ENDPOINT_MISSING",
      message: `missing managed agent endpoint; set one of: ${AGENT_ENDPOINT_ENV_KEYS.join(", ")}`,
      traceId,
      durationMs: durationMs(),
      mode: MODE
    });
  }

  const upstreamPayload = {
    protocol_version: normalizeText(payload.protocolVersion, "agent-1.1"),
    request_id: normalizeText(payload.requestId),
    query: normalizeText(payload.query),
    user_id: normalizeText(payload.userId, "anonymous"),
    session_id: normalizeText(payload.sessionId),
    source: normalizeText(payload.source, "wechat"),
    context: sanitizeContext(payload.context),
    options:
      payload.options && typeof payload.options === "object" && !Array.isArray(payload.options)
        ? payload.options
        : {},
    timestamp: new Date().toISOString()
  };

  try {
    const upstream = await postJson(
      endpoint,
      upstreamPayload,
      REQUEST_TIMEOUT_MS,
      getManagedAgentToken()
    );
    const parsed = parseJson(upstream.body);

    if (!parsed || typeof parsed !== "object") {
      return buildErrorResult({
        code: "UPSTREAM_INVALID_JSON",
        message: "upstream response is not valid JSON",
        traceId,
        durationMs: durationMs(),
        details: toPreviewText(upstream.body),
        mode: MODE
      });
    }

    if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
      return buildErrorResult({
        code: "UPSTREAM_HTTP_ERROR",
        message: `upstream status ${upstream.statusCode}`,
        traceId,
        durationMs: durationMs(),
        details: toPreviewText(upstream.body),
        mode: MODE
      });
    }

    return normalizeManagedAgentResponse(parsed, traceId, durationMs(), upstream.statusCode);
  } catch (err) {
    const message = normalizeText(err && (err.message || err.errMsg));
    const isTimeout = message.toLowerCase().includes("timeout");

    return buildErrorResult({
      code: isTimeout ? "UPSTREAM_TIMEOUT" : "REQUEST_FAILED",
      message: isTimeout ? "request to managed agent timed out" : "request to managed agent failed",
      traceId,
      durationMs: durationMs(),
      details: toPreviewText(message),
      mode: MODE
    });
  }
}

module.exports = {
  mode: MODE,
  request
};
