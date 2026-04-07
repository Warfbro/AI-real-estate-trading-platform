const { STORAGE_KEYS, get, set } = require("../../utils/storage");
const favoritesStore = require("../userState/favoritesStore");

let _listingCache = null;
let _listingCacheExpireAt = 0;
let _compareCache = null;

const LISTINGS_CACHE_TTL_MS = 10 * 60 * 1000;

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

function getListings({ userId, includeInactive = false } = {}) {
  if (isListingCacheValid()) {
    return {
      status: "success",
      data: _listingCache.filter((item) => includeInactive || item.status === "active"),
      source: "memory"
    };
  }

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
    console.warn("[listingSearch.listingRepo] getListings from storage failed", err);
  }

  return {
    status: "success",
    data: [],
    source: "none",
    hint: "no local cache, consider fetching from cloud"
  };
}

function queryListings(criteria = {}) {
  const result = getListings(criteria);
  if (result.status !== "success") {
    return result;
  }

  let filtered = result.data;

  if (criteria.userId) {
    filtered = filtered.filter((item) => item.user_id === criteria.userId);
  }

  if (criteria.city) {
    const cityLower = String(criteria.city).toLowerCase();
    filtered = filtered.filter((item) => String(item.city || "").toLowerCase() === cityLower);
  }

  if (criteria.district) {
    const districtLower = String(criteria.district).toLowerCase();
    filtered = filtered.filter((item) =>
      String(item.district || "").toLowerCase().includes(districtLower)
    );
  }

  if (criteria.keyword) {
    const kwLower = String(criteria.keyword).toLowerCase();
    filtered = filtered.filter((item) =>
      String(item.title || "").toLowerCase().includes(kwLower) ||
      String(item.community_name || "").toLowerCase().includes(kwLower) ||
      String(item.raw_text || "").toLowerCase().includes(kwLower)
    );
  }

  if (criteria.priceMin != null || criteria.priceMax != null) {
    filtered = filtered.filter((item) => {
      const price = item.price_total;
      if (price == null) return false;
      if (criteria.priceMin != null && price < criteria.priceMin) return false;
      if (criteria.priceMax != null && price > criteria.priceMax) return false;
      return true;
    });
  }

  if (criteria.favoriteId) {
    const favoriteIds = favoritesStore.getFavoriteIds();
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

function updateListings(listings, syncStatus = "synced") {
  try {
    const normalized = Array.isArray(listings) ? listings : [];
    const withVersion = normalized.map((item) => ({
      ...item,
      version: item.version || "1",
      updated_at: item.updated_at || nowISOTime()
    }));

    set(STORAGE_KEYS.LISTINGS, withVersion);
    _listingCache = withVersion;
    _listingCacheExpireAt = Date.now() + LISTINGS_CACHE_TTL_MS;

    return {
      status: "success",
      count: withVersion.length,
      syncStatus
    };
  } catch (err) {
    console.error("[listingSearch.listingRepo] updateListings failed", err);
    return {
      status: "error",
      error: err.message
    };
  }
}

function getFavoriteIds() {
  return favoritesStore.getFavoriteIds();
}

function toggleFavorite(listingId) {
  return favoritesStore.toggleFavorite(listingId);
}

function getCompareIds() {
  if (_compareCache !== null) {
    return Array.isArray(_compareCache) ? _compareCache : [];
  }

  try {
    const compare = get(STORAGE_KEYS.COMPARE_LISTING_IDS, []);
    _compareCache = Array.isArray(compare) ? compare : [];
    return _compareCache;
  } catch (err) {
    return [];
  }
}

function toggleCompare(listingId) {
  const compared = getCompareIds().slice();
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
    _compareCache = compared;

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

function clearFavorites() {
  return favoritesStore.clearFavorites();
}

function clearCompare() {
  try {
    set(STORAGE_KEYS.COMPARE_LISTING_IDS, []);
    _compareCache = [];
    return { status: "success" };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

function invalidateCache() {
  invalidateListingCache();
  _compareCache = null;
  favoritesStore.invalidateCache();
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
