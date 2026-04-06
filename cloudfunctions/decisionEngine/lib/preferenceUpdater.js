function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function toNumber(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "string" && !value.trim()) {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function clampWeight(value) {
  if (value > 6) return 6;
  if (value < -3) return -3;
  return Number(value.toFixed(4));
}

function sanitizeStringArray(value, limit = 10) {
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

function normalizeDecisionContext(context = {}) {
  const activeIntake = context.active_intake || context.previous_understanding || {};
  const memoryProfile = context.memory_profile || {};
  const activeRequirement = context.active_requirement || {};
  return {
    activeIntake: activeIntake && typeof activeIntake === "object" ? activeIntake : {},
    memoryProfile: memoryProfile && typeof memoryProfile === "object" ? memoryProfile : {},
    activeRequirement: activeRequirement && typeof activeRequirement === "object" ? activeRequirement : {}
  };
}

function createInitialDecisionState(context = {}, selectedListingIds = []) {
  const normalized = normalizeDecisionContext(context);
  const activeIntake = normalized.activeIntake;
  const memoryProfile = normalized.memoryProfile;
  const activeRequirement = normalized.activeRequirement;
  const targetArea = sanitizeStringArray(activeRequirement.target_area || activeRequirement.district || []);
  const profileDistrict = sanitizeStringArray(memoryProfile.district || []);
  const useHistoricalConstraints = context.use_historical_constraints !== false;

  return {
    hard_constraints: {
      city: useHistoricalConstraints ? normalizeText(activeIntake.city || memoryProfile.city) : "",
      district: useHistoricalConstraints ? (targetArea.length ? targetArea : profileDistrict) : [],
      budget_min: useHistoricalConstraints ? toNumber(activeIntake.budget_min || memoryProfile.budget_min) : null,
      budget_max: useHistoricalConstraints ? toNumber(activeIntake.budget_max || memoryProfile.budget_max) : null,
      area_min: useHistoricalConstraints ? toNumber(activeIntake.area_min) : null,
      elevator_required: useHistoricalConstraints ? Boolean(memoryProfile.elevator_required) : false,
      layout_pref: useHistoricalConstraints ? normalizeText(memoryProfile.preferred_layout || activeIntake.layout_pref) : ""
    },
    soft_weights: {
      price: 2.4,
      area: 1.8,
      elevator: 1.1,
      district_match: 1.4,
      layout: 1,
      data_completeness: 0.8
    },
    pairwise_memory: [],
    critique_memory: [],
    blockers: [],
    selected_listing_ids: sanitizeStringArray(selectedListingIds, 20)
  };
}

function applyPairwise(state, { winnerListingId, loserListingId, winnerValues = {}, loserValues = {} }) {
  const safeState = state && typeof state === "object" ? state : createInitialDecisionState();
  const next = {
    ...safeState,
    soft_weights: {
      ...(safeState.soft_weights || {})
    },
    pairwise_memory: Array.isArray(safeState.pairwise_memory) ? safeState.pairwise_memory.slice() : []
  };

  Object.keys(next.soft_weights).forEach((key) => {
    const diff = Number(winnerValues[key] || 0) - Number(loserValues[key] || 0);
    next.soft_weights[key] = clampWeight(Number(next.soft_weights[key] || 0) + diff * 0.9);
  });

  next.pairwise_memory.push({
    winner_listing_id: normalizeText(winnerListingId),
    loser_listing_id: normalizeText(loserListingId),
    created_at: new Date().toISOString()
  });
  return next;
}

function parseCritique(text) {
  const content = normalizeText(text);
  const tags = [];
  const updates = {
    hard_constraints: {},
    soft_weights: {}
  };

  if (!content) {
    return { tags, updates };
  }

  if (/(贵|预算高|太高|超预算)/.test(content)) {
    tags.push("price");
    updates.soft_weights.price = 1;
  }
  if (/(远|区域.*(不合适|不行|不好)|位置.*(不好|不行)|太远)/.test(content)) {
    tags.push("district");
    updates.soft_weights.district_match = 1;
  }
  if (/(没电梯|楼梯房|不要楼梯|需要电梯|电梯房)/.test(content)) {
    tags.push("elevator");
    updates.hard_constraints.elevator_required = true;
    updates.soft_weights.elevator = 1.2;
  }
  if (/(太小|面积小|面积不够)/.test(content)) {
    tags.push("area");
    updates.soft_weights.area = 1;
  }
  if (/(户型不好|户型不喜欢|格局不好)/.test(content)) {
    tags.push("layout");
    updates.soft_weights.layout = 1;
  }

  return { tags, updates };
}

function applyCritique(state, text) {
  const safeState = state && typeof state === "object" ? state : createInitialDecisionState();
  const parsed = parseCritique(text);
  const next = {
    ...safeState,
    hard_constraints: {
      ...(safeState.hard_constraints || {}),
      ...(parsed.updates.hard_constraints || {})
    },
    soft_weights: {
      ...(safeState.soft_weights || {})
    },
    critique_memory: Array.isArray(safeState.critique_memory) ? safeState.critique_memory.slice() : [],
    blockers: Array.isArray(safeState.blockers) ? safeState.blockers.slice() : []
  };

  Object.keys(parsed.updates.soft_weights || {}).forEach((key) => {
    next.soft_weights[key] = clampWeight(
      Number(next.soft_weights[key] || 0) + Number(parsed.updates.soft_weights[key] || 0)
    );
  });

  next.critique_memory.push({
    text: normalizeText(text),
    tags: parsed.tags,
    created_at: new Date().toISOString()
  });

  if (parsed.tags.length) {
    next.blockers = Array.from(new Set(next.blockers.concat(parsed.tags)));
  }

  return {
    state: next,
    parsed
  };
}

module.exports = {
  createInitialDecisionState,
  applyPairwise,
  applyCritique,
  normalizeDecisionContext
};
