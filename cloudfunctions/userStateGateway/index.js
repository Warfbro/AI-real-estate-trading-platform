"use strict";

const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

const COLLECTIONS = {
  USER_PROFILES: "user_profiles",
  BUYER_INTAKES: "buyer_intakes",
  FAVORITES: "favorites",
  LISTINGS: "listings",
  ACTIVITY_LOGS: "activity_logs"
};

const MAX_FAVORITES = 20;

function normalizeText(value, fallback = "") {
  const text = String(value == null ? "" : value).trim();
  return text || fallback;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
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

async function getUserProfile(userId) {
  if (!userId) {
    return null;
  }
  return (
    (await safeGetDoc(COLLECTIONS.USER_PROFILES, userId)) ||
    (await safeQueryFirst(COLLECTIONS.USER_PROFILES, { user_id: userId }))
  );
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

async function getFavoriteRows(userId) {
  if (!userId) {
    return [];
  }

  try {
    const result = await db
      .collection(COLLECTIONS.FAVORITES)
      .where({ user_id: userId })
      .orderBy("created_at", "desc")
      .limit(MAX_FAVORITES)
      .get();
    return (result && result.data) || [];
  } catch (err) {
    return [];
  }
}

async function getListing(listingId) {
  if (!listingId) {
    return null;
  }

  return (
    (await safeGetDoc(COLLECTIONS.LISTINGS, listingId)) ||
    (await safeQueryFirst(COLLECTIONS.LISTINGS, { listing_id: listingId }))
  );
}

async function writeActivityLog({
  traceId,
  actionType,
  userId,
  objectId = "",
  detailJson = {}
}) {
  try {
    await db.collection(COLLECTIONS.ACTIVITY_LOGS).add({
      data: {
        log_id: `log_${Date.now()}_${randomId()}`,
        actor_type: userId ? "user" : "system",
        actor_id: normalizeText(userId),
        action_type: actionType,
        object_type: "user_state_gateway",
        object_id: normalizeText(objectId || traceId),
        detail_json: detailJson,
        created_at: new Date().toISOString()
      }
    });
  } catch (err) {
    // Best-effort logging only.
  }
}

async function syncUserProfile(profile) {
  const userId = normalizeText(profile && profile.user_id);
  if (!userId) {
    throw new Error("user_profiles missing user_id");
  }

  const existing = await getUserProfile(userId);
  const next = {
    ...(existing || {}),
    ...(profile || {}),
    user_id: userId,
    updated_at: normalizeText((profile && profile.updated_at) || new Date().toISOString())
  };

  if (!next.created_at) {
    next.created_at = (existing && existing.created_at) || next.updated_at;
  }

  await db.collection(COLLECTIONS.USER_PROFILES).doc(userId).set({
    data: next
  });

  return next;
}

async function syncBuyerIntake(intake) {
  const intakeId = normalizeText(intake && intake.intake_id);
  if (!intakeId) {
    throw new Error("buyer_intakes missing intake_id");
  }

  const next = {
    ...(intake || {}),
    intake_id: intakeId,
    updated_at: normalizeText((intake && intake.updated_at) || new Date().toISOString())
  };

  if (!next.created_at) {
    next.created_at = next.updated_at;
  }

  await db.collection(COLLECTIONS.BUYER_INTAKES).doc(intakeId).set({
    data: next
  });

  return next;
}

async function listFavoriteIds(userId, n0, n1) {
  if (!userId) {
    return [];
  }

  const rows = await getFavoriteRows(userId);
  return rows
    .slice(n0, n1 + 1)
    .map((item) => normalizeText(item && item.listing_id))
    .filter(Boolean);
}

async function addFavorite(userId, listingId, traceId) {
  if (!userId) {
    return {
      ok: false,
      code: "USER_ID_REQUIRED",
      message: "user_id is required"
    };
  }

  if (!listingId) {
    return {
      ok: false,
      code: "LISTING_ID_REQUIRED",
      message: "listing_id is required"
    };
  }

  const listing = await getListing(listingId);
  if (!listing || normalizeText(listing.status, "active") !== "active") {
    return {
      ok: false,
      code: "LISTING_NOT_FOUND",
      message: "listing not found"
    };
  }

  const rows = await getFavoriteRows(userId);
  const exists = rows.some((item) => normalizeText(item && item.listing_id) === listingId);
  if (exists) {
    return {
      ok: true,
      listing_id: listingId,
      houseId: listingId,
      favorited: true
    };
  }

  if (rows.length >= MAX_FAVORITES) {
    return {
      ok: false,
      code: "FAVORITE_LIMIT_EXCEEDED",
      message: `favorites exceed limit ${MAX_FAVORITES}`
    };
  }

  const now = new Date().toISOString();
  await db.collection(COLLECTIONS.FAVORITES).add({
    data: {
      favorite_id: `favorite_${Date.now()}_${randomId()}`,
      user_id: userId,
      listing_id: listingId,
      created_at: now
    }
  });

  await writeActivityLog({
    traceId,
    actionType: "user_state_add_favorite",
    userId,
    objectId: listingId,
    detailJson: {
      listing_id: listingId
    }
  });

  return {
    ok: true,
    listing_id: listingId,
    houseId: listingId,
    favorited: true
  };
}

async function removeFavorite(userId, listingId, traceId) {
  if (!userId) {
    return {
      ok: false,
      code: "USER_ID_REQUIRED",
      message: "user_id is required"
    };
  }

  if (!listingId) {
    return {
      ok: false,
      code: "LISTING_ID_REQUIRED",
      message: "listing_id is required"
    };
  }

  try {
    await db.collection(COLLECTIONS.FAVORITES).where({
      user_id: userId,
      listing_id: listingId
    }).remove();
  } catch (err) {
    // ignore remove miss
  }

  await writeActivityLog({
    traceId,
    actionType: "user_state_remove_favorite",
    userId,
    objectId: listingId,
    detailJson: {
      listing_id: listingId
    }
  });

  return {
    ok: true,
    listing_id: listingId,
    houseId: listingId,
    favorited: false
  };
}

exports.main = async (event = {}, context = {}) => {
  const traceId = createTraceId("user_state");
  const action = normalizeText(event.action).toLowerCase();
  const userId = pickUserId(event, context);

  try {
    if (action === "sync_user_profile") {
      const profile = await syncUserProfile(event.profile || {});
      return {
        ok: true,
        trace_id: traceId,
        action,
        data: profile
      };
    }

    if (action === "sync_buyer_intake") {
      const intake = await syncBuyerIntake(event.intake || {});
      return {
        ok: true,
        trace_id: traceId,
        action,
        data: intake
      };
    }

    if (action === "get_user_state") {
      const [profile, latestIntake, favoriteRows] = await Promise.all([
        getUserProfile(userId),
        getLatestSubmittedIntake(userId),
        getFavoriteRows(userId)
      ]);

      const favoriteListingIds = favoriteRows
        .map((item) => normalizeText(item && item.listing_id))
        .filter(Boolean);

      return {
        ok: true,
        trace_id: traceId,
        action,
        user_id: userId,
        uid: userId,
        data: {
          profile,
          latest_intake: latestIntake,
          favorite_listing_ids: favoriteListingIds,
          favorite_house_ids: favoriteListingIds,
          favorite_count: favoriteListingIds.length,
          current_location: {
            city_default: normalizeText(
              profile && (profile.city_default || profile.current_city || profile.city)
            )
          }
        }
      };
    }

    if (action === "list_favorites") {
      const n0 = clampInt(event.n0, 0, 0, MAX_FAVORITES);
      const n1 = clampInt(event.n1, Math.max(n0, MAX_FAVORITES - 1), n0, MAX_FAVORITES - 1);
      const favoriteListingIds = await listFavoriteIds(userId, n0, n1);

      return {
        ok: true,
        trace_id: traceId,
        action,
        user_id: userId,
        uid: userId,
        listing_ids: favoriteListingIds,
        houseIds: favoriteListingIds,
        total: favoriteListingIds.length
      };
    }

    if (action === "is_favorited") {
      const listingId = normalizeText(event.listing_id || event.houseId || event.house_id);
      const rows = await getFavoriteRows(userId);
      const isFavorited = rows.some((item) => normalizeText(item && item.listing_id) === listingId);

      return {
        ok: true,
        trace_id: traceId,
        action,
        user_id: userId,
        uid: userId,
        listing_id: listingId,
        houseId: listingId,
        is_favorited: isFavorited,
        isFavorited
      };
    }

    if (action === "add_favorite") {
      const listingId = normalizeText(event.listing_id || event.houseId || event.house_id);
      const result = await addFavorite(userId, listingId, traceId);
      return {
        trace_id: traceId,
        action,
        user_id: userId,
        uid: userId,
        ...result
      };
    }

    if (action === "remove_favorite") {
      const listingId = normalizeText(event.listing_id || event.houseId || event.house_id);
      const result = await removeFavorite(userId, listingId, traceId);
      return {
        trace_id: traceId,
        action,
        user_id: userId,
        uid: userId,
        ...result
      };
    }

    if (action === "toggle_favorite") {
      const listingId = normalizeText(event.listing_id || event.houseId || event.house_id);
      const rows = await getFavoriteRows(userId);
      const exists = rows.some((item) => normalizeText(item && item.listing_id) === listingId);
      const result = exists
        ? await removeFavorite(userId, listingId, traceId)
        : await addFavorite(userId, listingId, traceId);
      return {
        trace_id: traceId,
        action,
        user_id: userId,
        uid: userId,
        ...result
      };
    }

    return {
      ok: false,
      trace_id: traceId,
      code: "UNSUPPORTED_ACTION",
      message: `unsupported action: ${action || "(empty)"}`
    };
  } catch (err) {
    console.error("[userStateGateway] execution failed", {
      trace_id: traceId,
      action,
      user_id: userId,
      message: normalizeText(err && (err.message || err.errMsg)),
      stack: normalizeText(err && err.stack)
    });

    return {
      ok: false,
      trace_id: traceId,
      code: "USER_STATE_GATEWAY_FAILED",
      message: "user state gateway execution failed",
      details: normalizeText(err && (err.message || err.errMsg))
    };
  }
};
