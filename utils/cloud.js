const CLOUD_ENV_ID = "cloud1-8giu626m8dfdd890";
const CLOUD_UPLOAD_ROOT = "listing-imports";

const CLOUD_COLLECTIONS = {
  USERS: "users",
  USER_PROFILES: "user_profiles",
  BUYER_INTAKES: "buyer_intakes",
  LISTING_IMPORT_JOBS: "listing_import_jobs",
  LISTINGS: "listings",
  FAVORITES: "favorites",
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

function ensureGatewaySuccess(result, fallbackMessage) {
  const safe = result && typeof result === "object" ? result : {};
  if (safe.ok !== false && !safe.error) {
    return safe;
  }

  const message = String(
    safe.message ||
      safe.details ||
      (safe.error && (safe.error.message || safe.error.details)) ||
      fallbackMessage ||
      "cloud function failed"
  ).trim();

  throw new Error(message || "cloud function failed");
}

function callIdentityAction(action, data = {}) {
  return callFunction("identityGateway", {
    action,
    ...data
  });
}

function callUserStateAction(action, data = {}) {
  return callFunction("userStateGateway", {
    action,
    ...data
  });
}

function callListingDataAction(action, data = {}) {
  return callFunction("listingDataGateway", {
    action,
    ...data
  });
}

function callListingSearchAction(action, data = {}) {
  return callFunction("listingSearchGateway", {
    action,
    ...data
  });
}

function callAiAssistantAction(action, data = {}) {
  return callFunction("aiAssistantGateway", {
    action,
    ...data
  });
}

async function getCurrentIdentity() {
  const result = ensureGatewaySuccess(
    await callIdentityAction("get_current_identity"),
    "identity gateway get_current_identity failed"
  );

  const openid = String(result.openid || result.user_id || result.uid || "").trim();
  return {
    openid,
    unionid: String(result.unionid || "").trim(),
    appid: String(result.appid || "").trim(),
    userId: String(result.user_id || result.uid || openid).trim(),
    uid: String(result.uid || result.user_id || openid).trim()
  };
}

async function loginInit({ role, provider = "wechat", phoneCode = "" } = {}) {
  const result = ensureGatewaySuccess(
    await callIdentityAction("login_init", {
      sync_user: true,
      role,
      provider,
      phone_code: String(phoneCode || "").trim()
    }),
    "identity gateway login_init failed"
  );

  const openid = String(result.openid || result.user_id || result.uid || "").trim();
  const userSynced = Object.prototype.hasOwnProperty.call(result, "user_synced")
    ? Boolean(result.user_synced)
    : false;
  const userSyncError = String(result.user_sync_error || "").trim();
  const phoneBound = Object.prototype.hasOwnProperty.call(result, "phone_bound")
    ? Boolean(result.phone_bound)
    : false;
  const phoneSyncError = String(result.phone_sync_error || "").trim();

  return {
    openid,
    unionid: String(result.unionid || "").trim(),
    appid: String(result.appid || "").trim(),
    userId: String(result.user_id || result.uid || openid).trim(),
    uid: String(result.uid || result.user_id || openid).trim(),
    userSynced,
    userSyncError,
    phoneBound,
    phoneSyncError
  };
}

async function syncBuyerIntake(intake) {
  const result = ensureGatewaySuccess(
    await callUserStateAction("sync_buyer_intake", {
      intake
    }),
    "user state gateway sync_buyer_intake failed"
  );
  return (result && result.data) || intake;
}

async function syncUserProfile(profile) {
  const result = ensureGatewaySuccess(
    await callUserStateAction("sync_user_profile", {
      profile
    }),
    "user state gateway sync_user_profile failed"
  );
  return (result && result.data) || profile;
}

async function syncListingImportJob(job) {
  const result = ensureGatewaySuccess(
    await callListingDataAction("sync_listing_import_job", {
      job
    }),
    "listing data gateway sync_listing_import_job failed"
  );
  return (result && result.data) || job;
}

async function syncListing(listing) {
  const result = ensureGatewaySuccess(
    await callListingDataAction("sync_listing", {
      listing
    }),
    "listing data gateway sync_listing failed"
  );
  return (result && result.data) || listing;
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

async function queryHomeHot({ limit = 8, city = "", userId = "" } = {}) {
  return ensureGatewaySuccess(
    await callListingSearchAction("query_home_hot", {
      limit,
      city,
      user_id: userId
    }),
    "listing search gateway query_home_hot failed"
  );
}

async function queryHomeGuess({ page = 1, pageSize = 10, city = "", userId = "" } = {}) {
  return ensureGatewaySuccess(
    await callListingSearchAction("query_home_guess", {
      page,
      page_size: pageSize,
      city,
      user_id: userId
    }),
    "listing search gateway query_home_guess failed"
  );
}

async function ensureConversation({
  userId = "",
  sessionId = "",
  source = "wechat",
  title = "",
  summary = "",
  preview = ""
} = {}) {
  return ensureGatewaySuccess(
    await callAiAssistantAction("ensure_conversation", {
      user_id: String(userId || "").trim(),
      session_id: String(sessionId || "").trim(),
      source: String(source || "wechat").trim(),
      title: String(title || "").trim(),
      summary: String(summary || "").trim(),
      preview: String(preview || "").trim()
    }),
    "ai assistant gateway ensure_conversation failed"
  );
}

function sendMessage({
  query,
  userId = "",
  sessionId = "",
  source = "wechat",
  context = {}
} = {}) {
  return callAiAssistantAction("send_message", {
    query: String(query || "").trim(),
    user_id: String(userId || "").trim(),
    session_id: String(sessionId || "").trim(),
    source: String(source || "wechat").trim(),
    context: context && typeof context === "object" && !Array.isArray(context) ? context : {}
  });
}

function dispatchDecision({
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
  return callAiAssistantAction("decision_dispatch", {
    decision_action: String(action || "").trim(),
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

const identityGateway = {
  getCurrentIdentity,
  loginInit
};

const userStateGateway = {
  syncBuyerIntake,
  syncUserProfile
};

const listingDataGateway = {
  syncListingImportJob,
  syncListing
};

const listingSearchGateway = {
  queryHomeHot,
  queryHomeGuess
};

const aiAssistantGateway = {
  ensureConversation,
  sendMessage,
  dispatchDecision
};

module.exports = {
  CLOUD_ENV_ID,
  CLOUD_COLLECTIONS,
  ensureCloud,
  uploadImportImage,
  identityGateway,
  userStateGateway,
  listingDataGateway,
  listingSearchGateway,
  aiAssistantGateway
};
