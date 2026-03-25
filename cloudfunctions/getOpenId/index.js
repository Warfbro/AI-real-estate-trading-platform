const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const USERS_COLLECTION = "users";
const ROLES = ["user", "advisor", "admin"];

function normalizeRole(role) {
  return ROLES.includes(role) ? role : "user";
}

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

async function getExistingUser(openid) {
  if (!openid) {
    return null;
  }
  try {
    const result = await db.collection(USERS_COLLECTION).doc(openid).get();
    return (result && result.data) || null;
  } catch (err) {
    return null;
  }
}

async function syncUserRecord({ openid, unionid, role, provider }) {
  if (!openid) {
    throw new Error("missing openid");
  }

  const existing = await getExistingUser(openid);
  const now = new Date().toISOString();
  const payload = {
    user_id: openid,
    openid,
    unionid: unionid || (existing && existing.unionid) || "",
    mobile: (existing && existing.mobile) || "",
    email: (existing && existing.email) || "",
    role: normalizeRole(role || (existing && existing.role) || "user"),
    provider: normalizeText(provider || (existing && existing.provider), "wechat"),
    created_at: (existing && existing.created_at) || now,
    last_login_at: now
  };

  await db.collection(USERS_COLLECTION).doc(openid).set({
    data: payload
  });

  return payload;
}

exports.main = async (event = {}) => {
  const context = cloud.getWXContext();
  const openid = normalizeText(context.OPENID);
  const unionid = normalizeText(context.UNIONID);
  const appid = normalizeText(context.APPID);
  const shouldSyncUser = Boolean(event && event.sync_user);
  let userSynced = false;
  let userSyncError = "";

  if (shouldSyncUser) {
    try {
      await syncUserRecord({
        openid,
        unionid,
        role: event.role,
        provider: event.provider
      });
      userSynced = true;
    } catch (err) {
      userSyncError = normalizeText(err && (err.message || err.errMsg), "users sync failed");
    }
  }

  return {
    openid,
    appid,
    unionid,
    user_id: openid,
    user_synced: userSynced,
    user_sync_error: userSyncError
  };
};
