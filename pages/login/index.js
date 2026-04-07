const { loginWithWeChat, getLoginRedirect } = require("../../modules/identity");
const { set, STORAGE_KEYS } = require("../../utils/storage");
const { writeActivityLog } = require("../../utils/track");

const DEFAULT_REDIRECT = "/pages/home/index";
const TAB_BAR_PATHS = {
  "/pages/home/index": true,
  "/pages/my/index": true
};
const FORCED_TEST_ROLE = "admin";

function stripQuery(url = "") {
  return String(url || "").split("?")[0] || DEFAULT_REDIRECT;
}

function decodeRedirect(redirect = "") {
  if (!redirect) {
    return DEFAULT_REDIRECT;
  }
  try {
    return decodeURIComponent(redirect);
  } catch (err) {
    return redirect;
  }
}

function getRedirectMethod(redirect = DEFAULT_REDIRECT) {
  return TAB_BAR_PATHS[stripQuery(redirect)] ? "switchTab" : "redirectTo";
}

function fallbackToHome() {
  wx.switchTab({
    url: DEFAULT_REDIRECT
  });
}

function navigateAfterLogin(redirect = DEFAULT_REDIRECT) {
  const safeRedirect = redirect || DEFAULT_REDIRECT;
  const cleanPath = stripQuery(safeRedirect);
  if (TAB_BAR_PATHS[cleanPath]) {
    wx.switchTab({
      url: cleanPath,
      fail: fallbackToHome
    });
    return;
  }

  wx.redirectTo({
    url: safeRedirect,
    fail() {
      if (TAB_BAR_PATHS[cleanPath]) {
        wx.switchTab({
          url: cleanPath,
          fail: fallbackToHome
        });
        return;
      }
      wx.reLaunch({
        url: DEFAULT_REDIRECT
      });
    }
  });
}

function resolveLoginErrorMessage(err) {
  const rawMessage = String((err && (err.errMsg || err.message)) || "").toLowerCase();
  if (rawMessage.indexOf("deny") > -1 || rawMessage.indexOf("cancel") > -1) {
    return "你已取消微信授权，请重新发起登录。";
  }
  if (rawMessage.indexOf("timeout") > -1) {
    return "登录校验超时，请检查网络后重试。";
  }
  return "登录失败，请稍后重试。";
}

Page({
  data: {
    loading: false,
    redirect: DEFAULT_REDIRECT,
    primary_login_text: "微信官方快速登录",
    status_text: "",
    error_text: ""
  },

  onLoad(options) {
    const redirect = decodeRedirect(
      (options && options.redirect) || getLoginRedirect(DEFAULT_REDIRECT)
    );
    this.setData({
      redirect
    });
  },

  async submitLogin({ phoneCode = "", loginScene = "wechat_login" } = {}) {
    if (this.data.loading) {
      return;
    }

    this.setData({
      loading: true,
      status_text: "正在校验微信身份并同步你的选房数据...",
      error_text: ""
    });

    try {
      const session = await loginWithWeChat(FORCED_TEST_ROLE, {
        phoneCode,
        loginScene
      });
      const redirect = this.data.redirect || getLoginRedirect(DEFAULT_REDIRECT);
      const redirectMethod = getRedirectMethod(redirect);
      set(STORAGE_KEYS.LAST_ROUTE, "");

      writeActivityLog({
        action_type: "auth_login_redirect",
        object_type: "page_login",
        detail_json: {
          redirect,
          role: FORCED_TEST_ROLE,
          redirect_method: redirectMethod,
          login_scene: loginScene
        }
      });

      this.setData({
        status_text:
          loginScene === "phone_quick_login" && session && session.phone_bound
            ? "快速登录成功，手机号已同步，正在返回上一步流程..."
            : "登录成功，正在返回上一步流程..."
      });

      wx.showToast({
        title: "登录成功",
        icon: "success"
      });

      setTimeout(() => {
        navigateAfterLogin(redirect);
      }, 250);
    } catch (err) {
      const errorText = resolveLoginErrorMessage(err);
      this.setData({
        status_text: "",
        error_text: errorText
      });
      wx.showToast({
        title: errorText,
        icon: "none"
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  handleQuickLogin(event) {
    if (this.data.loading) {
      return;
    }
    const detail = (event && event.detail) || {};
    const errMsg = String(detail.errMsg || "");
    if (errMsg && errMsg.indexOf(":ok") < 0) {
      const errorText = resolveLoginErrorMessage({
        errMsg
      });
      this.setData({
        error_text: errorText
      });
      wx.showToast({
        title: errorText,
        icon: "none"
      });
      return;
    }

    return this.submitLogin({
      phoneCode: String(detail.code || "").trim(),
      loginScene: "phone_quick_login"
    });
  }
});
