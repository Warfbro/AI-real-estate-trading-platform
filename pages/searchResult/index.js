const { isLoggedIn, requireLogin, getSession } = require("../../utils/auth");
const { EVENTS, trackEvent, writeActivityLog } = require("../../utils/track");
const { STORAGE_KEYS, get, set } = require("../../utils/storage");
const { listingRepo } = require("../../repos/index");

const HISTORY_LIMIT = 12;

function byUpdatedDesc(a, b) {
  const aTime = a.updated_at || a.created_at || "";
  const bTime = b.updated_at || b.created_at || "";
  return aTime > bTime ? -1 : 1;
}

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function normalizeKeyword(value) {
  return String(value || "").trim();
}

function safeIncludes(text, keyword) {
  return String(text || "").toLowerCase().includes(String(keyword || "").toLowerCase());
}

function normalizeHistory(list) {
  if (!Array.isArray(list)) {
    return [];
  }

  const seen = new Set();
  const result = [];
  list.forEach((item) => {
    const keyword = normalizeKeyword(item);
    if (!keyword || seen.has(keyword)) {
      return;
    }
    seen.add(keyword);
    result.push(keyword);
  });

  return result.slice(0, HISTORY_LIMIT);
}

function normalizeTags(rawTags) {
  if (Array.isArray(rawTags)) {
    return rawTags
      .map((item) => {
        if (typeof item === "string") return normalizeText(item);
        if (item && typeof item === "object") {
          return normalizeText(item.title || item.name || item.label || item.code);
        }
        return "";
      })
      .filter(Boolean);
  }

  if (typeof rawTags === "string") {
    return rawTags
      .split(/[,\s|\uFF0C\u3001]+/)
      .map((item) => normalizeText(item))
      .filter(Boolean);
  }

  return [];
}

function buildListingMeta(item) {
  const area = item.area_sqm == null ? "面积待补充" : `${item.area_sqm}㎡`;
  const layout = normalizeText(item.layout_desc, "户型待补充");
  const floor = normalizeText(item.floor_desc, "楼层待补充");
  return `${layout} · ${area} · ${floor}`;
}

function formatRegionText(city, district) {
  const cityText = normalizeText(city);
  const districtText = normalizeText(district);
  if (cityText && districtText) {
    return `${cityText} / ${districtText}`;
  }
  if (cityText) {
    return cityText;
  }
  return "全城";
}

Page({
  data: {
    source: "search",
    intake: null,
    has_intake: false,
    intake_city_text: "全城",
    intake_usage_text: "自住",
    intake_budget_text: "预算待定",
    budget_menu_text: "价格",

    search_city_filter: "",
    search_district_filter: "",
    search_region_value: [],
    search_region_text: "全城",
    has_region_selected: false,

    all_listings: [],
    listings: [],
    has_source_listings: false,
    show_empty_list: true,
    empty_title: "暂无可搜索房源",
    empty_desc: "你可以先去导入房源，再回来传统搜索。",

    filter_keyword: "",
    favorite_ids: []
  },

  onLoad(options) {
    const decodeSafe = (value) => {
      const text = normalizeText(value);
      if (!text) return "";
      try {
        return decodeURIComponent(text);
      } catch (err) {
        return text;
      }
    };

    const queryCity = decodeSafe(options && options.city);
    const queryDistrict = decodeSafe(options && options.district);
    const storedRegion = get(STORAGE_KEYS.SEARCH_REGION_FILTER, []);
    const regionValue = Array.isArray(storedRegion) ? storedRegion : [];
    const storedCity = normalizeKeyword(regionValue[1] || regionValue[0]);
    const storedDistrict = normalizeKeyword(regionValue[2]);
    const city = queryCity || storedCity;
    const district = queryDistrict || storedDistrict;

    this.setData({
      source: (options && options.source) || "search",
      filter_keyword: decodeSafe(options && options.keyword),
      search_city_filter: city,
      search_district_filter: district,
      search_region_value: regionValue,
      search_region_text: formatRegionText(city, district),
      has_region_selected: Boolean(city)
    });
  },

  onShow() {
    if (!isLoggedIn()) {
      requireLogin("/pages/searchResult/index");
      return;
    }

    const queryParts = [];
    if (this.data.source && this.data.source !== "search") {
      queryParts.push(`source=${encodeURIComponent(this.data.source)}`);
    }
    if (this.data.filter_keyword) {
      queryParts.push(`keyword=${encodeURIComponent(this.data.filter_keyword)}`);
    }
    if (this.data.search_city_filter) {
      queryParts.push(`city=${encodeURIComponent(this.data.search_city_filter)}`);
    }
    if (this.data.search_district_filter) {
      queryParts.push(`district=${encodeURIComponent(this.data.search_district_filter)}`);
    }

    trackEvent(EVENTS.PAGE_CANDIDATE_VIEW, {
      source: this.data.source || "search"
    });

    this.bootstrap();
  },

  bootstrap() {
    const session = getSession();
    const userId = normalizeText(session && (session.login_code || session.user_id));

    const intakes = get(STORAGE_KEYS.BUYER_INTAKES, [])
      .filter((item) => item && item.user_id === userId && item.status === "submitted")
      .sort(byUpdatedDesc);
    const intake = intakes.length ? intakes[0] : null;

    const allListings = get(STORAGE_KEYS.LISTINGS, []).filter(
      (item) => item && item.user_id === userId && item.status === "active"
    );

    const favoriteIdsRaw = get(STORAGE_KEYS.FAVORITE_LISTING_IDS, []);
    const favoriteIds = Array.isArray(favoriteIdsRaw)
      ? Array.from(new Set(favoriteIdsRaw.map((item) => normalizeText(item)).filter(Boolean)))
      : [];

    this.setData(
      {
        intake,
        has_intake: Boolean(intake),
        all_listings: allListings,
        has_source_listings: allListings.length > 0
      },
      () => {
        this.syncHeaderView();
        this.applyFilters();
      }
    );
  },

  syncHeaderView() {
    const intake = this.data.intake;
    const budgetMin = intake && intake.budget_min != null ? String(intake.budget_min) : "-";
    const budgetMax = intake && intake.budget_max != null ? String(intake.budget_max) : "-";
    const cityText =
      normalizeText(this.data.search_city_filter) ||
      (intake && intake.city ? intake.city : "全城");

    this.setData({
      intake_city_text: cityText,
      intake_usage_text: intake && intake.usage_type ? intake.usage_type : "自住",
      intake_budget_text: intake ? `${budgetMin}-${budgetMax}万` : "预算待定",
      budget_menu_text: intake ? `${budgetMin}-${budgetMax}万` : "价格"
    });
  },

  applyFilters() {
    const {
      intake,
      all_listings: allListings,
      filter_keyword: filterKeyword,
      search_city_filter: cityFilter,
      search_district_filter: districtFilter,
      favorite_ids: favoriteIds
    } = this.data;

    let filtered = allListings.slice();

    if (cityFilter) {
      filtered = filtered.filter((item) => {
        const cityText = normalizeText(item.city);
        return cityText === cityFilter || safeIncludes(cityText, cityFilter) || safeIncludes(cityFilter, cityText);
      });
    }

    if (districtFilter) {
      filtered = filtered.filter((item) => safeIncludes(item.district, districtFilter));
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

    const favoriteSet = new Set((favoriteIds || []).map((item) => normalizeText(item)).filter(Boolean));
    const listings = filtered.map((item) => {
      const displayTags = normalizeTags(item.tags_json || item.tags).slice(0, 4);
      const badge = displayTags[0] || "精选房源";
      const listingId = normalizeText(item.listing_id);

      return {
        ...item,
        display_title: normalizeText(item.title, "待完善房源"),
        display_meta: buildListingMeta(item),
        display_location: `${normalizeText(item.city, "未知")}-${normalizeText(item.district, "区域待补充")}`,
        display_price: item.price_total == null ? "价格待补充" : `${item.price_total}万`,
        display_tags: displayTags,
        display_badge: badge,
        is_favorited: favoriteSet.has(listingId),
        favorite_text: favoriteSet.has(listingId) ? "已收藏" : "收藏",
        cover_image_url: normalizeText(item.cover_image_url || item.image_url || item.raw_file_url, "/img/image.png"),
        recommendation_reason: this.getRecommendation(item, intake)
      };
    });

    let emptyTitle = "当前筛选无结果";
    let emptyDesc = "请调整关键词或位置后继续搜索。";
    if (!allListings.length) {
      emptyTitle = "暂无可搜索房源";
      emptyDesc = "传统搜索基于你已导入的房源，先去导入再回来更高效。";
    }

    this.setData({
      favorite_ids: favoriteIds,
      listings,
      show_empty_list: listings.length === 0,
      empty_title: emptyTitle,
      empty_desc: emptyDesc
    });
  },

  getRecommendation(listing, intake) {
    const reasons = [];

    if (intake && intake.city && listing.city && intake.city === listing.city) {
      reasons.push("城市匹配");
    }

    if (
      intake &&
      intake.budget_min != null &&
      intake.budget_max != null &&
      listing.price_total != null &&
      listing.price_total >= intake.budget_min &&
      listing.price_total <= intake.budget_max
    ) {
      reasons.push("预算区间内");
    }

    if (!reasons.length) {
      reasons.push("点击收藏后可交给AI比较");
    }

    return reasons.join(" · ");
  },

  handleFilterInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({
      [field]: e.detail.value
    });
  },

  handleSearchConfirm() {
    const keyword = normalizeKeyword(this.data.filter_keyword);
    this.setData(
      {
        filter_keyword: keyword
      },
      () => {
        if (keyword) {
          this.saveSearchHistory(keyword);
        }
        this.applyFilters();
      }
    );
  },

  saveSearchHistory(keyword) {
    const current = normalizeHistory(get(STORAGE_KEYS.SEARCH_HISTORY, []));
    const next = [keyword]
      .concat(current.filter((item) => item !== keyword))
      .slice(0, HISTORY_LIMIT);
    set(STORAGE_KEYS.SEARCH_HISTORY, next);
  },

  handleRegionChange(e) {
    const regionValue = Array.isArray(e.detail.value) ? e.detail.value : [];
    const city = normalizeKeyword(regionValue[1] || regionValue[0]);
    const district = normalizeKeyword(regionValue[2]);
    set(STORAGE_KEYS.SEARCH_REGION_FILTER, regionValue);

    this.setData(
      {
        search_city_filter: city,
        search_district_filter: district,
        search_region_value: regionValue,
        search_region_text: formatRegionText(city, district),
        has_region_selected: regionValue.length > 0
      },
      () => {
        this.syncHeaderView();
        this.applyFilters();
      }
    );
  },

  handleClearRegion() {
    set(STORAGE_KEYS.SEARCH_REGION_FILTER, []);
    this.setData(
      {
        search_city_filter: "",
        search_district_filter: "",
        search_region_value: [],
        search_region_text: "全城",
        has_region_selected: false
      },
      () => {
        this.syncHeaderView();
        this.applyFilters();
      }
    );
  },

  handlePickPrice() {
    wx.showToast({
      title: "价格筛选开发中",
      icon: "none"
    });
  },

  handlePickLayout() {
    wx.showToast({
      title: "户型筛选开发中",
      icon: "none"
    });
  },

  handleOpenDetail(e) {
    const listingId = e.currentTarget.dataset.listingId;
    wx.navigateTo({
      url: `/pages/detail/index?listing_id=${listingId}&source=search`
    });
  },

  handleToggleFavorite(e) {
    const listingId = normalizeText(e.currentTarget.dataset.listingId);
    if (!listingId) {
      return;
    }

    // 通过 repo 层切换收藏
    const result = listingRepo.toggleFavorite(listingId);
    if (result.status !== "success") {
      wx.showToast({
        title: "操作失败",
        icon: "none"
      });
      return;
    }

    // 更新页面数据
    const favoriteIds = listingRepo.getFavoriteIds();
    this.setData(
      {
        favorite_ids: favoriteIds
      },
      () => this.applyFilters()
    );

    if (result.favorited) {
      wx.showToast({
        title: "收藏成功",
        icon: "none"
      });
    }

    trackEvent(EVENTS.LISTING_FAVORITE, {
      source: "candidates",
      listing_id: listingId,
      favorited: result.favorited
    });
    writeActivityLog({
      action_type: "listing_favorite_toggle",
      object_type: "listing",
      object_id: listingId,
      detail_json: {
        source: "candidates",
        favorited: result.favorited
      }
    });
  },

  handleGoAI() {
    trackEvent(EVENTS.SEARCH_HANDOFF_AI_CLICK, {
      selected_count: 0,
      source: this.data.source || "search"
    });
    writeActivityLog({
      action_type: "search_handoff_ai_click",
      object_type: "page_candidates",
      detail_json: {
        selected_count: 0,
        source: this.data.source || "search"
      }
    });

    wx.navigateTo({
      url: "/pages/ai/index"
    });
  },

  handleGoImport() {
    wx.navigateTo({
      url: "/pages/import/index"
    });
  }
});
