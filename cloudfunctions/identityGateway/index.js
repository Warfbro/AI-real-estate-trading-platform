"use strict";

const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

const COLLECTIONS = {
  USERS: "users",
  ACTIVITY_LOGS: "activity_logs"
};

const ROLES = ["user", "advisor", "admin"];

function normalizeText(value, fallback = "") {
  const text = String(value == null ? "" : value).trim();
  return text || fallback;
}

function normalizeRole(role) {
  return ROLES.includes(role) ? role : "user";
}

function randomId() {
  return Math.random().toString(36).slice(2, 8);
}

function createTraceId(prefix) {
  return `${prefix}_${Date.now()}_${randomId()}`;
}

async function resolvePhoneInfo(phoneCode) {
  const code = normalizeText(phoneCode);
  if (!code) {
    return {
      mobile: "",
      phoneBound: false,
      phoneSyncError: ""
    };
  }

  try {
    const response = await cloud.openapi.phonenumber.getPhoneNumber({
      code
    });
    const phoneInfo =
      (response && (response.phone_info || response.phoneInfo)) ||
      {};
    const mobile = normalizeText(
      phoneInfo.phoneNumber || phoneInfo.purePhoneNumber
    );

    if (!mobile) {
      return {
        mobile: "",
        phoneBound: false,
        phoneSyncError: "phone number empty"
      };
    }

    return {
      mobile,
      phoneBound: true,
      phoneSyncError: ""
    };
  } catch (err) {
    return {
      mobile: "",
      phoneBound: false,
      phoneSyncError: normalizeText(
        err && (err.message || err.errMsg),
        "phone decode failed"
      )
    };
  }
}

async function getExistingUser(openid) {
  if (!openid) {
    return null;
  }

  try {
    const result = await db.collection(COLLECTIONS.USERS).doc(openid).get();
    return (result && result.data) || null;
  } catch (err) {
    return null;
  }
}

async function syncUserRecord({ openid, unionid, role, provider, mobile }) {
  if (!openid) {
    throw new Error("missing openid");
  }

  const existing = await getExistingUser(openid);
  const now = new Date().toISOString();
  const payload = {
    user_id: openid,
    uid: openid,
    openid,
    unionid: unionid || (existing && existing.unionid) || "",
    mobile: normalizeText(mobile || (existing && existing.mobile) || ""),
    email: (existing && existing.email) || "",
    role: normalizeRole(role || (existing && existing.role) || "user"),
    provider: normalizeText(provider || (existing && existing.provider), "wechat"),
    created_at: (existing && existing.created_at) || now,
    updated_at: now,
    last_login_at: now
  };

  await db.collection(COLLECTIONS.USERS).doc(openid).set({
    data: payload
  });

  return payload;
}

async function writeActivityLog({
  traceId,
  actionType,
  userId,
  detailJson = {}
}) {
  try {
    await db.collection(COLLECTIONS.ACTIVITY_LOGS).add({
      data: {
        log_id: `log_${Date.now()}_${randomId()}`,
        actor_type: userId ? "user" : "system",
        actor_id: normalizeText(userId),
        action_type: actionType,
        object_type: "identity_gateway",
        object_id: traceId,
        detail_json: detailJson,
        created_at: new Date().toISOString()
      }
    });
  } catch (err) {
    // Best-effort logging only.
  }
}

function buildIdentityResult(context, extra = {}) {
  const openid = normalizeText(context && context.OPENID);
  const unionid = normalizeText(context && context.UNIONID);
  const appid = normalizeText(context && context.APPID);

  return {
    ok: true,
    openid,
    unionid,
    appid,
    user_id: openid,
    uid: openid,
    ...extra
  };
}

exports.main = async (event = {}) => {
  const traceId = createTraceId("identity");
  const action = normalizeText(
    event.action,
    event.sync_user ? "login_init" : "get_current_identity"
  ).toLowerCase();
  const context = cloud.getWXContext();

  try {
    if (action === "get_current_identity" || action === "get_current_uid") {
      return buildIdentityResult(context, {
        trace_id: traceId,
        action
      });
    }

    if (action === "login_init") {
      const phoneResult = await resolvePhoneInfo(event.phone_code);
      let userSynced = false;
      let userSyncError = "";

      try {
        await syncUserRecord({
          openid: normalizeText(context.OPENID),
          unionid: normalizeText(context.UNIONID),
          role: event.role,
          provider: event.provider,
          mobile: phoneResult.mobile
        });
        userSynced = true;
      } catch (err) {
        userSyncError = normalizeText(
          err && (err.message || err.errMsg),
          "users sync failed"
        );
      }

      const result = buildIdentityResult(context, {
        trace_id: traceId,
        action,
        user_synced: userSynced,
        user_sync_error: userSyncError,
        phone_bound: phoneResult.phoneBound,
        phone_sync_error: phoneResult.phoneSyncError
      });

      await writeActivityLog({
        traceId,
        actionType: "identity_login_init",
        userId: result.user_id,
        detailJson: {
          provider: normalizeText(event.provider, "wechat"),
          role: normalizeRole(event.role),
          user_synced: userSynced,
          phone_bound: phoneResult.phoneBound,
          user_sync_error: userSyncError
        }
      });

      return result;
    }

    return {
      ok: false,
      trace_id: traceId,
      code: "UNSUPPORTED_ACTION",
      message: `unsupported action: ${action || "(empty)"}`
    };
  } catch (err) {
    console.error("[identityGateway] execution failed", {
      trace_id: traceId,
      action,
      message: normalizeText(err && (err.message || err.errMsg)),
      stack: normalizeText(err && err.stack)
    });

    return {
      ok: false,
      trace_id: traceId,
      code: "IDENTITY_GATEWAY_FAILED",
      message: "identity gateway execution failed",
      details: normalizeText(err && (err.message || err.errMsg))
    };
  }
};
