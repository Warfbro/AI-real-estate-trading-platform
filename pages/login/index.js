const { loginWithWeChat, getLoginRedirect } = require("../../utils/auth");
const { set, STORAGE_KEYS } = require("../../utils/storage");
const { writeActivityLog } = require("../../utils/track");

Page({
  data: {
    loading: false,
    redirect: "/pages/home/index",
    role_index: 0,
    role_value: "user",
    role_label: "买房用户",
    role_labels: ["买房用户", "顾问", "管理员"],
    role_values: ["user", "advisor", "admin"]
  },

  onLoad(options) {
    if (options.redirect) {
      this.setData({
        redirect: decodeURIComponent(options.redirect)
      });
    }
  },

  handleRoleChange(e) {
    const index = Number(e.detail.value || 0);
    const roleValues = this.data.role_values || [];
    const roleLabels = this.data.role_labels || [];
    this.setData({
      role_index: index,
      role_value: roleValues[index] || "user",
      role_label: roleLabels[index] || "买房用户"
    });
  },

  async handleLogin() {
    if (this.data.loading) {
      return;
    }

    this.setData({ loading: true });
    try {
      await loginWithWeChat(this.data.role_value);
      const redirect = this.data.redirect || getLoginRedirect("/pages/home/index");
      set(STORAGE_KEYS.LAST_ROUTE, "");

      writeActivityLog({
        action_type: "auth_login_redirect",
        object_type: "page_login",
        detail_json: {
          redirect,
          role: this.data.role_value
        }
      });

      wx.showToast({
        title: "登录成功",
        icon: "success"
      });

      setTimeout(() => {
        wx.redirectTo({
          url: redirect
        });
      }, 250);
    } catch (err) {
      wx.showToast({
        title: "登录失败，请重试",
        icon: "none"
      });
    } finally {
      this.setData({ loading: false });
    }
  }
});
