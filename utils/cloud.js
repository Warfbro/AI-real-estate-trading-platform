const CLOUD_ENV_ID = "cloud1-8giu626m8dfdd890";
const CLOUD_UPLOAD_ROOT = "listing-imports";

const CLOUD_COLLECTIONS = {
  USERS: "users",
  USER_PROFILES: "user_profiles",
  BUYER_INTAKES: "buyer_intakes",
  LISTING_IMPORT_JOBS: "listing_import_jobs",
  LISTINGS: "listings",
  DECISION_SESSIONS: "decision_sessions",
  CHAT_SESSIONS: "chat_sessions",
  CHAT_MESSAGES: "chat_messages"
};

let cloudInitialized = false;

function canUseCloud() {
  return typeof wx !== "undefined" && wx && typeof wx.cloud !== "undefined";
}

function hasExplicitEnv() {
  return Boolean(CLOUD_ENV_ID) && CLOUD_ENV_ID.indexOf("replace-with-") !== 0;
}

function ensureCloud() {
  if (!canUseCloud()) {
    return false;
  }
  if (!cloudInitialized) {
    const options = {
      traceUser: true
    };
    if (hasExplicitEnv()) {
      options.env = CLOUD_ENV_ID;
    }
    wx.cloud.init(options);
    cloudInitialized = true;
  }
  return true;
}

function getDatabase() {
  if (!ensureCloud()) {
    throw new Error("wx.cloud unavailable");
  }
  return wx.cloud.database();
}

function callFunction(name, data = {}) {
  return new Promise((resolve, reject) => {
    if (!ensureCloud()) {
      reject(new Error("wx.cloud unavailable"));
      return;
    }
    wx.cloud.callFunction({
      name,
      data,
      success(res) {
        resolve((res && res.result) || {});
      },
      fail(err) {
        reject(err);
      }
    });
  });
}

function setDocument(collectionName, docId, data) {
  return new Promise((resolve, reject) => {
    getDatabase()
      .collection(collectionName)
      .doc(docId)
      .set({
        data,
        success() {
          resolve(data);
        },
        fail(err) {
          reject(err);
        }
      });
  });
}

function getDocument(collectionName, docId) {
  return new Promise((resolve, reject) => {
    if (!docId) {
      resolve(null);
      return;
    }
    getDatabase()
      .collection(collectionName)
      .doc(docId)
      .get({
        success(res) {
          resolve((res && res.data) || null);
        },
        fail(err) {
          reject(err);
        }
      });
  });
}

function saveByIdField(collectionName, idField, data) {
  const docId = String((data && data[idField]) || "").trim();
  if (!docId) {
    return Promise.reject(new Error(`${collectionName} missing ${idField}`));
  }
  return setDocument(collectionName, docId, data);
}

async function getOpenId() {
  const result = await callFunction("getOpenId");
  return String(result.openid || "").trim();
}

async function getLoginIdentity({ role, provider = "wechat", phoneCode = "" }) {
  const result = await callFunction("getOpenId", {
    sync_user: true,
    role,
    provider,
    phone_code: String(phoneCode || "").trim()
  });
  const openid = String(result.openid || "").trim();
  const userSynced = Object.prototype.hasOwnProperty.call(result, "user_synced")
    ? Boolean(result.user_synced)
    : false;
  const userSyncError = String(
    result.user_sync_error ||
      (Object.prototype.hasOwnProperty.call(result, "user_synced")
        ? ""
        : "getOpenId cloud function not upgraded for users sync")
  ).trim();
  const phoneBound = Object.prototype.hasOwnProperty.call(result, "phone_bound")
    ? Boolean(result.phone_bound)
    : false;
  const phoneSyncError = String(result.phone_sync_error || "").trim();

  return {
    openid,
    unionid: String(result.unionid || "").trim(),
    appid: String(result.appid || "").trim(),
    userId: String(result.user_id || openid).trim(),
    userSynced,
    userSyncError,
    phoneBound,
    phoneSyncError
  };
}

function syncBuyerIntake(intake) {
  return saveByIdField(CLOUD_COLLECTIONS.BUYER_INTAKES, "intake_id", intake);
}

async function syncUserProfile(profile) {
  const userId = String((profile && profile.user_id) || "").trim();
  if (!userId) {
    return Promise.reject(new Error("user_profiles missing user_id"));
  }

  let existing = null;
  try {
    existing = await getDocument(CLOUD_COLLECTIONS.USER_PROFILES, userId);
  } catch (err) {
    existing = null;
  }

  const next = {
    ...(existing || {}),
    ...(profile || {})
  };
  return setDocument(CLOUD_COLLECTIONS.USER_PROFILES, userId, next);
}

function syncListingImportJob(job) {
  return saveByIdField(CLOUD_COLLECTIONS.LISTING_IMPORT_JOBS, "job_id", job);
}

function syncListing(listing) {
  return saveByIdField(CLOUD_COLLECTIONS.LISTINGS, "listing_id", listing);
}

function syncChatSession(session) {
  return saveByIdField(CLOUD_COLLECTIONS.CHAT_SESSIONS, "session_id", session);
}

function syncChatMessage(message) {
  return saveByIdField(CLOUD_COLLECTIONS.CHAT_MESSAGES, "message_id", message);
}

function uploadImportImage({ userId, tempFilePath }) {
  return new Promise((resolve, reject) => {
    if (!tempFilePath) {
      resolve("");
      return;
    }
    if (!ensureCloud()) {
      reject(new Error("wx.cloud unavailable"));
      return;
    }
    const suffix = tempFilePath.lastIndexOf(".") >= 0
      ? tempFilePath.slice(tempFilePath.lastIndexOf("."))
      : ".jpg";
    const cloudPath = [
      CLOUD_UPLOAD_ROOT,
      String(userId || "anonymous"),
      `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${suffix}`
    ].join("/");
    wx.cloud.uploadFile({
      cloudPath,
      filePath: tempFilePath,
      success(res) {
        resolve((res && res.fileID) || "");
      },
      fail(err) {
        reject(err);
      }
    });
  });
}

function getHomeHotListings({ limit = 8, city = "", userId = "" } = {}) {
  return callFunction("getHomeHotListings", {
    limit,
    city,
    user_id: userId
  });
}

function getHomeGuessListings({
  page = 1,
  pageSize = 10,
  city = "",
  userId = ""
} = {}) {
  return callFunction("getHomeGuessListings", {
    page,
    page_size: pageSize,
    city,
    user_id: userId
  });
}

function queryPropertyRecommend({
  query,
  userId = "",
  sessionId = "",
  source = "wechat",
  context = {}
} = {}) {
  return callFunction("queryPropertyRecommend", {
    query: String(query || "").trim(),
    user_id: String(userId || "").trim(),
    session_id: String(sessionId || "").trim(),
    source: String(source || "wechat").trim(),
    context: context && typeof context === "object" && !Array.isArray(context) ? context : {}
  });
}

function callDecisionEngine({
  action,
  userId = "",
  chatSessionId = "",
  decisionSessionId = "",
  selectedListingIds = [],
  winnerListingId = "",
  loserListingId = "",
  text = "",
  context = {},
  localListings = []
} = {}) {
  return callFunction("decisionEngine", {
    action: String(action || "").trim(),
    user_id: String(userId || "").trim(),
    chat_session_id: String(chatSessionId || "").trim(),
    decision_session_id: String(decisionSessionId || "").trim(),
    selected_listing_ids: Array.isArray(selectedListingIds) ? selectedListingIds : [],
    winner_listing_id: String(winnerListingId || "").trim(),
    loser_listing_id: String(loserListingId || "").trim(),
    text: String(text || "").trim(),
    context: context && typeof context === "object" && !Array.isArray(context) ? context : {},
    local_listings: Array.isArray(localListings) ? localListings : []
  });
}

// ============================================================
// 阶段2：统一调用协议 - 三个标准入口
// ============================================================

/**
 * 统一请求结构
 * - request_id: 请求唯一标识（用于幂等）
 * - thread_id: 对话线程 ID
 * - workflow_session_id: 工作流会话 ID
 * - scene: 业务场景
 * - payload: 具体请求参数
 */

/**
 * 统一响应结构
 * - success: 是否成功
 * - status: 状态码
 * - current_stage: 当前阶段
 * - current_node: 当前节点
 * - interrupt: 是否中断等待输入
 * - ui_blocks: 前端渲染块
 * - artifacts: 产出物
 * - memory_patch: 记忆更新
 * - error: 错误信息
 * - meta: 元信息（trace_id, duration_ms）
 */

function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildUnifiedRequest({
  requestId,
  threadId = "",
  workflowSessionId = "",
  scene = "",
  payload = {}
}) {
  return {
    request_id: requestId || generateRequestId(),
    thread_id: String(threadId || "").trim(),
    workflow_session_id: String(workflowSessionId || "").trim(),
    scene: String(scene || "").trim(),
    payload: payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {},
    timestamp: new Date().toISOString()
  };
}

function normalizeUnifiedResponse(result) {
  const safe = result && typeof result === "object" ? result : {};
  const data = safe.data && typeof safe.data === "object" ? safe.data : safe;

  return {
    success: safe.success !== false && !safe.error,
    status: String(safe.status || data.status || "ok").trim(),
    current_stage: String(data.current_stage || "").trim(),
    current_node: String(data.current_node || "").trim(),
    interrupt: Boolean(data.interrupt),
    ui_blocks: Array.isArray(data.ui_blocks) ? data.ui_blocks : [],
    artifacts: data.artifacts && typeof data.artifacts === "object" ? data.artifacts : {},
    memory_patch: data.memory_patch && typeof data.memory_patch === "object" ? data.memory_patch : null,
    error: safe.error || data.error || null,
    meta: {
      trace_id: String(data.trace_id || safe.trace_id || "").trim(),
      duration_ms: Number(data.duration_ms || safe.duration_ms) || null
    },
    raw: safe
  };
}

/**
 * 检索层统一入口
 * 只负责：解析检索条件、召回候选、返回证据、混合检索与重排
 */
async function retrievalSearch({
  requestId,
  threadId = "",
  scene = "property_search",
  query = "",
  filters = {},
  options = {}
} = {}) {
  const request = buildUnifiedRequest({
    requestId,
    threadId,
    scene,
    payload: {
      query: String(query || "").trim(),
      filters: filters && typeof filters === "object" ? filters : {},
      options: options && typeof options === "object" ? options : {}
    }
  });

  // 当前阶段：转发到现有接口，后续可替换为独立检索云函数
  try {
    const result = await callFunction("getHomeGuessListings", {
      keyword: request.payload.query,
      ...request.payload.filters,
      ...request.payload.options
    });

    return normalizeUnifiedResponse({
      success: true,
      status: "ok",
      data: {
        candidates: Array.isArray(result.list) ? result.list : [],
        evidence: [],
        strategy: result.strategy || "fallback"
      }
    });
  } catch (err) {
    return normalizeUnifiedResponse({
      success: false,
      status: "error",
      error: { code: "RETRIEVAL_ERROR", message: err && (err.message || err.errMsg) }
    });
  }
}

/**
 * 生成层统一入口
 * 只负责：需求理解、澄清问题、解释候选、总结输出
 */
async function llmGenerate({
  requestId,
  threadId = "",
  workflowSessionId = "",
  scene = "property_consult",
  mode = "intent",
  query = "",
  context = {}
} = {}) {
  const request = buildUnifiedRequest({
    requestId,
    threadId,
    workflowSessionId,
    scene,
    payload: {
      mode: String(mode || "intent").trim(),
      query: String(query || "").trim(),
      context: context && typeof context === "object" ? context : {}
    }
  });

  // 当前阶段：转发到 queryPropertyRecommend，后续可替换为独立生成云函数
  try {
    const result = await queryPropertyRecommend({
      query: request.payload.query,
      userId: context.user_id || "",
      sessionId: request.thread_id,
      context: request.payload.context
    });

    return normalizeUnifiedResponse({
      success: true,
      status: "ok",
      data: result
    });
  } catch (err) {
    return normalizeUnifiedResponse({
      success: false,
      status: "error",
      error: { code: "LLM_ERROR", message: err && (err.message || err.errMsg) }
    });
  }
}

/**
 * 工作流层统一入口
 * 只负责：状态推进、中断恢复、节点切换、输出前端 ui_blocks
 */
async function workflowDispatch({
  requestId,
  threadId = "",
  workflowSessionId = "",
  scene = "decision",
  event = "UI_ACTION",
  action = "",
  payload = {},
  context = {},
  localListings = []
} = {}) {
  const request = buildUnifiedRequest({
    requestId,
    threadId,
    workflowSessionId,
    scene,
    payload: {
      event: String(event || "UI_ACTION").trim(),
      action: String(action || "").trim(),
      ...payload
    }
  });

  // 当前阶段：转发到 decisionEngine，后续可升级为更强工作流框架
  try {
    const result = await callDecisionEngine({
      action: request.payload.action,
      userId: context.user_id || "",
      chatSessionId: request.thread_id,
      decisionSessionId: request.workflow_session_id,
      selectedListingIds: payload.selected_listing_ids || [],
      winnerListingId: payload.winner || "",
      loserListingId: payload.loser || "",
      text: payload.text || payload.critique || "",
      context,
      localListings
    });

    return normalizeUnifiedResponse(result);
  } catch (err) {
    return normalizeUnifiedResponse({
      success: false,
      status: "error",
      error: { code: "WORKFLOW_ERROR", message: err && (err.message || err.errMsg) }
    });
  }
}

// ============================================================
// 原有辅助函数
// ============================================================

/**
 * 标准化云数据对象（补充版本和时间戳）
 */
function normalizeCloudObject(obj) {
  if (!obj) {
    return null;
  }

  return {
    ...obj,
    version: obj.version || "1",
    updated_at: obj.updated_at || new Date().toISOString(),
    user_id: obj.user_id || ""
  };
}

/**
 * 标准化云函数响应
 */
function normalizeCloudResponse(result) {
  if (!result) {
    return {
      status: "error",
      message: "no response",
      data: null
    };
  }

  const { result: data, errMsg } = result;

  if (errMsg && errMsg.indexOf("success") < 0) {
    return {
      status: "error",
      message: errMsg,
      data: null
    };
  }

  return {
    status: "success",
    data: normalizeCloudObject(data),
    message: "ok"
  };
}

module.exports = {
  CLOUD_ENV_ID,
  CLOUD_COLLECTIONS,
  ensureCloud,
  getOpenId,
  getLoginIdentity,
  syncBuyerIntake,
  syncUserProfile,
  syncListingImportJob,
  syncListing,
  syncChatSession,
  syncChatMessage,
  uploadImportImage,
  getHomeHotListings,
  getHomeGuessListings,
  queryPropertyRecommend,
  callDecisionEngine,
  normalizeCloudObject,
  normalizeCloudResponse,
  // 阶段2：三个统一入口
  generateRequestId,
  buildUnifiedRequest,
  normalizeUnifiedResponse,
  retrievalSearch,
  llmGenerate,
  workflowDispatch
};
