"use strict";

const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

const COLLECTIONS = {
  LISTING_IMPORT_JOBS: "listing_import_jobs",
  LISTINGS: "listings",
  FAVORITES: "favorites",
  ACTIVITY_LOGS: "activity_logs"
};

function normalizeText(value, fallback = "") {
  const text = String(value == null ? "" : value).trim();
  return text || fallback;
}

function randomId() {
  return Math.random().toString(36).slice(2, 8);
}

function createTraceId(prefix) {
  return `${prefix}_${Date.now()}_${randomId()}`;
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

async function safeQueryFirst(collectionName, where = {}) {
  try {
    const result = await db.collection(collectionName).where(where).limit(1).get();
    const list = (result && result.data) || [];
    return list[0] || null;
  } catch (err) {
    return null;
  }
}

function resolveListingId(payload = {}) {
  return normalizeText(
    payload.listing_id || payload.houseId || payload.house_id || payload.id
  );
}

function attachHouseAliases(listing) {
  if (!listing || typeof listing !== "object") {
    return null;
  }

  const listingId = resolveListingId(listing);
  return {
    ...listing,
    listing_id: listingId,
    houseId: listingId
  };
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
        object_type: "listing_data_gateway",
        object_id: normalizeText(objectId || traceId),
        detail_json: detailJson,
        created_at: new Date().toISOString()
      }
    });
  } catch (err) {
    // Best-effort logging only.
  }
}

async function syncListingImportJob(job) {
  const jobId = normalizeText(job && job.job_id);
  if (!jobId) {
    throw new Error("listing_import_jobs missing job_id");
  }

  const now = new Date().toISOString();
  const next = {
    ...(job || {}),
    job_id: jobId,
    updated_at: normalizeText((job && job.updated_at) || now)
  };

  if (!next.created_at) {
    next.created_at = next.updated_at;
  }

  await db.collection(COLLECTIONS.LISTING_IMPORT_JOBS).doc(jobId).set({
    data: next
  });

  return next;
}

async function syncListing(listing) {
  const listingId = resolveListingId(listing || {});
  if (!listingId) {
    throw new Error("listings missing listing_id");
  }

  const now = new Date().toISOString();
  const existing = await getListing(listingId);
  const next = {
    ...(existing || {}),
    ...(listing || {}),
    listing_id: listingId,
    updated_at: normalizeText((listing && listing.updated_at) || now)
  };

  if (!next.created_at) {
    next.created_at = (existing && existing.created_at) || next.updated_at;
  }

  await db.collection(COLLECTIONS.LISTINGS).doc(listingId).set({
    data: next
  });

  return attachHouseAliases(next);
}

exports.main = async (event = {}, context = {}) => {
  const traceId = createTraceId("listing_data");
  const action = normalizeText(event.action).toLowerCase();
  const userId = normalizeText(event.user_id || event.uid || context.OPENID);

  try {
    if (action === "sync_listing_import_job") {
      const job = await syncListingImportJob(event.job || {});
      await writeActivityLog({
        traceId,
        actionType: "listing_data_sync_import_job",
        userId,
        objectId: job.job_id
      });
      return {
        ok: true,
        trace_id: traceId,
        action,
        data: job
      };
    }

    if (action === "sync_listing") {
      const listing = await syncListing(event.listing || {});
      await writeActivityLog({
        traceId,
        actionType: "listing_data_sync_listing",
        userId,
        objectId: listing && listing.listing_id
      });
      return {
        ok: true,
        trace_id: traceId,
        action,
        data: listing
      };
    }

    if (action === "get_listing") {
      const listingId = resolveListingId(event);
      const listing = await getListing(listingId);
      return {
        ok: true,
        trace_id: traceId,
        action,
        data: attachHouseAliases(listing),
        listing_id: listingId,
        houseId: listingId
      };
    }

    if (action === "update_listing") {
      const listingId = resolveListingId(event);
      const existing = await getListing(listingId);
      if (!existing) {
        return {
          ok: false,
          trace_id: traceId,
          code: "LISTING_NOT_FOUND",
          message: "listing not found"
        };
      }

      const patch = event.patch && typeof event.patch === "object" ? event.patch : {};
      const updated = await syncListing({
        ...existing,
        ...patch,
        listing_id: listingId
      });

      await writeActivityLog({
        traceId,
        actionType: "listing_data_update_listing",
        userId,
        objectId: listingId
      });

      return {
        ok: true,
        trace_id: traceId,
        action,
        data: updated
      };
    }

    if (action === "delete_listing") {
      const listingId = resolveListingId(event);
      if (!listingId) {
        return {
          ok: false,
          trace_id: traceId,
          code: "LISTING_ID_REQUIRED",
          message: "listing_id is required"
        };
      }

      await db.collection(COLLECTIONS.LISTINGS).doc(listingId).remove();
      await db.collection(COLLECTIONS.FAVORITES).where({
        listing_id: listingId
      }).remove();

      await writeActivityLog({
        traceId,
        actionType: "listing_data_delete_listing",
        userId,
        objectId: listingId
      });

      return {
        ok: true,
        trace_id: traceId,
        action,
        listing_id: listingId,
        houseId: listingId
      };
    }

    if (action === "set_listing_sold") {
      const listingId = resolveListingId(event);
      const existing = await getListing(listingId);
      if (!existing) {
        return {
          ok: false,
          trace_id: traceId,
          code: "LISTING_NOT_FOUND",
          message: "listing not found"
        };
      }

      const isSold = Boolean(event.is_sold || event.isSold);
      const nextStatus = isSold ? "sold" : "active";
      const updated = await syncListing({
        ...existing,
        listing_id: listingId,
        status: nextStatus
      });

      await writeActivityLog({
        traceId,
        actionType: "listing_data_set_listing_sold",
        userId,
        objectId: listingId,
        detailJson: {
          status: nextStatus
        }
      });

      return {
        ok: true,
        trace_id: traceId,
        action,
        status: nextStatus,
        data: updated
      };
    }

    return {
      ok: false,
      trace_id: traceId,
      code: "UNSUPPORTED_ACTION",
      message: `unsupported action: ${action || "(empty)"}`
    };
  } catch (err) {
    console.error("[listingDataGateway] execution failed", {
      trace_id: traceId,
      action,
      user_id: userId,
      message: normalizeText(err && (err.message || err.errMsg)),
      stack: normalizeText(err && err.stack)
    });

    return {
      ok: false,
      trace_id: traceId,
      code: "LISTING_DATA_GATEWAY_FAILED",
      message: "listing data gateway execution failed",
      details: normalizeText(err && (err.message || err.errMsg))
    };
  }
};
