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
  ACTIVITY_LOGS: "activity_logs"
};

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

function randomId() {
  return Math.random().toString(36).slice(2, 8);
}

function createTraceId(prefix) {
  return `${prefix}_${Date.now()}_${randomId()}`;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
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

async function getLatestSubmittedIntake(userId) {
  if (!userId) return null;
  const res = await db
    .collection(COLLECTIONS.BUYER_INTAKES)
    .where({
      user_id: userId,
      status: "submitted"
    })
    .orderBy("updated_at", "desc")
    .limit(1)
    .get();

  const list = (res && res.data) || [];
  return list.length ? list[0] : null;
}

async function getUserDefaultCity(userId) {
  if (!userId) return "";

  try {
    const byDoc = await db.collection(COLLECTIONS.USERS).doc(userId).get();
    const city = normalizeText(byDoc && byDoc.data && byDoc.data.city_default);
    if (city) return city;
  } catch (err) {
    // ignore and fallback to by user_id query
  }

  try {
    const byUserId = await db
      .collection(COLLECTIONS.USERS)
      .where({ user_id: userId })
      .limit(1)
      .get();
    const first = (byUserId && byUserId.data && byUserId.data[0]) || null;
    return normalizeText(first && first.city_default);
  } catch (err) {
    return "";
  }
}

function buildWhere(strategy, intake, cityFallback) {
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

    return where;
  }

  if (cityFallback) {
    where.city = cityFallback;
  }

  return where;
}

async function queryListings(where, page, pageSize) {
  const collection = db.collection(COLLECTIONS.LISTINGS).where(where);
  const countRes = await collection.count();
  const total = (countRes && countRes.total) || 0;
  const skip = (page - 1) * pageSize;

  if (skip >= total) {
    return {
      total,
      list: []
    };
  }

  const dataRes = await collection
    .orderBy("updated_at", "desc")
    .skip(skip)
    .limit(pageSize)
    .get();

  return {
    total,
    list: (dataRes && dataRes.data) || []
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
        action_type: "home_guess_query",
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
  const traceId = createTraceId("guess");
  const page = clampInt(event.page, 1, 1, 10000);
  const pageSize = clampInt(event.page_size || event.pageSize, 10, 10, 30);
  const userId = normalizeText(event.user_id || context.OPENID);
  const requestCity = normalizeText(event.city);

  const intake = await getLatestSubmittedIntake(userId);
  let strategy = "global_fallback";
  let cityFallback = "";

  if (intake) {
    strategy = "personalized";
  } else {
    const cityFromUser = await getUserDefaultCity(userId);
    cityFallback = cityFromUser || requestCity;
    if (cityFallback) {
      strategy = "city_fallback";
    }
  }

  const where = buildWhere(strategy, intake, cityFallback);
  const queried = await queryListings(where, page, pageSize);
  const total = queried.total;
  const list = queried.list.map(mapListingCard);

  await writeQueryLog({
    traceId,
    userId,
    strategy,
    resultCount: list.length,
    durationMs: Date.now() - start
  });

  return {
    list,
    pagination: {
      page,
      page_size: pageSize,
      total,
      has_more: page * pageSize < total
    },
    strategy,
    trace_id: traceId
  };
};
