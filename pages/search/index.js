const { isLoggedIn, requireLogin } = require("../../utils/auth");
const { EVENTS, trackEvent, writeActivityLog } = require("../../utils/track");
const { STORAGE_KEYS, get, set } = require("../../utils/storage");

const HISTORY_LIMIT = 12;

function normalizeKeyword(value) {
  return String(value || "").trim();
}

function normalizeHistory(list) {
  if (!Array.isArray(list)) {
    return [];
  }

  const unique = [];
  const seen = new Set();
  list.forEach((item) => {
    const keyword = normalizeKeyword(item);
    if (!keyword || seen.has(keyword)) {
      return;
    }
    seen.add(keyword);
    unique.push(keyword);
  });
  return unique.slice(0, HISTORY_LIMIT);
}

Page({
  data: {
    source: "home",
    search_input_value: "",
    history_list: [],
    has_history: false
  },

  onLoad(options) {
    this.setData({
      source: normalizeKeyword(options.source || "home")
    });
  },

  onShow() {
    if (!isLoggedIn()) {
      requireLogin("/pages/search/index");
      return;
    }
    this.loadHistory();
  },

  loadHistory() {
    const history = normalizeHistory(get(STORAGE_KEYS.SEARCH_HISTORY, []));
    this.setData({
      history_list: history,
      has_history: history.length > 0
    });
  },

  saveHistory(keyword) {
    const current = normalizeHistory(get(STORAGE_KEYS.SEARCH_HISTORY, []));
    const next = [keyword].concat(current.filter((item) => item !== keyword)).slice(0, HISTORY_LIMIT);
    set(STORAGE_KEYS.SEARCH_HISTORY, next);
    this.setData({
      history_list: next,
      has_history: next.length > 0
    });
  },

  goResultPage(keyword) {
    const query = [
      `source=search`,
      `keyword=${encodeURIComponent(keyword || "")}`
    ].join("&");

    wx.navigateTo({
      url: `/pages/searchResult/index?${query}`
    });
  },

  handleInput(e) {
    this.setData({
      search_input_value: e.detail.value || ""
    });
  },

  handleSubmitSearch() {
    const keyword = normalizeKeyword(this.data.search_input_value);

    if (!keyword) {
      wx.showToast({
        title: "请输入搜索关键词",
        icon: "none"
      });
      return;
    }

    if (keyword) {
      this.saveHistory(keyword);
    }

    trackEvent(EVENTS.SEARCH_ENTRY_CLICK, {
      source: "search_page_submit",
      from: this.data.source || "home"
    });
    writeActivityLog({
      action_type: "search_submit",
      object_type: "page_search",
      detail_json: {
        keyword,
        source: this.data.source || "home"
      }
    });

    this.goResultPage(keyword);
  },

  handleUseHistory(e) {
    const keyword = normalizeKeyword(e.currentTarget.dataset.keyword);
    if (!keyword) {
      return;
    }
    this.setData({
      search_input_value: keyword
    });
    this.handleSubmitSearch();
  },

  handleClearHistory() {
    set(STORAGE_KEYS.SEARCH_HISTORY, []);
    this.setData({
      history_list: [],
      has_history: false
    });
  },

  handleCancel() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack();
      return;
    }
    wx.switchTab({
      url: "/pages/home/index"
    });
  }
});
