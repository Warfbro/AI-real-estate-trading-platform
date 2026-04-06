const { isLoggedIn, requireLogin, getUserRole } = require("../../utils/auth");
const { EVENTS, trackEvent } = require("../../utils/track");

const BUYER_ENTRY_ITEMS = [
  {
    key: "favorites",
    title: "我的收藏",
    desc: "查看与编辑收藏房源"
  },
  {
    key: "appointments",
    title: "我的预约",
    desc: "查看预约进展"
  },
  {
    key: "join",
    title: "入驻平台",
    desc: "申请中介身份并开始上传房源"
  }
];

const AGENT_ENTRY_ITEMS = [
  {
    key: "favorites",
    title: "我的收藏",
    desc: "查看与编辑收藏房源"
  },
  {
    key: "appointments",
    title: "我的预约",
    desc: "查看预约进展"
  },
  {
    key: "upload",
    title: "上传房源",
    desc: "上传链接、文本或截图房源"
  }
];

function buildEntriesByRole(role) {
  return role === "advisor" ? AGENT_ENTRY_ITEMS : BUYER_ENTRY_ITEMS;
}

Page({
  data: {
    entries: BUYER_ENTRY_ITEMS
  },

  onShow() {
    if (typeof this.getTabBar === "function" && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }

    trackEvent(EVENTS.PAGE_MY_VIEW);

    if (!isLoggedIn()) {
      requireLogin("/pages/my/index");
      return;
    }

    this.setData({
      entries: buildEntriesByRole(getUserRole())
    });
  },

  handleEntryTap(event) {
    const key = event.currentTarget.dataset.key;

    if (key === "favorites") {
      wx.navigateTo({
        url: "/pages/myFavorites/index"
      });
      return;
    }

    if (key === "upload") {
      wx.navigateTo({
        url: "/pages/import/index?source=broker"
      });
      return;
    }

    const hintMap = {
      appointments: "预约功能建设中",
      join: "入驻功能建设中"
    };
    wx.showToast({
      title: hintMap[key] || "功能建设中",
      icon: "none"
    });
  }
});
