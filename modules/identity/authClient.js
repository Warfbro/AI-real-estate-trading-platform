const { STORAGE_KEYS, get, set } = require("../../utils/storage");
const { writeActivityLog } = require("../../utils/track");
const { getLoginIdentity } = require("../../utils/cloud");

const ROLES = ["user", "advisor", "admin"];
const FORCE_ADMIN_ROLE_IN_TEST = true;

function getSession() {
  return get(STORAGE_KEYS.AUTH_SESSION, null);
}

function normalizeRole(role) {
  if (FORCE_ADMIN_ROLE_IN_TEST) {
    return "admin";
  }
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

function loginWithWeChat(role = "user", options = {}) {
  const phoneCode = String(options.phoneCode || "").trim();
  const loginScene = String(options.loginScene || "wechat_login").trim() || "wechat_login";
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
        let phoneBound = false;
        let phoneSyncError = "";

        try {
          const identity = await getLoginIdentity({
            role: nextRole,
            provider: "wechat",
            phoneCode
          });
          openid = identity.openid;
          userId = identity.userId || identity.openid || res.code;
          cloudSynced = Boolean(identity.userSynced);
          cloudSyncError = identity.userSyncError || "";
          phoneBound = Boolean(identity.phoneBound);
          phoneSyncError = identity.phoneSyncError || "";
          if (!cloudSynced && cloudSyncError) {
            console.warn("[identity.authClient] users sync incomplete", identity);
          }
        } catch (err) {
          cloudSyncError = (err && (err.message || err.errMsg)) || "cloud sync failed";
          console.warn("[identity.authClient] cloud sync failed", err);
        }

        const session = {
          provider: "wechat",
          login_code: userId,
          user_id: userId,
          openid,
          role: nextRole,
          logged_in_at: new Date().toISOString(),
          login_scene: loginScene,
          cloud_synced: cloudSynced,
          cloud_sync_error: cloudSyncError,
          phone_bound: phoneBound,
          phone_sync_error: phoneSyncError
        };
        set(STORAGE_KEYS.AUTH_SESSION, session);

        writeActivityLog({
          action_type: "auth_login",
          object_type: "auth_session",
          detail_json: {
            provider: "wechat",
            role: session.role,
            login_scene: loginScene,
            cloud_synced: cloudSynced,
            cloud_sync_error: cloudSyncError,
            phone_bound: phoneBound
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
