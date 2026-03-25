const cloud = require("wx-server-sdk");
const { resolveProvider } = require("./providers");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

const COLLECTIONS = {
  ACTIVITY_LOGS: "activity_logs"
};

const MAX_QUERY_LENGTH = 1000;
const PROTOCOL_VERSION = "agent-1.1";

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
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

function sanitizeObjectArray(value, limit = 20) {
  const source = Array.isArray(value) ? value : [value];
  const list = [];

  for (let i = 0; i < source.length; i += 1) {
    const item = source[i];
    if (isPlainObject(item)) {
      list.push(item);
    }
    if (list.length >= limit) {
      break;
    }
  }

  return list;
}

function sanitizeListingSummary(value) {
  if (!isPlainObject(value)) {
    return null;
  }

  const listingId = normalizeText(
    value.listing_id || value.id || value.house_id || value.candidate_id
  );
  const title = normalizeText(value.title || value.name);

  if (!listingId && !title) {
    return null;
  }

  const summary = {};
  if (listingId) {
    summary.listing_id = listingId;
  }
  if (title) {
    summary.title = title;
  }

  [
    "city",
    "district",
    "community_name",
    "price_total",
    "area_sqm",
    "layout_desc",
    "elevator_flag",
    "tags_json"
  ].forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      summary[field] = value[field];
    }
  });

  return summary;
}

function sanitizeListingSummaryArray(value, limit = 20) {
  const source = Array.isArray(value) ? value : [value];
  const list = [];

  for (let i = 0; i < source.length; i += 1) {
    const item = sanitizeListingSummary(source[i]);
    if (item) {
      list.push(item);
    }
    if (list.length >= limit) {
      break;
    }
  }

  return list;
}

function pickFirstObject(candidates) {
  for (let i = 0; i < candidates.length; i += 1) {
    if (isPlainObject(candidates[i])) {
      return candidates[i];
    }
  }
  return null;
}

function pickFirstArray(candidates) {
  for (let i = 0; i < candidates.length; i += 1) {
    if (Array.isArray(candidates[i]) && candidates[i].length) {
      return candidates[i];
    }
  }
  return null;
}

function randomId() {
  return Math.random().toString(36).slice(2, 8);
}

function createTraceId(prefix) {
  return `${prefix}_${Date.now()}_${randomId()}`;
}

function sanitizeContext(context) {
  if (!isPlainObject(context)) {
    return {};
  }

  const normalized = { ...context };

  const activeIntake = pickFirstObject([
    context.active_intake,
    context.previous_understanding,
    context.activeIntake
  ]);
  if (activeIntake) {
    normalized.active_intake = activeIntake;
    if (!isPlainObject(normalized.previous_understanding)) {
      normalized.previous_understanding = activeIntake;
    }
  }

  const memoryProfile = pickFirstObject([
    context.memory_profile,
    context.user_profile,
    context.profile_memory
  ]);
  if (memoryProfile) {
    normalized.memory_profile = memoryProfile;
  }

  const activeRequirement = pickFirstObject([
    context.active_requirement,
    context.current_requirement,
    context.requirement_memory
  ]);
  if (activeRequirement) {
    normalized.active_requirement = activeRequirement;
  }

  const flowStage = normalizeText(
    context.flow_stage ||
      context.flowStage ||
      context.current_stage ||
      (activeRequirement && activeRequirement.current_stage)
  );
  if (flowStage) {
    normalized.flow_stage = flowStage;
  }

  const selectedListingsSource =
    pickFirstArray([
      context.selected_listings,
      context.favorite_listings,
      context.candidate_listings,
      context.selectedListingDetails
    ]) ||
    context.selected_listings ||
    context.favorite_listings ||
    context.candidate_listings ||
    context.selectedListingDetails;
  const selectedListings = sanitizeListingSummaryArray(selectedListingsSource);
  if (selectedListings.length) {
    normalized.selected_listings = selectedListings;
  }

  const selectedListingIds = sanitizeStringArray(
    []
      .concat(context.selected_listing_ids || [])
      .concat(context.favorite_listing_ids || [])
      .concat(context.candidate_listing_ids || [])
      .concat(selectedListings.map((item) => item.listing_id)),
    20
  );
  if (selectedListingIds.length) {
    normalized.selected_listing_ids = selectedListingIds;
  }

  const latestComparison = pickFirstObject([
    context.latest_comparison,
    context.comparison_summary,
    context.last_comparison
  ]);
  if (latestComparison) {
    normalized.latest_comparison = latestComparison;
  }

  const latestRiskCheck = pickFirstObject([
    context.latest_risk_check,
    context.risk_summary,
    context.last_risk_check
  ]);
  if (latestRiskCheck) {
    normalized.latest_risk_check = latestRiskCheck;
  }

  const recentActions = sanitizeObjectArray(
    context.recent_actions || context.next_actions || context.action_history,
    20
  );
  if (recentActions.length) {
    normalized.recent_actions = recentActions;
  }

  return normalized;
}

function buildErrorResult({
  code,
  message,
  traceId,
  durationMs,
  details = null,
  mode = "unknown_provider"
}) {
  return {
    success: false,
    type: "error",
    data: null,
    error: {
      code,
      message,
      details
    },
    meta: {
      trace_id: traceId,
      duration_ms: durationMs,
      mode
    }
  };
}

async function writeQueryLog({
  traceId,
  userId,
  sessionId,
  source,
  queryLength,
  success,
  type,
  durationMs,
  errorCode,
  engineMode,
  memoryPatchFieldCount = 0,
  sessionSummaryPresent = false
}) {
  try {
    const now = new Date().toISOString();
    await db.collection(COLLECTIONS.ACTIVITY_LOGS).add({
      data: {
        log_id: `log_${Date.now()}_${randomId()}`,
        actor_type: userId ? "user" : "system",
        actor_id: userId || "",
        action_type: "ai_property_recommend_query",
        object_type: "ai_recommendation",
        object_id: traceId,
        detail_json: {
          trace_id: traceId,
          session_id: sessionId,
          source,
          query_length: queryLength,
          success,
          response_type: type,
          error_code: errorCode,
          memory_patch_field_count: memoryPatchFieldCount,
          session_summary_present: sessionSummaryPresent,
          duration_ms: durationMs,
          engine_mode: engineMode
        },
        created_at: now
      }
    });
  } catch (err) {
    // Best effort logging.
  }
}

function normalizeProviderResult(result, traceId, providerMode, startTime) {
  if (!result || typeof result !== "object") {
    return buildErrorResult({
      code: "REQUEST_FAILED",
      message: "provider returned invalid result",
      traceId,
      durationMs: Date.now() - startTime,
      mode: providerMode
    });
  }

  const meta = result.meta && typeof result.meta === "object" ? result.meta : {};
  return {
    ...result,
    meta: {
      ...meta,
      trace_id: normalizeText(meta.trace_id, traceId),
      duration_ms: Number.isFinite(meta.duration_ms) ? meta.duration_ms : Date.now() - startTime,
      mode: normalizeText(meta.mode, providerMode)
    }
  };
}

exports.main = async (event = {}, context = {}) => {
  const startTime = Date.now();
  const traceId = createTraceId("ai_recommend");
  const requestId = normalizeText(event.request_id, createTraceId("req"));

  const provider = resolveProvider(event.provider_mode);
  const providerMode = normalizeText(provider && provider.mode, "openai_compatible");

  const query = normalizeText(event.query);
  const userId = normalizeText(event.user_id || context.OPENID);
  const sessionId = normalizeText(event.session_id, `session_${Date.now()}`);
  const source = normalizeText(event.source, "wechat");

  if (!query) {
    return buildErrorResult({
      code: "INVALID_QUERY",
      message: "query is required",
      traceId,
      durationMs: Date.now() - startTime,
      mode: providerMode
    });
  }

  if (query.length > MAX_QUERY_LENGTH) {
    return buildErrorResult({
      code: "QUERY_TOO_LONG",
      message: `query exceeds max length: ${MAX_QUERY_LENGTH}`,
      traceId,
      durationMs: Date.now() - startTime,
      mode: providerMode
    });
  }

  let result;

  try {
    result = await provider.request(
      {
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        query,
        userId,
        sessionId,
        source,
        context: sanitizeContext(event.context),
        options:
          event.options && typeof event.options === "object" && !Array.isArray(event.options)
            ? event.options
            : {}
      },
      {
        traceId,
        startTime,
        buildErrorResult
      }
    );
  } catch (err) {
    result = buildErrorResult({
      code: "REQUEST_FAILED",
      message: "provider execution failed",
      traceId,
      durationMs: Date.now() - startTime,
      details: normalizeText(err && (err.message || err.errMsg)),
      mode: providerMode
    });
  }

  const normalizedResult = normalizeProviderResult(result, traceId, providerMode, startTime);

  await writeQueryLog({
    traceId: normalizeText(normalizedResult.meta && normalizedResult.meta.trace_id, traceId),
    userId,
    sessionId,
    source,
    queryLength: query.length,
    success: Boolean(normalizedResult.success),
    type: normalizeText(normalizedResult.type, "error"),
    durationMs:
      Number.isFinite(normalizedResult.meta && normalizedResult.meta.duration_ms)
        ? normalizedResult.meta.duration_ms
        : Date.now() - startTime,
    errorCode: normalizedResult.error ? normalizeText(normalizedResult.error.code) : "",
    engineMode: normalizeText(normalizedResult.meta && normalizedResult.meta.mode, providerMode),
    memoryPatchFieldCount: Object.keys((normalizedResult.data && normalizedResult.data.memory_patch) || {})
      .length,
    sessionSummaryPresent: Boolean(normalizedResult.data && normalizedResult.data.session_summary)
  });

  return normalizedResult;
};
