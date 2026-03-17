const { isLoggedIn, requireLogin, getSession } = require("../../utils/auth");
const { EVENTS, trackEvent, writeActivityLog } = require("../../utils/track");
const { STORAGE_KEYS, get, set } = require("../../utils/storage");

function byUpdatedDesc(a, b) {
  const aTime = a.updated_at || a.created_at || "";
  const bTime = b.updated_at || b.created_at || "";
  return aTime > bTime ? -1 : 1;
}

Page({
  data: {
    listing_id: "",
    source: "search",
    listing: null,
    has_listing: false,
    intake: null,
    compare_ids: [],
    selected_for_compare: false,
    compare_button_text: "加入已选",
    selected_count_text: "0",
    display_title: "待完善房源",
    display_price: "待补充",
    display_area: "待补充",
    display_city: "未知",
    display_community: "待补充",
    display_layout: "待补充",
    raw_text_display: "-",
    normalized_text: "",
    missing_text: "",
    match_tips: []
  },

  onLoad(options) {
    this.setData({
      listing_id: options.listing_id || "",
      source: options.source || "search"
    });
  },

  onShow() {
    const listingId = this.data.listing_id;
    if (!listingId) {
      wx.showToast({
        title: "缺少房源 ID",
        icon: "none"
      });
      return;
    }

    if (!isLoggedIn()) {
      requireLogin(`/pages/detail/index?listing_id=${listingId}`);
      return;
    }

    set(STORAGE_KEYS.RECENT_CONTINUE_ROUTE, `/pages/detail/index?listing_id=${listingId}&source=${encodeURIComponent(this.data.source || "search")}`);
    trackEvent(EVENTS.PAGE_DETAIL_VIEW, { listing_id: listingId, source: this.data.source || "search" });
    writeActivityLog({
      action_type: "detail_view",
      object_type: "listing",
      object_id: listingId,
      detail_json: {
        source: this.data.source || "search"
      }
    });
    this.loadData();
  },

  loadData() {
    const session = getSession();
    const listings = get(STORAGE_KEYS.LISTINGS, []).filter(
      (item) => item.user_id === session.login_code
    );
    const listing = listings.find((item) => item.listing_id === this.data.listing_id) || null;

    if (!listing) {
      this.setData({
        listing: null,
        has_listing: false
      });
      return;
    }

    const intakes = get(STORAGE_KEYS.BUYER_INTAKES, [])
      .filter((item) => item.user_id === session.login_code && item.status === "submitted")
      .sort(byUpdatedDesc);
    const intake = intakes.length ? intakes[0] : null;

    const compareIds = get(STORAGE_KEYS.COMPARE_LISTING_IDS, []);
    const tips = this.getMatchTips(listing, intake);

    this.setData({
      listing,
      has_listing: true,
      intake,
      compare_ids: compareIds,
      selected_for_compare: compareIds.includes(listing.listing_id),
      compare_button_text: compareIds.includes(listing.listing_id) ? "移出已选" : "加入已选",
      selected_count_text: String(compareIds.length),
      display_title: listing.title || "待完善房源",
      display_price:
        listing.price_total === null || listing.price_total === undefined
          ? "待补充"
          : `${listing.price_total}万`,
      display_area:
        listing.area_sqm === null || listing.area_sqm === undefined
          ? "待补充"
          : `${listing.area_sqm}㎡`,
      display_city: listing.city || "未知",
      display_community: listing.community_name || "待补充",
      display_layout: listing.layout_desc || "待补充",
      raw_text_display: listing.raw_text || "-",
      normalized_text: JSON.stringify(listing.normalized_json || {}, null, 2),
      missing_text: (listing.missing_fields_json || []).join("、") || "无",
      match_tips: tips
    });
  },

  getMatchTips(listing, intake) {
    const tips = [];

    if (!intake) {
      tips.push("当前为独立搜索模式，可先勾选房源，再交给 AI 继续分析。");
      const missing = listing.missing_fields_json || [];
      if (missing.length) {
        tips.push(`当前仍缺少字段：${missing.join("、")}`);
      }
      return tips;
    }

    if (intake.city && listing.city && intake.city === listing.city) {
      tips.push("城市与当前 AI 需求匹配。");
    }

    if (
      intake.budget_max !== null &&
      intake.budget_max !== undefined &&
      listing.price_total !== null &&
      listing.price_total !== undefined &&
      listing.price_total <= intake.budget_max
    ) {
      tips.push("总价在预算上限内。");
    }

    const missing = listing.missing_fields_json || [];
    if (missing.length) {
      tips.push(`当前仍缺少字段：${missing.join("、")}`);
    }

    if (!tips.length) {
      tips.push("当前信息不足以直接判断匹配度，建议补充后再交给 AI 分析。");
    }
    return tips;
  },

  handleToggleCompare() {
    const listing = this.data.listing;
    if (!listing) {
      return;
    }
    const ids = [...this.data.compare_ids];
    const idx = ids.indexOf(listing.listing_id);

    if (idx >= 0) {
      ids.splice(idx, 1);
    } else {
      if (ids.length >= 5) {
        wx.showToast({
          title: "最多只能勾选 5 套房源",
          icon: "none"
        });
        return;
      }
      ids.push(listing.listing_id);
      trackEvent(EVENTS.ADD_TO_COMPARE, {
        listing_id: listing.listing_id,
        selected_count: ids.length
      });
      writeActivityLog({
        action_type: "add_to_compare",
        object_type: "listing",
        object_id: listing.listing_id,
        detail_json: { selected_count: ids.length }
      });
    }

    set(STORAGE_KEYS.COMPARE_LISTING_IDS, ids);
    this.setData({
      compare_ids: ids,
      selected_for_compare: ids.includes(listing.listing_id),
      compare_button_text: ids.includes(listing.listing_id) ? "移出已选" : "加入已选",
      selected_count_text: String(ids.length)
    });
  },

  handleBackCandidates() {
    wx.navigateTo({
      url: "/pages/candidates/index?source=search"
    });
  },

  handleGoAI() {
    const listing = this.data.listing;
    trackEvent(EVENTS.SEARCH_HANDOFF_AI_CLICK, {
      listing_id: listing ? listing.listing_id : "",
      selected_count: (this.data.compare_ids || []).length,
      source: "detail"
    });
    writeActivityLog({
      action_type: "search_handoff_ai_click",
      object_type: "page_detail",
      object_id: listing ? listing.listing_id : "",
      detail_json: {
        selected_count: (this.data.compare_ids || []).length,
        source: this.data.source || "search"
      }
    });
    wx.navigateTo({
      url: "/pages/ai/index?source=search"
    });
  }
});
