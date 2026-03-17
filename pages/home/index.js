const { isLoggedIn, getSession, getUserRole } = require("../../utils/auth");
const { EVENTS, trackEvent, writeActivityLog } = require("../../utils/track");
const { STORAGE_KEYS, get } = require("../../utils/storage");
const {
  DEFAULT_CONTINUE_ROUTE,
  resolveContinueContextFromStorage
} = require("../../utils/continue");
const { getHomeHotListings, getHomeGuessListings } = require("../../utils/cloud");

function byUpdatedDesc(a, b) {
  const aTime = a.updated_at || a.created_at || "";
  const bTime = b.updated_at || b.created_at || "";
  return aTime > bTime ? -1 : 1;
}

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeListingCard(item) {
  const area = toNumberOrNull(item.area != null ? item.area : item.area_sqm);
  const price = toNumberOrNull(item.price_total);
  const city = normalizeText(item.city);
  const district = normalizeText(item.district);
  const community = normalizeText(item.community || item.community_name);
  const coverImageUrl = normalizeText(
    item.cover_image_url || item.image_url || item.raw_file_url
  );
  const title = normalizeText(item.title, `${district || city || "房源"} ${community || ""}`.trim());
  const areaText = area == null ? "面积待补充" : `${area}平米`;
  const priceText = price == null ? "价格待补充" : `${price}万`;
  const districtText = district || city || "区域待补充";

  return {
    listing_id: normalizeText(item.listing_id),
    cover_image_url: coverImageUrl,
    title_text: title,
    hot_desc_text: `${priceText} | ${areaText}`,
    guess_desc_text: `${areaText} | ${districtText}`
  };
}

Page({
  data: {
    loggedIn: false,
    recent_continue_route: DEFAULT_CONTINUE_ROUTE,
    recent_continue_label: "需求录入页",
    continue_hint_text: "已定位到最近可继续节点。",
    hot_listings: [],
    guess_listings: [],
    has_hot_listings: false,
    has_guess_listings: false,
    guess_strategy_text: ""
  },

  onShow() {
    if (typeof this.getTabBar === "function" && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }
    const loggedIn = isLoggedIn();
    if (!loggedIn) {
      this.setData({
        loggedIn: false,
        recent_continue_route: DEFAULT_CONTINUE_ROUTE,
        recent_continue_label: "需求录入页",
        continue_hint_text: "登录后将自动恢复最近进度。"
      });
    } else {
      const session = getSession();
      const role = getUserRole();
      const continueContext = resolveContinueContextFromStorage({
        userId: session ? session.login_code : "",
        role
      });
      this.setData({
        loggedIn: true,
        recent_continue_route: continueContext.route,
        recent_continue_label: continueContext.label,
        continue_hint_text: continueContext.hintText
      });
    }
    trackEvent(EVENTS.PAGE_HOME_VIEW);
    this.loadHomeFeeds();
  },

  getPreferredCity(userId) {
    const intakes = get(STORAGE_KEYS.BUYER_INTAKES, [])
      .filter((item) => item && item.user_id === userId && item.status === "submitted")
      .sort(byUpdatedDesc);
    return intakes.length ? normalizeText(intakes[0].city) : "";
  },

  getLocalListings(userId) {
    const all = get(STORAGE_KEYS.LISTINGS, []).filter((item) => {
      if (!item || item.status !== "active") return false;
      if (!userId) return true;
      return item.user_id === userId;
    });
    return all.sort(byUpdatedDesc).map(normalizeListingCard);
  },

  normalizeList(items) {
    return (items || [])
      .filter((item) => item && item.status !== "deleted")
      .map(normalizeListingCard)
      .filter((item) => Boolean(item.listing_id));
  },

  formatStrategy(strategy) {
    if (strategy === "personalized") return "猜你喜欢：按你的需求匹配";
    if (strategy === "city_fallback") return "猜你喜欢：同城优先推荐";
    if (strategy === "global_fallback") return "猜你喜欢：全局兜底推荐";
    return "";
  },

  async loadHomeFeeds() {
    const session = getSession();
    const userId = session ? normalizeText(session.login_code) : "";
    const city = this.getPreferredCity(userId);

    try {
      const [hotRes, guessRes] = await Promise.all([
        getHomeHotListings({
          limit: 8,
          city,
          userId
        }),
        getHomeGuessListings({
          page: 1,
          pageSize: 10,
          city,
          userId
        })
      ]);

      const hotList = this.normalizeList(hotRes.list).slice(0, 8);
      const guessList = this.normalizeList(guessRes.list).slice(0, 10);

      this.setData({
        hot_listings: hotList,
        guess_listings: guessList,
        has_hot_listings: hotList.length > 0,
        has_guess_listings: guessList.length > 0,
        guess_strategy_text: this.formatStrategy(guessRes.strategy)
      });
    } catch (err) {
      const hotList = this.getLocalListings("").slice(0, 8);
      const guessList = this.getLocalListings(userId).slice(0, 10);
      this.setData({
        hot_listings: hotList,
        guess_listings: guessList,
        has_hot_listings: hotList.length > 0,
        has_guess_listings: guessList.length > 0,
        guess_strategy_text: guessList.length ? "猜你喜欢：本地兜底数据" : ""
      });

      writeActivityLog({
        actor_type: "system",
        actor_id: userId,
        action_type: "home_feed_fallback_local",
        object_type: "page_home",
        detail_json: {
          error_message: normalizeText(err && (err.message || err.errMsg)),
          hot_count: hotList.length,
          guess_count: guessList.length
        }
      });
    }
  },

  handleAIBanner() {
    trackEvent(EVENTS.AI_ENTRY_CLICK, { source: "home_banner" });
    writeActivityLog({
      action_type: "home_ai_banner_click",
      object_type: "page_home",
      detail_json: { target_route: "/pages/ai/index" }
    });
    wx.navigateTo({ url: "/pages/ai/index" });
  },

  handleSearch() {
    trackEvent(EVENTS.SEARCH_ENTRY_CLICK, { source: "home_search" });
    wx.navigateTo({ url: "/pages/candidates/index" });
  },

  handleOpenListing(e) {
    const listingId = normalizeText(e.currentTarget.dataset.listingId);
    if (!listingId) {
      wx.showToast({
        title: "房源信息缺失",
        icon: "none"
      });
      return;
    }
    wx.navigateTo({
      url: `/pages/detail/index?listing_id=${listingId}&source=home`
    });
  },

  handleContinue() {
    const recentRoute =
      this.data.recent_continue_route ||
      get(STORAGE_KEYS.RECENT_CONTINUE_ROUTE, DEFAULT_CONTINUE_ROUTE);
    wx.navigateTo({
      url: recentRoute,
      fail: () => {
        wx.showToast({
          title: "继续路由不可用，已回到需求录入",
          icon: "none"
        });
        wx.navigateTo({ url: DEFAULT_CONTINUE_ROUTE });
      }
    });
  }
});
