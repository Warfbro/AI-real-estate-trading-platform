"use strict";

const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;

const COLLECTIONS = {
  USERS: "users",
  BUYER_INTAKES: "buyer_intakes",
  LISTINGS: "listings",
  FAVORITES: "favorites",
  ACTIVITY_LOGS: "activity_logs"
};

const MAX_PAGE_SIZE = 30;
const MAX_LISTINGS_SCAN = 200;

function normalizeText(value, fallback = "") {
  const text = String(value == null ? "" : value).trim();
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

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
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

  const text = normalizeText(rawTags);
  if (!text) {
    return [];
  }

  return text
    .split(/[,\s|，、]+/)
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function randomId() {
  return Math.random().toString(36).slice(2, 8);
}

function createTraceId(prefix) {
  return `${prefix}_${Date.now()}_${randomId()}`;
}

function pickUserId(event = {}, context = {}) {
  return normalizeText(
    event.user_id ||
      event.uid ||
      event.userId ||
      context.OPENID
  );
}

async function safeGetDoc(collectionName, docId) {
  if (!collectionName || !docId) {
    return null;
  }

  try {
    const result = await db.collection(collectionName).doc(docId).get();
    return (result && result.data) || null;
  } catch (err) {
    return null;
  }
}

async function safeQueryFirst(collectionName, where = {}, orderByField = "updated_at") {
  try {
    const result = await db
      .collection(collectionName)
      .where(where)
      .orderBy(orderByField, "desc")
      .limit(1)
      .get();
    const list = (result && result.data) || [];
    return list[0] || null;
  } catch (err) {
    return null;
  }
}

async function getFavoriteIds(userId) {
  if (!userId) {
    return [];
  }

  try {
    const result = await db
      .collection(COLLECTIONS.FAVORITES)
      .where({ user_id: userId })
      .limit(100)
      .get();
    const list = (result && result.data) || [];
    return list
      .map((item) => normalizeText(item && item.listing_id))
      .filter(Boolean);
  } catch (err) {
    return [];
  }
}

async function getLatestSubmittedIntake(userId) {
  if (!userId) {
    return null;
  }

  try {
    const result = await db
      .collection(COLLECTIONS.BUYER_INTAKES)
      .where({
        user_id: userId,
        status: "submitted"
      })
      .orderBy("updated_at", "desc")
      .limit(1)
      .get();
    const list = (result && result.data) || [];
    return list[0] || null;
  } catch (err) {
    return null;
  }
}

async function getUserDefaultCity(userId) {
  if (!userId) {
    return "";
  }

  const byDoc = await safeGetDoc(COLLECTIONS.USERS, userId);
  const direct = normalizeText(byDoc && byDoc.city_default);
  if (direct) {
    return direct;
  }

  const fallback = await safeQueryFirst(COLLECTIONS.USERS, { user_id: userId });
  return normalizeText(fallback && fallback.city_default);
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

function buildTextHaystack(item) {
  return [
    normalizeText(item && item.title),
    normalizeText(item && item.community_name),
    normalizeText(item && item.community),
    normalizeText(item && item.city),
    normalizeText(item && item.district),
    normalizeText(item && item.raw_text),
    normalizeTags(item && (item.tags_json || item.tags)).join(" ")
  ]
    .join(" ")
    .toLowerCase();
}

function mapListingCard(item, favoriteSet) {
  const tags = toArray(item.tags_json);
  const { latitude, longitude } = extractCoordinates(item);
  const listingId = normalizeText(item.listing_id);
  const isFavorited = favoriteSet.has(listingId);
  return {
    listing_id: listingId,
    houseId: listingId,
    title: item.title || "",
    cover_image_url: item.cover_image_url || item.image_url || "",
    city: item.city || "",
    district: item.district || "",
    community: item.community_name || "",
    community_name: item.community_name || "",
    price_total: item.price_total == null ? null : item.price_total,
    area: item.area_sqm == null ? null : item.area_sqm,
    area_sqm: item.area_sqm == null ? null : item.area_sqm,
    layout_desc: item.layout_desc || item.layoutText || "",
    tags,
    tags_json: tags,
    latitude,
    longitude,
    lat: latitude,
    lng: longitude,
    status: item.status || "",
    updated_at: item.updated_at || item.created_at || "",
    is_favorited: isFavorited,
    isFavorited
  };
}

function mapUnifiedListing(item, mode, favoriteSet) {
  const card = mapListingCard(item, favoriteSet);
  if (mode === "hot") {
    return {
      listing_id: card.listing_id,
      houseId: card.houseId,
      title: card.title,
      cover_image_url: card.cover_image_url,
      price_total: card.price_total,
      area_sqm: card.area_sqm,
      layout_desc: card.layout_desc,
      city: card.city,
      district: card.district,
      status: card.status,
      is_favorited: card.is_favorited,
      isFavorited: card.isFavorited
    };
  }

  if (mode === "detail") {
    return {
      ...item,
      listing_id: card.listing_id,
      houseId: card.houseId,
      is_favorited: card.is_favorited,
      isFavorited: card.isFavorited
    };
  }

  return {
    listing_id: card.listing_id,
    houseId: card.houseId,
    title: card.title,
    cover_image_url: card.cover_image_url,
    price_total: card.price_total,
    area_sqm: card.area_sqm,
    layout_desc: card.layout_desc,
    city: card.city,
    district: card.district,
    community_name: card.community_name,
    tags_json: card.tags_json,
    status: card.status,
    is_favorited: card.is_favorited,
    isFavorited: card.isFavorited
  };
}

async function queryActiveListings(where, { limit = MAX_LISTINGS_SCAN, orderByField = "updated_at" } = {}) {
  const safeWhere = {
    status: "active",
    ...(where || {})
  };

  try {
    const result = await db
      .collection(COLLECTIONS.LISTINGS)
      .where(safeWhere)
      .orderBy(orderByField, "desc")
      .limit(limit)
      .get();
    return (result && result.data) || [];
  } catch (err) {
    return [];
  }
}

async function readHotViewCounts() {
  const counts = new Map();

  try {
    const result = await db
      .collection(COLLECTIONS.ACTIVITY_LOGS)
      .where({
        object_type: "listing",
        action_type: _.in(["view", "listing_view", "detail_view"])
      })
      .orderBy("created_at", "desc")
      .limit(1000)
      .get();

    const list = (result && result.data) || [];
    list.forEach((item) => {
      const listingId = normalizeText(item && item.object_id);
      if (!listingId) {
        return;
      }
      counts.set(listingId, (counts.get(listingId) || 0) + 1);
    });
  } catch (err) {
    // ignore log read failures
  }

  return counts;
}

function sortByHot(listings, viewCounts) {
  const sorted = listings.slice().sort((a, b) => {
    const aId = normalizeText(a && a.listing_id);
    const bId = normalizeText(b && b.listing_id);
    const aCount = viewCounts.get(aId) || 0;
    const bCount = viewCounts.get(bId) || 0;
    if (aCount !== bCount) {
      return bCount - aCount;
    }

    const aHot = pickFirstNumber(a && a.hot_score, a && a.hotScore) || 0;
    const bHot = pickFirstNumber(b && b.hot_score, b && b.hotScore) || 0;
    if (aHot !== bHot) {
      return bHot - aHot;
    }

    return normalizeText(b && (b.updated_at || b.created_at)).localeCompare(
      normalizeText(a && (a.updated_at || a.created_at))
    );
  });

  return sorted;
}

function buildGuessWhere(strategy, intake, cityFallback) {
  const where = {
    status: "active"
  };

  if (strategy === "personalized" && intake) {
    const intakeCity = normalizeText(intake.city);
    if (intakeCity) {
      where.city = intakeCity;
    }

    const budgetMin = toNumberOrNull(intake.budget_min);
    const budgetMax = toNumberOrNull(intake.budget_max);

    if (budgetMin != null && budgetMax != null && budgetMin <= budgetMax) {
      where.price_total = _.gte(budgetMin).and(_.lte(budgetMax));
    } else if (budgetMin != null) {
      where.price_total = _.gte(budgetMin);
    } else if (budgetMax != null) {
      where.price_total = _.lte(budgetMax);
    }
  } else if (cityFallback) {
    where.city = cityFallback;
  }

  return where;
}

async function writeActivityLog({
  traceId,
  actionType,
  userId,
  detailJson = {}
}) {
  try {
    await db.collection(COLLECTIONS.ACTIVITY_LOGS).add({
      data: {
        log_id: `log_${Date.now()}_${randomId()}`,
        actor_type: userId ? "user" : "system",
        actor_id: normalizeText(userId),
        action_type: actionType,
        object_type: "listing_search_gateway",
        object_id: traceId,
        detail_json: detailJson,
        created_at: new Date().toISOString()
      }
    });
  } catch (err) {
    // Best-effort logging only.
  }
}

async function handleHomeHot(event, context, traceId) {
  const userId = pickUserId(event, context);
  const limit = clampInt(event.limit, 8, 1, 20);
  const city = normalizeText(event.city);
  const [favoriteIds, viewCounts, listings] = await Promise.all([
    getFavoriteIds(userId),
    readHotViewCounts(),
    queryActiveListings(city ? { city } : {}, { limit: MAX_LISTINGS_SCAN, orderByField: "updated_at" })
  ]);

  const favoriteSet = new Set(favoriteIds);
  const list = sortByHot(listings, viewCounts)
    .slice(0, limit)
    .map((item) => mapListingCard(item, favoriteSet));

  await writeActivityLog({
    traceId,
    actionType: "listing_search_home_hot",
    userId,
    detailJson: {
      city,
      limit,
      result_count: list.length
    }
  });

  return {
    ok: true,
    trace_id: traceId,
    action: "query_home_hot",
    list,
    strategy: "hot_score"
  };
}

async function handleHomeGuess(event, context, traceId) {
  const userId = pickUserId(event, context);
  const page = clampInt(event.page, 1, 1, 10000);
  const pageSize = clampInt(event.page_size || event.pageSize, 10, 1, MAX_PAGE_SIZE);
  const requestCity = normalizeText(event.city);

  const intake = await getLatestSubmittedIntake(userId);
  let strategy = "global_fallback";
  let cityFallback = "";

  if (intake) {
    strategy = "personalized";
  } else {
    cityFallback = (await getUserDefaultCity(userId)) || requestCity;
    if (cityFallback) {
      strategy = "city_fallback";
    }
  }

  const where = buildGuessWhere(strategy, intake, cityFallback);
  const listings = await queryActiveListings(where, {
    limit: Math.min(page * pageSize + pageSize, MAX_LISTINGS_SCAN),
    orderByField: "updated_at"
  });
  const favoriteSet = new Set(await getFavoriteIds(userId));
  const start = (page - 1) * pageSize;
  const list = listings.slice(start, start + pageSize).map((item) => mapListingCard(item, favoriteSet));

  await writeActivityLog({
    traceId,
    actionType: "listing_search_home_guess",
    userId,
    detailJson: {
      strategy,
      page,
      page_size: pageSize,
      result_count: list.length
    }
  });

  return {
    ok: true,
    trace_id: traceId,
    action: "query_home_guess",
    list,
    pagination: {
      page,
      page_size: pageSize,
      total: listings.length,
      has_more: start + pageSize < listings.length
    },
    strategy
  };
}

async function handleUnifiedQuery(event, context, traceId) {
  const userId = pickUserId(event, context);
  const listingId = normalizeText(event.listing_id || event.houseId || event.house_id);
  const title = normalizeText(event.title || event.query || event.q).toLowerCase();
  const tags = normalizeTags(event.tags);
  const n0 = clampInt(event.n0, 0, 0, 10000);
  const n1 = clampInt(event.n1, n0 + 9, n0, n0 + MAX_PAGE_SIZE - 1);
  const mode = normalizeText(event.mode, "brief").toLowerCase();
  const favoriteSet = new Set(await getFavoriteIds(userId));

  if (!["detail", "brief", "hot"].includes(mode)) {
    return {
      ok: false,
      trace_id: traceId,
      code: "INVALID_MODE",
      message: "mode must be detail / brief / hot"
    };
  }

  if (listingId) {
    const listing =
      (await safeGetDoc(COLLECTIONS.LISTINGS, listingId)) ||
      (await safeQueryFirst(COLLECTIONS.LISTINGS, { listing_id: listingId }));
    const active = listing && normalizeText(listing.status, "active") === "active" ? [listing] : [];
    return {
      ok: true,
      trace_id: traceId,
      action: "query_unified",
      mode,
      items: active.map((item) => mapUnifiedListing(item, mode, favoriteSet)),
      total: active.length
    };
  }

  const listings = await queryActiveListings({}, {
    limit: MAX_LISTINGS_SCAN,
    orderByField: "updated_at"
  });

  const filtered = listings
    .filter((item) => {
      const haystack = buildTextHaystack(item);
      if (title && !haystack.includes(title)) {
        return false;
      }
      if (!tags.length) {
        return true;
      }

      const itemTags = normalizeTags(item.tags_json || item.tags).map((tag) => tag.toLowerCase());
      return tags.every((tag) => itemTags.includes(tag.toLowerCase()));
    })
    .sort((a, b) => {
      const aHot = pickFirstNumber(a && a.hot_score, a && a.hotScore) || 0;
      const bHot = pickFirstNumber(b && b.hot_score, b && b.hotScore) || 0;
      if (aHot !== bHot) {
        return bHot - aHot;
      }
      return normalizeText(b && (b.updated_at || b.created_at)).localeCompare(
        normalizeText(a && (a.updated_at || a.created_at))
      );
    });

  const pageItems = filtered.slice(n0, n1 + 1).map((item) => mapUnifiedListing(item, mode, favoriteSet));

  await writeActivityLog({
    traceId,
    actionType: "listing_search_unified_query",
    userId,
    detailJson: {
      query: title,
      tags,
      mode,
      returned_count: pageItems.length
    }
  });

  return {
    ok: true,
    trace_id: traceId,
    action: "query_unified",
    mode,
    items: pageItems,
    total: filtered.length,
    paging: {
      n0,
      n1,
      has_more: n1 + 1 < filtered.length
    }
  };
}

async function handleBriefByIds(event, context, traceId) {
  const userId = pickUserId(event, context);
  const favoriteSet = new Set(await getFavoriteIds(userId));
  const rawIds = []
    .concat(event.listing_ids || [])
    .concat(event.houseIds || [])
    .concat(event.house_ids || [])
    .concat(event.selected_listing_ids || []);

  const listingIds = rawIds
    .map((item) => normalizeText(item))
    .filter(Boolean);

  if (!listingIds.length) {
    return {
      ok: true,
      trace_id: traceId,
      action: "query_brief_by_ids",
      items: []
    };
  }

  const rows = await queryActiveListings({
    listing_id: _.in(listingIds)
  }, {
    limit: Math.min(listingIds.length, MAX_LISTINGS_SCAN),
    orderByField: "updated_at"
  });

  const orderMap = new Map();
  listingIds.forEach((id, index) => {
    orderMap.set(id, index);
  });

  const items = rows
    .slice()
    .sort((a, b) => {
      const aIndex = orderMap.get(normalizeText(a && a.listing_id));
      const bIndex = orderMap.get(normalizeText(b && b.listing_id));
      return aIndex - bIndex;
    })
    .map((item) => mapUnifiedListing(item, "brief", favoriteSet));

  return {
    ok: true,
    trace_id: traceId,
    action: "query_brief_by_ids",
    items
  };
}

exports.main = async (event = {}, context = {}) => {
  const traceId = createTraceId("listing_search");
  const action = normalizeText(event.action).toLowerCase();

  try {
    if (action === "query_home_hot") {
      return handleHomeHot(event, context, traceId);
    }

    if (action === "query_home_guess") {
      return handleHomeGuess(event, context, traceId);
    }

    if (action === "query_unified") {
      return handleUnifiedQuery(event, context, traceId);
    }

    if (action === "query_brief_by_ids") {
      return handleBriefByIds(event, context, traceId);
    }

    return {
      ok: false,
      trace_id: traceId,
      code: "UNSUPPORTED_ACTION",
      message: `unsupported action: ${action || "(empty)"}`
    };
  } catch (err) {
    console.error("[listingSearchGateway] execution failed", {
      trace_id: traceId,
      action,
      user_id: pickUserId(event, context),
      message: normalizeText(err && (err.message || err.errMsg)),
      stack: normalizeText(err && err.stack)
    });

    return {
      ok: false,
      trace_id: traceId,
      code: "LISTING_SEARCH_GATEWAY_FAILED",
      message: "listing search gateway execution failed",
      details: normalizeText(err && (err.message || err.errMsg))
    };
  }
};
