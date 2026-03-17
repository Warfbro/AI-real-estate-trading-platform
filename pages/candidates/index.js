const { isLoggedIn, requireLogin, getSession } = require("../../utils/auth");
const { EVENTS, trackEvent, writeActivityLog } = require("../../utils/track");
const { STORAGE_KEYS, get, set } = require("../../utils/storage");

function byUpdatedDesc(a, b) {
  const aTime = a.updated_at || a.created_at || "";
  const bTime = b.updated_at || b.created_at || "";
  return aTime > bTime ? -1 : 1;
}

function safeIncludes(text, keyword) {
  return String(text || "").toLowerCase().includes(String(keyword || "").toLowerCase());
}

Page({
  data: {
    source: "search",
    intake: null,
    has_intake: false,
    intake_city_text: "未填写",
    intake_usage_text: "未填写",
    intake_budget_text: "- - -",
    selected_count_text: "0",
    listings: [],
    has_listings: false,
    has_source_listings: false,
    show_empty_list: true,
    empty_title: "暂无可搜索房源",
    empty_desc: "传统搜索基于你已导入的房源，请先去 AI 线路导入。",
    all_listings: [],
    filter_budget_min: "",
    filter_budget_max: "",
    filter_keyword: "",
    compare_ids: []
  },

  onLoad(options) {
    this.setData({
      source: options.source || "search"
    });
  },

  onShow() {
    if (!isLoggedIn()) {
      requireLogin("/pages/candidates/index");
      return;
    }

    const route = this.data.source && this.data.source !== "search"
      ? `/pages/candidates/index?source=${encodeURIComponent(this.data.source)}`
      : "/pages/candidates/index";
    set(STORAGE_KEYS.RECENT_CONTINUE_ROUTE, route);
    trackEvent(EVENTS.PAGE_CANDIDATE_VIEW, {
      source: this.data.source || "search"
    });
    this.bootstrap();
  },

  bootstrap() {
    const session = getSession();
    const intakes = get(STORAGE_KEYS.BUYER_INTAKES, [])
      .filter((item) => item.user_id === session.login_code && item.status === "submitted")
      .sort(byUpdatedDesc);
    const intake = intakes.length ? intakes[0] : null;

    const allListings = get(STORAGE_KEYS.LISTINGS, []).filter(
      (item) => item.user_id === session.login_code && item.status === "active"
    );

    const compareIds = get(STORAGE_KEYS.COMPARE_LISTING_IDS, []);
    const nextState = {
      intake,
      has_intake: Boolean(intake),
      all_listings: allListings,
      compare_ids: compareIds,
      has_source_listings: allListings.length > 0
    };

    if (!this.data.filter_budget_min && intake && intake.budget_min !== null && intake.budget_min !== undefined) {
      nextState.filter_budget_min = String(intake.budget_min);
    }
    if (!this.data.filter_budget_max && intake && intake.budget_max !== null && intake.budget_max !== undefined) {
      nextState.filter_budget_max = String(intake.budget_max);
    }

    this.setData(nextState, () => {
      this.syncHeaderView();
      this.applyFilters();
    });
  },

  syncHeaderView() {
    const intake = this.data.intake;
    const budgetMin =
      intake && intake.budget_min !== null && intake.budget_min !== undefined
        ? String(intake.budget_min)
        : "-";
    const budgetMax =
      intake && intake.budget_max !== null && intake.budget_max !== undefined
        ? String(intake.budget_max)
        : "-";
    this.setData({
      has_intake: Boolean(intake),
      intake_city_text: intake && intake.city ? intake.city : "未填写",
      intake_usage_text: intake && intake.usage_type ? intake.usage_type : "未填写",
      intake_budget_text: `${budgetMin} - ${budgetMax} 万`,
      selected_count_text: String((this.data.compare_ids || []).length)
    });
  },

  handleFilterInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({
      [field]: e.detail.value
    });
  },

  handleApplyFilters() {
    this.applyFilters();
  },

  handleResetFilters() {
    const intake = this.data.intake;
    this.setData(
      {
        filter_keyword: "",
        filter_budget_min:
          intake && intake.budget_min !== null && intake.budget_min !== undefined
            ? String(intake.budget_min)
            : "",
        filter_budget_max:
          intake && intake.budget_max !== null && intake.budget_max !== undefined
            ? String(intake.budget_max)
            : ""
      },
      () => this.applyFilters()
    );
  },

  applyFilters() {
    const {
      intake,
      all_listings: allListings,
      filter_budget_min: filterBudgetMin,
      filter_budget_max: filterBudgetMax,
      filter_keyword: filterKeyword,
      compare_ids: compareIds
    } = this.data;

    const min = Number(filterBudgetMin);
    const max = Number(filterBudgetMax);
    const hasMin = !Number.isNaN(min) && filterBudgetMin !== "";
    const hasMax = !Number.isNaN(max) && filterBudgetMax !== "";

    let filtered = allListings.slice();

    if (hasMin) {
      filtered = filtered.filter((item) => item.price_total === null || item.price_total >= min);
    }

    if (hasMax) {
      filtered = filtered.filter((item) => item.price_total === null || item.price_total <= max);
    }

    if (filterKeyword) {
      filtered = filtered.filter(
        (item) =>
          safeIncludes(item.title, filterKeyword) ||
          safeIncludes(item.community_name, filterKeyword) ||
          safeIncludes(item.district, filterKeyword) ||
          safeIncludes(item.raw_text, filterKeyword)
      );
    }

    const withReason = filtered.map((item) => ({
      ...item,
      recommendation_reason: this.getRecommendation(item, intake),
      selected_for_compare: compareIds.includes(item.listing_id),
      display_title: item.title || "待完善房源",
      display_price:
        item.price_total === null || item.price_total === undefined
          ? "待补充"
          : `${item.price_total}万`,
      display_area:
        item.area_sqm === null || item.area_sqm === undefined ? "待补充" : `${item.area_sqm}㎡`,
      display_city: item.city || "未知",
      display_community: item.community_name || "待补充",
      compare_button_text: compareIds.includes(item.listing_id) ? "移出已选" : "加入已选"
    }));

    let emptyTitle = "当前筛选无结果";
    let emptyDesc = "请调整预算或关键词，再继续搜索。";
    if (!allListings.length) {
      emptyTitle = "暂无可搜索房源";
      emptyDesc = "传统搜索基于你已导入的房源，请先去 AI 线路导入。";
    }

    this.setData({
      listings: withReason,
      has_listings: withReason.length > 0,
      has_source_listings: allListings.length > 0,
      show_empty_list: withReason.length === 0,
      empty_title: emptyTitle,
      empty_desc: emptyDesc
    });
  },

  getRecommendation(listing, intake) {
    const reasons = [];

    if (intake && intake.city && listing.city && intake.city === listing.city) {
      reasons.push("AI 偏好参考：城市匹配");
    }

    if (
      intake &&
      intake.budget_min !== null &&
      intake.budget_max !== null &&
      listing.price_total !== null &&
      listing.price_total >= intake.budget_min &&
      listing.price_total <= intake.budget_max
    ) {
      reasons.push("AI 偏好参考：预算区间内");
    }

    const missingCount = (listing.missing_fields_json || []).length;
    if (missingCount > 0) {
      reasons.push(`仍缺少 ${missingCount} 个关键字段`);
    }

    if (!reasons.length && intake) {
      reasons.push("与当前 AI 偏好无明显冲突，可结合详情继续判断");
    }

    if (!reasons.length) {
      reasons.push("独立搜索模式：可先勾选房源，再交给 AI 分析");
    }
    return reasons.join(" / ");
  },

  handleOpenDetail(e) {
    const listingId = e.currentTarget.dataset.listingId;
    wx.navigateTo({
      url: `/pages/detail/index?listing_id=${listingId}&source=search`
    });
  },

  handleToggleCompare(e) {
    const listingId = e.currentTarget.dataset.listingId;
    const ids = [...this.data.compare_ids];
    const existingIndex = ids.indexOf(listingId);

    if (existingIndex >= 0) {
      ids.splice(existingIndex, 1);
    } else {
      if (ids.length >= 5) {
        wx.showToast({
          title: "最多只能勾选 5 套房源",
          icon: "none"
        });
        return;
      }
      ids.push(listingId);
      trackEvent(EVENTS.ADD_TO_COMPARE, {
        listing_id: listingId,
        selected_count: ids.length
      });
      writeActivityLog({
        action_type: "add_to_compare",
        object_type: "listing",
        object_id: listingId,
        detail_json: { selected_count: ids.length }
      });
    }

    set(STORAGE_KEYS.COMPARE_LISTING_IDS, ids);
    this.setData({ compare_ids: ids }, () => {
      this.syncHeaderView();
      this.applyFilters();
    });
  },

  handleGoAI() {
    const ids = this.data.compare_ids || [];
    trackEvent(EVENTS.SEARCH_HANDOFF_AI_CLICK, {
      selected_count: ids.length,
      source: this.data.source || "search"
    });
    writeActivityLog({
      action_type: "search_handoff_ai_click",
      object_type: "page_candidates",
      detail_json: {
        selected_count: ids.length,
        source: this.data.source || "search"
      }
    });
    wx.navigateTo({
      url: "/pages/ai/index?source=search"
    });
  },

  handleGoImport() {
    wx.navigateTo({
      url: "/pages/import/index"
    });
  }
});
