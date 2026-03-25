const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;

const COLLECTIONS = {
  LISTINGS: "listings",
  ACTIVITY_LOGS: "activity_logs"
};

const MAX_LOG_SCAN = 1000;
const MAX_LISTING_SCAN = 200;

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeText(value) {
  return String(value || "").trim();
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

function toMillis(value) {
  const text = normalizeText(value);
  if (!text) return 0;
  const num = Date.parse(text);
  return Number.isNaN(num) ? 0 : num;
}

function randomId() {
  return Math.random().toString(36).slice(2, 8);
}

function createTraceId(prefix) {
  return `${prefix}_${Date.now()}_${randomId()}`;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
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

function mapListingCard(item) {
  const tags = toArray(item.tags_json);
  const { latitude, longitude } = extractCoordinates(item);
  return {
    listing_id: item.listing_id || "",
    title: item.title || "",
    cover_image_url: item.cover_image_url || item.image_url || "",
    city: item.city || "",
    district: item.district || "",
    community: item.community_name || "",
    community_name: item.community_name || "",
    price_total: item.price_total == null ? null : item.price_total,
    area: item.area_sqm == null ? null : item.area_sqm,
    area_sqm: item.area_sqm == null ? null : item.area_sqm,
    tags,
    tags_json: tags,
    latitude,
    longitude,
    lat: latitude,
    lng: longitude,
    status: item.status || "",
    updated_at: item.updated_at || item.created_at || ""
  };
}

async function readHotViewCounts() {
  const counts = new Map();
  const res = await db
    .collection(COLLECTIONS.ACTIVITY_LOGS)
    .where({
      object_type: "listing",
      action_type: _.in(["view", "listing_view", "detail_view"])
    })
    .orderBy("created_at", "desc")
    .limit(MAX_LOG_SCAN)
    .get();

  const logs = (res && res.data) || [];
  logs.forEach((log) => {
    const listingId = normalizeText(log.object_id);
    if (!listingId) return;
    const prev = counts.get(listingId) || 0;
    counts.set(listingId, prev + 1);
  });

  return counts;
}

async function readActiveListings(city) {
  const where = {
    status: "active"
  };
  if (city) {
    where.city = city;
  }

  const res = await db
    .collection(COLLECTIONS.LISTINGS)
    .where(where)
    .limit(MAX_LISTING_SCAN)
    .get();

  return (res && res.data) || [];
}

function sortByHot(listings, viewCounts) {
  const hasHotSignal = listings.some((item) => (viewCounts.get(item.listing_id) || 0) > 0);

  const sorted = listings.slice().sort((a, b) => {
    const aCount = viewCounts.get(a.listing_id) || 0;
    const bCount = viewCounts.get(b.listing_id) || 0;
    if (aCount !== bCount) {
      return bCount - aCount;
    }
    const aUpdated = toMillis(a.updated_at || a.created_at);
    const bUpdated = toMillis(b.updated_at || b.created_at);
    return bUpdated - aUpdated;
  });

  return {
    hasHotSignal,
    sorted
  };
}

async function writeQueryLog({ traceId, userId, strategy, resultCount, durationMs }) {
  const now = new Date().toISOString();
  try {
    await db.collection(COLLECTIONS.ACTIVITY_LOGS).add({
      data: {
        log_id: `log_${Date.now()}_${randomId()}`,
        actor_type: userId ? "user" : "system",
        actor_id: userId || "",
        action_type: "home_hot_query",
        object_type: "home_feed",
        object_id: traceId,
        detail_json: {
          trace_id: traceId,
          strategy,
          result_count: resultCount,
          duration_ms: durationMs
        },
        created_at: now
      }
    });
  } catch (err) {
    // Best-effort logging; do not block response.
  }
}

exports.main = async (event = {}, context = {}) => {
  const start = Date.now();
  const traceId = createTraceId("hot");
  const limit = clampInt(event.limit, 8, 5, 20);
  const city = normalizeText(event.city);
  const userId = normalizeText(event.user_id || context.OPENID);

  const [viewCounts, listings] = await Promise.all([
    readHotViewCounts(),
    readActiveListings(city)
  ]);

  const sorted = sortByHot(listings, viewCounts);
  const strategy = sorted.hasHotSignal ? "log_hot" : "fresh_fallback";
  const list = sorted.sorted.slice(0, limit).map(mapListingCard);

  await writeQueryLog({
    traceId,
    userId,
    strategy,
    resultCount: list.length,
    durationMs: Date.now() - start
  });

  return {
    list,
    trace_id: traceId,
    strategy
  };
};
