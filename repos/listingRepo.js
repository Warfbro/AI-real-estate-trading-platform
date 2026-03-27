/**
 * listingRepo.js - 房源数据仓库
 *
 * 职责：
 * 1) 管理 LISTINGS、FAVORITE_LISTING_IDS、COMPARE_LISTING_IDS
 * 2) 提供查询、搜索、过滤、收藏操作的统一接口
 * 3) 维护三层缓存：内存 -> storage -> 云端
 *
 * 数据流：
 * 页面查询 -> listingRepo.query() -> 优先内存/storage -> 按需云端同步
 * 页面收藏 -> listingRepo.toggleFavorite() -> 更新内存 -> storage -> 异步云端
 */

const { STORAGE_KEYS, get, set } = require("../utils/storage");

let _listingCache = null;
let _listingCacheExpireAt = 0;
let _favoriteCache = null;
let _compareCacheCache = null;

const LISTINGS_CACHE_TTL_MS = 10 * 60 * 1000; // 10分钟

function nowISOTime() {
  return new Date().toISOString();
}

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function isListingCacheValid() {
  return _listingCache && Date.now() < _listingCacheExpireAt;
}

function invalidateListingCache() {
  _listingCache = null;
  _listingCacheExpireAt = 0;
}

/**
 * 读取所有房源列表（三层缓存）
 */
function getListings({ userId, includeInactive = false } = {}) {
  // 第一层：内存缓存
  if (isListingCacheValid()) {
    return {
      status: "success",
      data: _listingCache.filter((item) => includeInactive || item.status === "active"),
      source: "memory"
    };
  }

  // 第二层：storage 缓存
  try {
    const listings = get(STORAGE_KEYS.LISTINGS, []);
    if (Array.isArray(listings) && listings.length > 0) {
      _listingCache = listings;
      _listingCacheExpireAt = Date.now() + LISTINGS_CACHE_TTL_MS;
      
      return {
        status: "success",
        data: listings.filter((item) => includeInactive || item.status === "active"),
        source: "storage"
      };
    }
  } catch (err) {
    console.warn("[listingRepo] getListings from storage failed", err);
  }

  // 第三层：兜底空数组
  return {
    status: "success",
    data: [],
    source: "none",
    hint: "no local cache, consider fetching from cloud"
  };
}

/**
 * 查询房源（支持过滤）
 */
function queryListings(criteria = {}) {
  const result = getListings(criteria);
  if (result.status !== "success") {
    return result;
  }

  let filtered = result.data;

  // 按用户过滤
  if (criteria.userId) {
    filtered = filtered.filter((item) => item.user_id === criteria.userId);
  }

  // 按城市过滤
  if (criteria.city) {
    const cityLower = String(criteria.city).toLowerCase();
    filtered = filtered.filter((item) => 
      String(item.city || "").toLowerCase() === cityLower
    );
  }

  // 按区域过滤
  if (criteria.district) {
    const districtLower = String(criteria.district).toLowerCase();
    filtered = filtered.filter((item) =>
      String(item.district || "").toLowerCase().includes(districtLower)
    );
  }

  // 按关键词过滤
  if (criteria.keyword) {
    const kwLower = String(criteria.keyword).toLowerCase();
    filtered = filtered.filter((item) =>
      String(item.title || "").toLowerCase().includes(kwLower) ||
      String(item.community_name || "").toLowerCase().includes(kwLower) ||
      String(item.raw_text || "").toLowerCase().includes(kwLower)
    );
  }

  // 按价格范围过滤
  if (criteria.priceMin != null || criteria.priceMax != null) {
    filtered = filtered.filter((item) => {
      const price = item.price_total;
      if (price == null) return false;
      if (criteria.priceMin != null && price < criteria.priceMin) return false;
      if (criteria.priceMax != null && price > criteria.priceMax) return false;
      return true;
    });
  }

  // 按收藏状态过滤
  if (criteria.favoriteId) {
    const favoriteIds = getFavoriteIds();
    filtered = filtered.filter((item) =>
      favoriteIds.includes(normalizeText(item.listing_id))
    );
  }

  return {
    status: "success",
    data: filtered,
    count: filtered.length,
    source: result.source
  };
}

/**
 * 获取单个房源
 */
function getListing(listingId) {
  const result = getListings();
  if (result.status !== "success") {
    return result;
  }

  const listing = result.data.find((item) => item.listing_id === listingId);
  return {
    status: listing ? "success" : "not_found",
    data: listing || null,
    source: result.source
  };
}

/**
 * 更新房源列表（通常来自云端同步）
 */
function updateListings(listings, syncStatus = "synced") {
  try {
    const normalized = Array.isArray(listings) ? listings : [];
    
    // 补充版本信息
    const withVersion = normalized.map((item) => ({
      ...item,
      version: item.version || "1",
      updated_at: item.updated_at || nowISOTime()
    }));

    // 写入 storage
    set(STORAGE_KEYS.LISTINGS, withVersion);

    // 更新内存缓存
    _listingCache = withVersion;
    _listingCacheExpireAt = Date.now() + LISTINGS_CACHE_TTL_MS;

    return {
      status: "success",
      count: withVersion.length,
      syncStatus
    };
  } catch (err) {
    console.error("[listingRepo] updateListings failed", err);
    return {
      status: "error",
      error: err.message
    };
  }
}

/**
 * 获取收藏列表 ID
 */
function getFavoriteIds() {
  if (_favoriteCache !== null) {
    return Array.isArray(_favoriteCache) ? _favoriteCache : [];
  }

  try {
    const favorites = get(STORAGE_KEYS.FAVORITE_LISTING_IDS, []);
    _favoriteCache = Array.isArray(favorites) ? favorites : [];
    return _favoriteCache;
  } catch (err) {
    return [];
  }
}

/**
 * 切换房源收藏状态
 */
function toggleFavorite(listingId) {
  const favorites = getFavoriteIds();
  const index = favorites.indexOf(listingId);
  let favorited = false;

  if (index >= 0) {
    favorites.splice(index, 1);
    favorited = false;
  } else {
    favorites.push(listingId);
    favorited = true;
  }

  try {
    set(STORAGE_KEYS.FAVORITE_LISTING_IDS, favorites);
    _favoriteCache = favorites;

    return {
      status: "success",
      favorited,
      listing_id: listingId,
      total_favorites: favorites.length,
      updated_at: nowISOTime()
    };
  } catch (err) {
    return {
      status: "error",
      error: err.message
    };
  }
}

/**
 * 获取比较列表 ID
 */
function getCompareIds() {
  if (_compareCacheCache !== null) {
    return Array.isArray(_compareCacheCache) ? _compareCacheCache : [];
  }

  try {
    const compare = get(STORAGE_KEYS.COMPARE_LISTING_IDS, []);
    _compareCacheCache = Array.isArray(compare) ? compare : [];
    return _compareCacheCache;
  } catch (err) {
    return [];
  }
}

/**
 * 切换房源比较状态
 */
function toggleCompare(listingId) {
  const compared = getCompareIds();
  const index = compared.indexOf(listingId);
  let included = false;

  if (index >= 0) {
    compared.splice(index, 1);
    included = false;
  } else {
    if (compared.length >= 5) {
      return {
        status: "limit_exceeded",
        message: "最多可比较5套房源",
        count: compared.length
      };
    }
    compared.push(listingId);
    included = true;
  }

  try {
    set(STORAGE_KEYS.COMPARE_LISTING_IDS, compared);
    _compareCacheCache = compared;

    return {
      status: "success",
      included,
      listing_id: listingId,
      total_compared: compared.length,
      updated_at: nowISOTime()
    };
  } catch (err) {
    return {
      status: "error",
      error: err.message
    };
  }
}

/**
 * 清空收藏
 */
function clearFavorites() {
  try {
    set(STORAGE_KEYS.FAVORITE_LISTING_IDS, []);
    _favoriteCache = [];
    return { status: "success" };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

/**
 * 清空比较
 */
function clearCompare() {
  try {
    set(STORAGE_KEYS.COMPARE_LISTING_IDS, []);
    _compareCacheCache = [];
    return { status: "success" };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

/**
 * 缓存失效
 */
function invalidateCache() {
  invalidateListingCache();
  _favoriteCache = null;
  _compareCacheCache = null;
}

module.exports = {
  getListings,
  queryListings,
  getListing,
  updateListings,
  getFavoriteIds,
  toggleFavorite,
  getCompareIds,
  toggleCompare,
  clearFavorites,
  clearCompare,
  invalidateCache
};
