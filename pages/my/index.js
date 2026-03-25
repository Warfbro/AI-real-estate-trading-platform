const { isLoggedIn, requireLogin } = require("../../utils/auth");
const { EVENTS, trackEvent } = require("../../utils/track");

const USER_ENTRY_ITEMS = [
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
    desc: "顾问/经纪人入驻入口"
  }
];

Page({
  data: {
    entries: USER_ENTRY_ITEMS
  },

  onShow() {
    if (typeof this.getTabBar === "function" && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }

    trackEvent(EVENTS.PAGE_MY_VIEW);

    if (!isLoggedIn()) {
      requireLogin("/pages/my/index");
    }
  },

  handleEntryTap(event) {
    const key = event.currentTarget.dataset.key;

    if (key === "favorites") {
      wx.navigateTo({
        url: "/pages/myFavorites/index"
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

