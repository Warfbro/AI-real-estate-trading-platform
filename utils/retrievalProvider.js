/**
 * utils/retrievalProvider.js - 检索层 Provider 抽象
 *
 * 职责：
 * 1) 提供统一的检索接口
 * 2) 支持规则检索、向量检索、混合检索
 * 3) 返回 candidates + evidence
 *
 * 数据流：
 * 查询请求 -> retrievalProvider -> 候选 + 证据
 */

const { listingRepo } = require("../repos/index");

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function toNumber(value) {
  if (value == null) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * 检索策略枚举
 */
const RETRIEVAL_STRATEGIES = {
  RULES: "rules",
  VECTOR: "vector",
  HYBRID: "hybrid"
};

/**
 * 规则检索 - 基于硬约束过滤
 */
function searchByRules(listings, filters = {}, options = {}) {
  let candidates = Array.isArray(listings) ? [...listings] : [];
  const evidence = [];

  // 城市过滤
  if (filters.city) {
    const cityLower = normalizeText(filters.city).toLowerCase();
    candidates = candidates.filter((item) =>
      normalizeText(item.city).toLowerCase().includes(cityLower)
    );
    evidence.push({ type: "filter", field: "city", value: filters.city });
  }

  // 区域过滤
  if (filters.district) {
    const districtLower = normalizeText(filters.district).toLowerCase();
    candidates = candidates.filter((item) =>
      normalizeText(item.district).toLowerCase().includes(districtLower)
    );
    evidence.push({ type: "filter", field: "district", value: filters.district });
  }

  // 价格范围过滤
  if (filters.budget_min != null || filters.budget_max != null) {
    const min = toNumber(filters.budget_min);
    const max = toNumber(filters.budget_max);
    candidates = candidates.filter((item) => {
      const price = toNumber(item.price_total);
      if (price == null) return false;
      if (min != null && price < min) return false;
      if (max != null && price > max) return false;
      return true;
    });
    evidence.push({ type: "filter", field: "budget", min, max });
  }

  // 面积范围过滤
  if (filters.area_min != null || filters.area_max != null) {
    const min = toNumber(filters.area_min);
    const max = toNumber(filters.area_max);
    candidates = candidates.filter((item) => {
      const area = toNumber(item.area_sqm || item.area);
      if (area == null) return false;
      if (min != null && area < min) return false;
      if (max != null && area > max) return false;
      return true;
    });
    evidence.push({ type: "filter", field: "area", min, max });
  }

  // 户型过滤
  if (filters.layout) {
    const layoutLower = normalizeText(filters.layout).toLowerCase();
    candidates = candidates.filter((item) =>
      normalizeText(item.layout || item.layout_pref).toLowerCase().includes(layoutLower)
    );
    evidence.push({ type: "filter", field: "layout", value: filters.layout });
  }

  // 关键词搜索
  if (filters.keyword) {
    const kwLower = normalizeText(filters.keyword).toLowerCase();
    candidates = candidates.filter((item) =>
      normalizeText(item.title).toLowerCase().includes(kwLower) ||
      normalizeText(item.community_name || item.community).toLowerCase().includes(kwLower) ||
      normalizeText(item.raw_text).toLowerCase().includes(kwLower)
    );
    evidence.push({ type: "search", field: "keyword", value: filters.keyword });
  }

  // 排序
  if (options.sortBy) {
    const sortField = options.sortBy;
    const sortOrder = options.sortOrder === "desc" ? -1 : 1;
    candidates.sort((a, b) => {
      const aVal = toNumber(a[sortField]) || 0;
      const bVal = toNumber(b[sortField]) || 0;
      return (aVal - bVal) * sortOrder;
    });
    evidence.push({ type: "sort", field: sortField, order: options.sortOrder || "asc" });
  }

  // 限制数量
  const limit = toNumber(options.limit) || 20;
  if (candidates.length > limit) {
    candidates = candidates.slice(0, limit);
    evidence.push({ type: "limit", value: limit });
  }

  return {
    candidates,
    evidence,
    total: candidates.length,
    strategy: RETRIEVAL_STRATEGIES.RULES
  };
}

/**
 * 向量检索 - 当前为占位实现，后续接入真正的向量库
 */
function searchByVector(query, filters = {}, options = {}) {
  // 当前阶段：返回空结果，向量检索能力后续接入
  return {
    candidates: [],
    evidence: [{ type: "vector_search", status: "not_implemented" }],
    total: 0,
    strategy: RETRIEVAL_STRATEGIES.VECTOR
  };
}

/**
 * 混合检索 - 合并规则检索和向量检索结果
 */
function mergeSearchResults(ruleResult, vectorResult, options = {}) {
  const limit = toNumber(options.limit) || 20;
  const candidates = [];
  const seen = new Set();

  // 优先添加规则检索结果
  (ruleResult.candidates || []).forEach((item) => {
    const id = normalizeText(item.listing_id);
    if (id && !seen.has(id)) {
      seen.add(id);
      candidates.push({ ...item, source: "rules" });
    }
  });

  // 添加向量检索结果（去重）
  (vectorResult.candidates || []).forEach((item) => {
    const id = normalizeText(item.listing_id);
    if (id && !seen.has(id)) {
      seen.add(id);
      candidates.push({ ...item, source: "vector" });
    }
  });

  return {
    candidates: candidates.slice(0, limit),
    evidence: [
      ...(ruleResult.evidence || []),
      ...(vectorResult.evidence || [])
    ],
    total: candidates.length,
    strategy: RETRIEVAL_STRATEGIES.HYBRID
  };
}

/**
 * 重排候选 - 根据偏好状态调整排序
 */
function rerankCandidates(candidates, preferenceState = {}) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return { candidates: [], reranked: false };
  }

  const scored = candidates.map((item) => {
    let score = 0;

    // 基于偏好权重计算分数
    if (preferenceState.soft_preferences) {
      const prefs = preferenceState.soft_preferences;

      // 区域偏好
      if (prefs.district_priority && item.district) {
        const districtPriority = prefs.district_priority[item.district];
        if (districtPriority != null) {
          score += districtPriority * 10;
        }
      }

      // 价格偏好（偏向更低价格）
      if (prefs.price_sensitivity != null && item.price_total != null) {
        score -= item.price_total * prefs.price_sensitivity * 0.01;
      }

      // 面积偏好
      if (prefs.area_preference != null && item.area_sqm != null) {
        const areaDiff = Math.abs(item.area_sqm - prefs.area_preference);
        score -= areaDiff * 0.1;
      }
    }

    return { ...item, _score: score };
  });

  // 按分数排序
  scored.sort((a, b) => b._score - a._score);

  // 移除内部分数字段
  const result = scored.map((item) => {
    const next = { ...item };
    delete next._score;
    return next;
  });

  return { candidates: result, reranked: true };
}

/**
 * 创建检索服务实例
 */
function createRetrievalProvider(options = {}) {
  return {
    /**
     * 执行检索
     */
    async search({ query = "", filters = {}, options: searchOptions = {} } = {}) {
      // 获取本地房源
      const listingResult = listingRepo.getListings({ includeInactive: false });
      const allListings = listingResult && listingResult.status === "success"
        ? listingResult.data
        : [];

      // 执行规则检索
      const ruleResult = searchByRules(allListings, filters, searchOptions);

      // 执行向量检索（当前为占位）
      const vectorResult = searchByVector(query, filters, searchOptions);

      // 合并结果
      const merged = mergeSearchResults(ruleResult, vectorResult, searchOptions);

      return merged;
    },

    /**
     * 重排候选
     */
    rerank(candidates, preferenceState) {
      return rerankCandidates(candidates, preferenceState);
    },

    /**
     * 规则检索
     */
    searchByRules,

    /**
     * 向量检索（占位）
     */
    searchByVector,

    /**
     * 合并结果
     */
    mergeResults: mergeSearchResults
  };
}

module.exports = {
  RETRIEVAL_STRATEGIES,
  searchByRules,
  searchByVector,
  mergeSearchResults,
  rerankCandidates,
  createRetrievalProvider
};
