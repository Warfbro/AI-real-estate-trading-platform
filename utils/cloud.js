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

async function getLoginIdentity({ role, provider = "wechat" }) {
  const result = await callFunction("getOpenId", {
    sync_user: true,
    role,
    provider
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

  return {
    openid,
    unionid: String(result.unionid || "").trim(),
    appid: String(result.appid || "").trim(),
    userId: String(result.user_id || openid).trim(),
    userSynced,
    userSyncError
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
  normalizeCloudResponse
};
