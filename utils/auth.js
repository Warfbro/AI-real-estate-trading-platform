const { STORAGE_KEYS, get, set } = require("./storage");
const { writeActivityLog } = require("./track");
const { getLoginIdentity } = require("./cloud");

const ROLES = ["user", "advisor", "admin"];

function getSession() {
  return get(STORAGE_KEYS.AUTH_SESSION, null);
}

function normalizeRole(role) {
  return ROLES.includes(role) ? role : "user";
}

function isLoggedIn() {
  const session = getSession();
  return Boolean(session && session.login_code);
}

function requireLogin(redirectPath) {
  if (isLoggedIn()) {
    return true;
  }
  set(STORAGE_KEYS.LAST_ROUTE, redirectPath);
  wx.navigateTo({
    url: `/pages/login/index?redirect=${encodeURIComponent(redirectPath)}`
  });
  return false;
}

function loginWithWeChat(role = "user") {
  return new Promise((resolve, reject) => {
    wx.login({
      async success(res) {
        if (!res.code) {
          reject(new Error("wx.login 未返回 code"));
          return;
        }

        const nextRole = normalizeRole(role);
        let userId = res.code;
        let openid = "";
        let cloudSynced = false;
        let cloudSyncError = "";

        try {
          const identity = await getLoginIdentity({
            role: nextRole,
            provider: "wechat"
          });
          openid = identity.openid;
          userId = identity.userId || identity.openid || res.code;
          cloudSynced = Boolean(identity.userSynced);
          cloudSyncError = identity.userSyncError || "";
          if (!cloudSynced && cloudSyncError) {
            console.warn("[auth] users sync incomplete", identity);
          }
        } catch (err) {
          cloudSyncError = (err && (err.message || err.errMsg)) || "cloud sync failed";
          console.warn("[auth] cloud sync failed", err);
        }

        const session = {
          provider: "wechat",
          login_code: userId,
          user_id: userId,
          openid,
          role: nextRole,
          logged_in_at: new Date().toISOString(),
          cloud_synced: cloudSynced,
          cloud_sync_error: cloudSyncError
        };
        set(STORAGE_KEYS.AUTH_SESSION, session);

        writeActivityLog({
          action_type: "auth_login",
          object_type: "auth_session",
          detail_json: {
            provider: "wechat",
            role: session.role,
            cloud_synced: cloudSynced,
            cloud_sync_error: cloudSyncError
          }
        });

        resolve(session);
      },
      fail(err) {
        reject(err);
      }
    });
  });
}

function getLoginRedirect(defaultPath = "/pages/home/index") {
  return get(STORAGE_KEYS.LAST_ROUTE, defaultPath);
}

function getUserRole() {
  const session = getSession();
  return normalizeRole(session && session.role);
}

function hasRole(allowedRoles = []) {
  return allowedRoles.includes(getUserRole());
}

function requireRole(allowedRoles = [], redirectPath = "/pages/home/index") {
  if (!isLoggedIn()) {
    return requireLogin(redirectPath);
  }
  if (!hasRole(allowedRoles)) {
    wx.showToast({
      title: "当前账号无后台权限",
      icon: "none"
    });
    return false;
  }
  return true;
}

module.exports = {
  getSession,
  isLoggedIn,
  requireLogin,
  loginWithWeChat,
  getLoginRedirect,
  getUserRole,
  hasRole,
  requireRole
};
