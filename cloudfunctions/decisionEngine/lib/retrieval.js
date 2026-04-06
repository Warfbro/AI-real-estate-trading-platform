/**
 * cloudfunctions/decisionEngine/lib/retrieval.js - 检索层
 *
 * 职责：
 * 1) 根据 intake / memory / selected listings / critique 等生成检索条件
 * 2) 调用检索层
 * 3) 返回 candidates + evidence
 *
 * 数据流：
 * state + context -> retrieval.search() -> candidates + evidence
 */

const { filterFeasibleListings } = require("./feasibilityEngine");
const { rankListings } = require("./decisionRanker");
const { planRelaxation } = require("./relaxationPlanner");
const { sanitizeListing, getFeatureValues, buildStats } = require("./featureExtractor");

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

/**
 * 构建候选池
 * 优先使用已选房源，否则使用全部房源
 */
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

/**
 * 执行检索并返回候选结果
 */
function searchCandidates(candidatePool, state) {
  const hardConstraints = state.hard_constraints || {};
  const feasibility = filterFeasibleListings(candidatePool, hardConstraints);
  const ranked = rankListings(feasibility.feasibleListings, state);
  const relaxationOptions = planRelaxation({
    candidatePool,
    hardConstraints,
    currentFeasibleCount: feasibility.feasibleCount
  });

  return {
    feasibility,
    ranked,
    relaxationOptions,
    evidence: buildEvidence(feasibility, ranked)
  };
}

/**
 * 构建证据列表（用于解释为什么推荐这些候选）
 */
function buildEvidence(feasibility, ranked) {
  const evidence = [];

  // 添加可行性证据
  if (feasibility.feasibleCount > 0) {
    evidence.push({
      type: "feasibility",
      message: `共 ${feasibility.feasibleCount} 套房源满足硬约束条件`
    });
  }

  // 添加阻塞证据
  if (feasibility.blockers && feasibility.blockers.length) {
    feasibility.blockers.forEach((blocker) => {
      evidence.push({
        type: "blocker",
        code: blocker.code,
        message: blocker.message
      });
    });
  }

  // 添加排序证据
  if (ranked.topListingIds && ranked.topListingIds.length) {
    evidence.push({
      type: "ranking",
      message: `推荐排名前 ${ranked.topListingIds.length} 套房源`
    });
  }

  return evidence;
}

/**
 * 获取二选一的特征值
 */
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

/**
 * 创建检索服务实例
 */
function createRetrievalService(options = {}) {
  const { store = null } = options;

  return {
    /**
     * 获取所有活跃房源
     */
    async listActiveListings({ userId, localListings = [] }) {
      if (store && store.listActiveListings) {
        return store.listActiveListings({ userId, localListings });
      }
      return Array.isArray(localListings) ? localListings : [];
    },

    /**
     * 构建候选池
     */
    buildCandidatePool(allListings, selectedListingIds) {
      return pickCandidatePool(allListings, selectedListingIds);
    },

    /**
     * 执行检索
     */
    search(candidatePool, state) {
      return searchCandidates(candidatePool, state);
    },

    /**
     * 获取二选一特征值
     */
    getPairwiseValues(candidatePool, state, winnerListingId, loserListingId) {
      return getPairwiseFeatureValues(candidatePool, state, winnerListingId, loserListingId);
    }
  };
}

module.exports = {
  pickCandidatePool,
  searchCandidates,
  buildEvidence,
  getPairwiseFeatureValues,
  createRetrievalService
};
