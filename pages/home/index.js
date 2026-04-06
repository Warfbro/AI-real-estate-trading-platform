const { isLoggedIn, getSession, getUserRole } = require("../../utils/auth");
const { EVENTS, trackEvent, writeActivityLog } = require("../../utils/track");
const { STORAGE_KEYS, get, set } = require("../../utils/storage");
const { getHomeHotListings, getHomeGuessListings } = require("../../utils/cloud");
const { listingRepo, authRepo } = require("../../repos/index");

const HOME_FEED_REFRESH_INTERVAL_MS = 30000;
const SEARCH_PLACEHOLDER_TEXT = "搜索感兴趣的房源或区域";

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

function pickFirstNumber(...values) {
  for (let i = 0; i < values.length; i += 1) {
    const num = toNumberOrNull(values[i]);
    if (num != null) {
      return num;
    }
  }
  return null;
}

function splitKeywords(text) {
  const normalized = String(text || "").toLowerCase();
  const matches = normalized.match(/[\u4e00-\u9fa5a-z0-9]+/g);
  return (matches || []).filter(Boolean);
}

function normalizeTags(rawTags) {
  if (Array.isArray(rawTags)) {
    return rawTags
      .map((item) => {
        if (typeof item === "string") {
          return normalizeText(item);
        }
        if (item && typeof item === "object") {
          return normalizeText(item.title || item.name || item.label || item.code);
        }
        return "";
      })
      .filter(Boolean);
  }

  if (typeof rawTags === "string") {
    return rawTags
      .split(/[,\s|，、]+/)
      .map((item) => normalizeText(item))
      .filter(Boolean);
  }

  return [];
}

function extractCoordinates(item) {
  const normalized = item && typeof item.normalized_json === "object" ? item.normalized_json : {};
  const location = normalized && typeof normalized.location === "object" ? normalized.location : {};

  const latitude = pickFirstNumber(
    item && item.latitude,
    item && item.lat,
    item && item.location_lat,
    item && item.locationLatitude,
    normalized.latitude,
    normalized.lat,
    normalized.coordinate_lat,
    normalized.coord_lat,
    location.latitude,
    location.lat
  );

  const longitude = pickFirstNumber(
    item && item.longitude,
    item && item.lng,
    item && item.location_lng,
    item && item.locationLongitude,
    normalized.longitude,
    normalized.lng,
    normalized.coordinate_lng,
    normalized.coord_lng,
    location.longitude,
    location.lng
  );

  return {
    latitude,
    longitude
  };
}

function toDistanceKm(fromLat, fromLng, toLat, toLng) {
  if (fromLat == null || fromLng == null || toLat == null || toLng == null) {
    return null;
  }

  const earthRadiusKm = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(toLat - fromLat);
  const dLng = toRad(toLng - fromLng);
  const lat1 = toRad(fromLat);
  const lat2 = toRad(toLat);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

function formatDistanceText(distanceKm) {
  if (distanceKm == null) {
    return "";
  }
  if (distanceKm < 1) {
    return `${Math.max(1, Math.round(distanceKm * 1000))}m`;
  }
  if (distanceKm < 10) {
    return `${distanceKm.toFixed(1)}km`;
  }
  return `${Math.round(distanceKm)}km`;
}

function buildLocationKeywords(location) {
  if (!location) return [];
  const text = `${location.name || ""} ${location.address || ""}`;
  return splitKeywords(text);
}

function computeLocationScore(listing, keywords) {
  if (!keywords.length) return 0;

  const source = [
    listing.title_text,
    listing.city,
    listing.district,
    listing.community,
    ...(listing.tags_text || [])
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;
  keywords.forEach((keyword) => {
    if (source.includes(keyword)) {
      score += 1;
    }
  });
  return score;
}

function normalizeListingCard(item) {
  const area = toNumberOrNull(item.area != null ? item.area : item.area_sqm);
  const price = toNumberOrNull(item.price_total);
  const city = normalizeText(item.city);
  const district = normalizeText(item.district);
  const community = normalizeText(item.community || item.community_name);
  const tags = normalizeTags(item.tags_json || item.tags);
  const { latitude, longitude } = extractCoordinates(item);

  const coverImageUrl = normalizeText(item.cover_image_url || item.image_url || item.raw_file_url);
  const title = normalizeText(item.title, `${district || city || "房源"} ${community || ""}`.trim());
  const areaText = area == null ? "面积待补充" : `${area}平米`;
  const priceText = price == null ? "价格待补充" : `${price}万`;
  const districtText = district || city || "区域待补充";

  return {
    listing_id: normalizeText(item.listing_id),
    cover_image_url: coverImageUrl,
    title_text: title,
    hot_desc_text: `${priceText} | ${areaText}`,
    guess_desc_text: `${areaText} | ${districtText}`,
    tags_text: tags,
    city,
    district,
    community,
    latitude,
    longitude,
    distance_km: null,
    distance_text: "",
    updated_at: item.updated_at || item.created_at || ""
  };
}

Page({
  data: {
    loggedIn: false,
    hot_listings: [],
    guess_listings: [],
    favorite_ids: [],
    has_hot_listings: false,
    has_guess_listings: false,
    guess_strategy_text: "",

    selected_location_text: "选择城市",
    home_region_value: [],
    location_sort_hint_text: "",

    search_placeholder_text: SEARCH_PLACEHOLDER_TEXT
  },

  onShow() {
    if (typeof this.getTabBar === "function" && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }

    const loggedIn = isLoggedIn();
    const session = getSession();
    const userId = session ? normalizeText(session.login_code) : "";

    if (!loggedIn) {
      this.setData({
        loggedIn: false
      });
    } else {
      this.setData({
        loggedIn: true
      });
    }

    trackEvent(EVENTS.PAGE_HOME_VIEW);
    const favoriteIdsRaw = get(STORAGE_KEYS.FAVORITE_LISTING_IDS, []);
    const homeRegion = get(STORAGE_KEYS.HOME_CITY_REGION, []);
    const regionValue = Array.isArray(homeRegion) ? homeRegion : [];
    const cityText = normalizeText(regionValue[1] || regionValue[0], "");

    this._selectedLocation = cityText
      ? {
          name: cityText,
          address: regionValue.join(" "),
          latitude: null,
          longitude: null
        }
      : null;

    this.setData({
      favorite_ids: Array.isArray(favoriteIdsRaw) ? favoriteIdsRaw : [],
      home_region_value: regionValue,
      selected_location_text: cityText || "选择城市"
    });

    this._rawHotListings = this._rawHotListings || [];
    this._rawGuessListings = this._rawGuessListings || [];
    this._baseGuessStrategyText = this._baseGuessStrategyText || "";

    const hasRenderedFeeds = this.data.has_hot_listings || this.data.has_guess_listings;
    this.applyImmediateLocalFeeds(userId);

    const now = Date.now();
    const canReuseFreshFeeds =
      hasRenderedFeeds &&
      this._lastFeedLoadedAt &&
      now - this._lastFeedLoadedAt < HOME_FEED_REFRESH_INTERVAL_MS;

    if (!canReuseFreshFeeds) {
      this.loadHomeFeeds();
    }
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

  applyImmediateLocalFeeds(userId) {
    const hotList = this.getLocalListings("").slice(0, 8);
    const guessList = this.getLocalListings(userId).slice(0, 10);
    if (!hotList.length && !guessList.length) {
      return;
    }

    this.updateHomeFeedsView({
      hotList,
      guessList,
      strategyText: guessList.length ? "猜你喜欢：本地快速预览" : ""
    });
  },

  async loadHomeFeeds() {
    if (this._loadingHomeFeeds) {
      return;
    }
    this._loadingHomeFeeds = true;

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

      this.updateHomeFeedsView({
        hotList,
        guessList,
        strategyText: this.formatStrategy(guessRes.strategy)
      });
      this._lastFeedLoadedAt = Date.now();
    } catch (err) {
      const hotList = this.getLocalListings("").slice(0, 8);
      const guessList = this.getLocalListings(userId).slice(0, 10);

      this.updateHomeFeedsView({
        hotList,
        guessList,
        strategyText: guessList.length ? "猜你喜欢：本地兜底数据" : ""
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

      this._lastFeedLoadedAt = Date.now();
    } finally {
      this._loadingHomeFeeds = false;
    }
  },

  updateHomeFeedsView({ hotList, guessList, strategyText }) {
    this._rawHotListings = Array.isArray(hotList) ? hotList : [];
    this._rawGuessListings = Array.isArray(guessList) ? guessList : [];
    this._baseGuessStrategyText = strategyText || "";
    this.refreshFeedView();
  },

  buildGuessStrategyText(sortHint) {
    const parts = [];
    if (this._baseGuessStrategyText) {
      parts.push(this._baseGuessStrategyText);
    }
    if (sortHint) {
      parts.push(sortHint);
    }
    return parts.join(" · ");
  },

  refreshFeedView() {
    const baseHot = (this._rawHotListings || []).slice();
    const baseGuess = (this._rawGuessListings || []).slice();

    const sorted = this.applyLocationSort(baseHot, baseGuess);

    this.setData({
      hot_listings: sorted.hotList,
      guess_listings: sorted.guessList,
      has_hot_listings: sorted.hotList.length > 0,
      has_guess_listings: sorted.guessList.length > 0,
      guess_strategy_text: this.buildGuessStrategyText(sorted.sortHint),
      location_sort_hint_text: sorted.sortHint
    });
  },

  applyLocationSort(hotList, guessList) {
    const location = this._selectedLocation || null;
    if (!location) {
      return {
        hotList,
        guessList,
        sortHint: ""
      };
    }

    const hotSorted = this.sortListByLocation(hotList, location);
    const guessSorted = this.sortListByLocation(guessList, location);
    const locationName = location.name || location.address || "已选位置";

    const hasDistance = hotSorted.hasDistance || guessSorted.hasDistance;
    const sortHint = hasDistance
      ? `已按“${locationName}”距离排序`
      : `“${locationName}”无坐标，已按文本相关性排序`;

    return {
      hotList: hotSorted.list,
      guessList: guessSorted.list,
      sortHint
    };
  },

  sortListByLocation(list, location) {
    const withDistance = list.map((item) => {
      const distanceKm = toDistanceKm(
        location.latitude,
        location.longitude,
        item.latitude,
        item.longitude
      );
      return {
        ...item,
        distance_km: distanceKm,
        distance_text: formatDistanceText(distanceKm)
      };
    });

    const hasDistance = withDistance.some((item) => item.distance_km != null);
    if (hasDistance) {
      const sorted = withDistance.slice().sort((a, b) => {
        const aDistance = a.distance_km == null ? Number.POSITIVE_INFINITY : a.distance_km;
        const bDistance = b.distance_km == null ? Number.POSITIVE_INFINITY : b.distance_km;
        if (aDistance !== bDistance) {
          return aDistance - bDistance;
        }
        return byUpdatedDesc(a, b);
      });

      return {
        list: sorted,
        hasDistance: true
      };
    }

    const keywords = buildLocationKeywords(location);
    const sorted = withDistance
      .map((item) => ({
        ...item,
        location_score: computeLocationScore(item, keywords),
        distance_text: ""
      }))
      .sort((a, b) => {
        if (a.location_score !== b.location_score) {
          return b.location_score - a.location_score;
        }
        return byUpdatedDesc(a, b);
      })
      .map((item) => {
        const next = { ...item };
        delete next.location_score;
        return next;
      });

    return {
      list: sorted,
      hasDistance: false
    };
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

  handleCityChange(event) {
    const regionValue = Array.isArray(event.detail.value) ? event.detail.value : [];
    const cityText = normalizeText(regionValue[1] || regionValue[0], "");

    this._selectedLocation = cityText
      ? {
          name: cityText,
          address: regionValue.join(" "),
          latitude: null,
          longitude: null
        }
      : null;

    set(STORAGE_KEYS.HOME_CITY_REGION, regionValue);

    this.setData(
      {
        home_region_value: regionValue,
        selected_location_text: cityText || "选择城市"
      },
      () => {
        this.refreshFeedView();
      }
    );

    writeActivityLog({
      actor_type: "user",
      action_type: "home_city_select",
      object_type: "page_home",
      detail_json: {
        city: cityText || "",
        region: regionValue
      }
    });
  },

  handleSearchTap() {
    trackEvent(EVENTS.SEARCH_ENTRY_CLICK, { source: "home_page" });
    wx.navigateTo({
      url: "/pages/search/index?source=home"
    });
  },

  handleSearch() {
    this.handleSearchTap();
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

  handleToggleFavorite(e) {
    const listingId = normalizeText(e.currentTarget.dataset.listingId);
    if (!listingId) {
      return;
    }
    if (!isLoggedIn()) {
      wx.showToast({
        title: "登录后可收藏",
        icon: "none"
      });
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
      () => {
        this.refreshFeedView();
      }
    );

    // 收藏成功时提示
    if (result.favorited) {
      wx.showToast({
        title: "收藏成功",
        icon: "none"
      });
    }

    trackEvent(EVENTS.LISTING_FAVORITE, {
      source: "home",
      listing_id: listingId,
      favorited: result.favorited
    });
    writeActivityLog({
      action_type: "listing_favorite_toggle",
      object_type: "listing",
      object_id: listingId,
      detail_json: {
        source: "home",
        favorited: result.favorited
      }
    });
  },

  handleContinue() {
    // Removed: continue functionality
  },
});


