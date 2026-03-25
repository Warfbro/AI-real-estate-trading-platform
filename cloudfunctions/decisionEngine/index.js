let cloud = null;
try {
  cloud = require("wx-server-sdk");
  cloud.init({
    env: cloud.DYNAMIC_CURRENT_ENV
  });
} catch (err) {
  cloud = null;
}

const { createStateStore } = require("./lib/stateStore");
const { filterFeasibleListings } = require("./lib/feasibilityEngine");
const { createInitialDecisionState, applyPairwise, applyCritique } = require("./lib/preferenceUpdater");
const { rankListings } = require("./lib/decisionRanker");
const { planRelaxation } = require("./lib/relaxationPlanner");
const { sanitizeListing, getFeatureValues, buildStats } = require("./lib/featureExtractor");

const db = cloud ? cloud.database() : null;
const COLLECTIONS = {
  ACTIVITY_LOGS: "activity_logs"
};

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function sanitizeStringArray(value, limit = 20) {
  const source = Array.isArray(value) ? value : [value];
  const list = [];
  source.forEach((item) => {
    const text = normalizeText(item);
    if (text && !list.includes(text) && list.length < limit) {
      list.push(text);
    }
  });
  return list;
}

function createTraceId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildErrorResult({ code, message, traceId, details = null, action = "" }) {
  return {
    success: false,
    data: null,
    error: {
      code,
      message,
      details
    },
    meta: {
      trace_id: traceId,
      action
    }
  };
}

function buildSuccessResult(data, traceId, action) {
  return {
    success: true,
    data,
    error: null,
    meta: {
      trace_id: traceId,
      action
    }
  };
}

async function writeActivityLog({ traceId, action, userId, detailJson = {} }) {
  if (!db) {
    return;
  }
  try {
    await db.collection(COLLECTIONS.ACTIVITY_LOGS).add({
      data: {
        log_id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        actor_type: userId ? "user" : "system",
        actor_id: normalizeText(userId),
        action_type: `decision_engine_${action}`,
        object_type: "decision_session",
        object_id: traceId,
        detail_json: detailJson,
        created_at: new Date().toISOString()
      }
    });
  } catch (err) {
    // Best effort logging.
  }
}

function pickCandidatePool(allListings, selectedListingIds) {
  const safeListings = (Array.isArray(allListings) ? allListings : [])
    .map((item) => sanitizeListing(item))
    .filter(Boolean);
  const selectedSet = new Set(sanitizeStringArray(selectedListingIds));
  const selectedListings = safeListings.filter((item) => selectedSet.has(item.listing_id));
  if (selectedListings.length >= 2) {
    return selectedListings;
  }
  if (safeListings.length >= 2) {
    return safeListings;
  }
  return selectedListings.length ? selectedListings : safeListings;
}

function buildView(session, ranked, feasibility, relaxationOptions, currentStage) {
  return {
    decision_session_id: session.decision_session_id,
    current_stage: currentStage,
    selected_listing_ids: session.selected_listing_ids || [],
    candidate_listing_ids: session.candidate_listing_ids || [],
    candidate_buckets: ranked.buckets,
    top_listing_ids: ranked.topListingIds,
    next_pairwise_question: ranked.nextPairwiseQuestion,
    blockers: feasibility.blockers,
    relaxation_options: relaxationOptions
  };
}

function determineStage({ feasibleCount, pairwiseQuestion, relaxationOptions }) {
  if (feasibleCount <= 0 && relaxationOptions.length) {
    return "relaxation";
  }
  if (pairwiseQuestion) {
    return "pairwise";
  }
  if (feasibleCount > 0) {
    return "ranking";
  }
  return "clarifying";
}

function rebuildDecisionResult(candidatePool, state) {
  const feasibility = filterFeasibleListings(candidatePool, state.hard_constraints || {});
  const ranked = rankListings(feasibility.feasibleListings, state);
  if (!ranked.nextPairwiseQuestion && Array.isArray(candidatePool) && candidatePool.length >= 2) {
    ranked.nextPairwiseQuestion = rankListings(candidatePool, state).nextPairwiseQuestion;
  }
  const relaxationOptions = planRelaxation({
    candidatePool,
    hardConstraints: state.hard_constraints || {},
    currentFeasibleCount: feasibility.feasibleCount
  });
  const currentStage = determineStage({
    feasibleCount: feasibility.feasibleCount,
    pairwiseQuestion: ranked.nextPairwiseQuestion,
    relaxationOptions
  });

  return {
    feasibility,
    ranked,
    relaxationOptions,
    currentStage
  };
}

function getPairwiseFeatureValues(candidatePool, state, winnerListingId, loserListingId) {
  const stats = buildStats(candidatePool);
  const findListing = (listingId) =>
    (candidatePool || []).find((item) => normalizeText(item.listing_id) === normalizeText(listingId));
  const winner = findListing(winnerListingId);
  const loser = findListing(loserListingId);

  return {
    winnerValues: winner
      ? getFeatureValues(winner, { hardConstraints: state.hard_constraints || {}, stats })
      : {},
    loserValues: loser
      ? getFeatureValues(loser, { hardConstraints: state.hard_constraints || {}, stats })
      : {}
  };
}

exports.main = async (event = {}, context = {}) => {
  const action = normalizeText(event.action).toLowerCase();
  const traceId = createTraceId("decision");
  const userId = normalizeText(event.user_id || context.OPENID);
  const store = createStateStore({ db });

  if (!action) {
    return buildErrorResult({
      code: "DECISION_ACTION_REQUIRED",
      message: "action is required",
      traceId
    });
  }

  try {
    if (action === "start") {
      const chatSessionId = normalizeText(event.chat_session_id);
      const selectedListingIds = sanitizeStringArray(event.selected_listing_ids, 20);
      const localListings = Array.isArray(event.local_listings) ? event.local_listings : [];
      const allListings = await store.listActiveListings({
        userId,
        localListings
      });
      const candidatePool = pickCandidatePool(allListings, selectedListingIds);

      if (!candidatePool.length) {
        return buildErrorResult({
          code: "DECISION_NO_LISTINGS",
          message: "no active listings available for decision",
          traceId,
          action
        });
      }

      const state = createInitialDecisionState(event.context || {}, selectedListingIds);
      const computed = rebuildDecisionResult(candidatePool, state);
      const now = new Date().toISOString();
      const session = {
        decision_session_id: createTraceId("decision_session"),
        user_id: userId,
        chat_session_id: chatSessionId,
        intake_id: normalizeText((event.context && event.context.active_intake && event.context.active_intake.intake_id) || ""),
        status: "active",
        current_stage: computed.currentStage,
        selected_listing_ids: selectedListingIds,
        candidate_listing_ids: candidatePool.map((item) => item.listing_id),
        state_json: {
          ...state,
          blockers: computed.feasibility.blockers.map((item) => item.code)
        },
        result_json: {
          buckets: computed.ranked.buckets,
          top_listing_ids: computed.ranked.topListingIds,
          relaxation_options: computed.relaxationOptions
        },
        created_at: now,
        updated_at: now
      };

      await store.saveSession(session);
      await writeActivityLog({
        traceId,
        action,
        userId,
        detailJson: {
          decision_session_id: session.decision_session_id,
          selected_listing_count: selectedListingIds.length,
          candidate_listing_count: candidatePool.length
        }
      });

      return buildSuccessResult(
        buildView(session, computed.ranked, computed.feasibility, computed.relaxationOptions, computed.currentStage),
        traceId,
        action
      );
    }

    const decisionSessionId = normalizeText(event.decision_session_id);
    const session = await store.getSession(decisionSessionId);
    if (!session) {
      return buildErrorResult({
        code: "DECISION_SESSION_NOT_FOUND",
        message: "decision session not found",
        traceId,
        action
      });
    }

    const localListings = Array.isArray(event.local_listings) ? event.local_listings : [];
    const allListings = await store.listActiveListings({
      userId: normalizeText(session.user_id, userId),
      localListings
    });
    const candidatePool = pickCandidatePool(allListings, session.candidate_listing_ids || []);
    let state = session.state_json || createInitialDecisionState({}, session.selected_listing_ids || []);

    if (action === "pairwise") {
      const winnerListingId = normalizeText(event.winner_listing_id);
      const loserListingId = normalizeText(event.loser_listing_id);
      if (!winnerListingId || !loserListingId || winnerListingId === loserListingId) {
        return buildErrorResult({
          code: "DECISION_INVALID_PAIRWISE",
          message: "winner_listing_id and loser_listing_id are required",
          traceId,
          action
        });
      }

      const pairwiseValues = getPairwiseFeatureValues(candidatePool, state, winnerListingId, loserListingId);
      state = applyPairwise(state, {
        winnerListingId,
        loserListingId,
        winnerValues: pairwiseValues.winnerValues,
        loserValues: pairwiseValues.loserValues
      });
    } else if (action === "critique") {
      const text = normalizeText(event.text);
      if (!text) {
        return buildErrorResult({
          code: "DECISION_INVALID_CRITIQUE",
          message: "text is required",
          traceId,
          action
        });
      }
      state = applyCritique(state, text).state;
    } else if (action !== "state" && action !== "relax") {
      return buildErrorResult({
        code: "DECISION_ACTION_UNSUPPORTED",
        message: "unsupported action",
        traceId,
        action
      });
    }

    const computed = rebuildDecisionResult(candidatePool, state);
    const nextSession = {
      ...session,
      current_stage: computed.currentStage,
      state_json: {
        ...state,
        blockers: computed.feasibility.blockers.map((item) => item.code)
      },
      result_json: {
        buckets: computed.ranked.buckets,
        top_listing_ids: computed.ranked.topListingIds,
        relaxation_options: computed.relaxationOptions
      },
      updated_at: new Date().toISOString()
    };

    await store.saveSession(nextSession);
    await writeActivityLog({
      traceId,
      action,
      userId: normalizeText(nextSession.user_id, userId),
      detailJson: {
        decision_session_id: nextSession.decision_session_id,
        candidate_listing_count: candidatePool.length,
        feasible_count: computed.feasibility.feasibleCount
      }
    });

    return buildSuccessResult(
      buildView(nextSession, computed.ranked, computed.feasibility, computed.relaxationOptions, computed.currentStage),
      traceId,
      action
    );
  } catch (err) {
    console.error("[decisionEngine] execution failed", {
      trace_id: traceId,
      action,
      user_id: userId,
      message: normalizeText(err && (err.message || err.errMsg)),
      stack: normalizeText(err && err.stack)
    });
    return buildErrorResult({
      code: "DECISION_ENGINE_FAILED",
      message: "decision engine execution failed",
      traceId,
      details: normalizeText(err && (err.message || err.errMsg)),
      action
    });
  }
};
