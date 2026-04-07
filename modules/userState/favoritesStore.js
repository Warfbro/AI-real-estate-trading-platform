const { STORAGE_KEYS, get, set } = require("../../utils/storage");

let _favoriteCache = null;

function nowISOTime() {
  return new Date().toISOString();
}

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

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

function isFavorited(listingId) {
  const targetId = normalizeText(listingId);
  if (!targetId) {
    return false;
  }
  return getFavoriteIds().includes(targetId);
}

function setFavoriteIds(listingIds) {
  const normalized = Array.isArray(listingIds)
    ? Array.from(new Set(listingIds.map((item) => normalizeText(item)).filter(Boolean)))
    : [];

  try {
    set(STORAGE_KEYS.FAVORITE_LISTING_IDS, normalized);
    _favoriteCache = normalized;
    return {
      status: "success",
      count: normalized.length,
      updated_at: nowISOTime()
    };
  } catch (err) {
    return {
      status: "error",
      error: err.message
    };
  }
}

function toggleFavorite(listingId) {
  const targetId = normalizeText(listingId);
  if (!targetId) {
    return {
      status: "error",
      error: "listing_id missing"
    };
  }

  const favorites = getFavoriteIds().slice();
  const index = favorites.indexOf(targetId);
  let favorited = false;

  if (index >= 0) {
    favorites.splice(index, 1);
    favorited = false;
  } else {
    favorites.push(targetId);
    favorited = true;
  }

  const result = setFavoriteIds(favorites);
  if (result.status !== "success") {
    return result;
  }

  return {
    status: "success",
    favorited,
    listing_id: targetId,
    total_favorites: favorites.length,
    updated_at: result.updated_at
  };
}

function clearFavorites() {
  return setFavoriteIds([]);
}

function invalidateCache() {
  _favoriteCache = null;
}

module.exports = {
  getFavoriteIds,
  isFavorited,
  setFavoriteIds,
  toggleFavorite,
  clearFavorites,
  invalidateCache
};
