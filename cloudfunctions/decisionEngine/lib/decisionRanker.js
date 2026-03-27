const { buildStats, getFeatureValues, sanitizeListing } = require("./featureExtractor");

function getSoftWeight(state, key, fallback = 0) {
  return Number(
    state && state.soft_weights && state.soft_weights[key] != null ? state.soft_weights[key] : fallback
  );
}

function buildScoreBreakdown(values, state) {
  return {
    price: Number((values.price * getSoftWeight(state, "price")).toFixed(4)),
    area: Number((values.area * getSoftWeight(state, "area")).toFixed(4)),
    elevator: Number((values.elevator * getSoftWeight(state, "elevator")).toFixed(4)),
    district_match: Number((values.district_match * getSoftWeight(state, "district_match")).toFixed(4)),
    layout: Number((values.layout * getSoftWeight(state, "layout")).toFixed(4)),
    data_completeness: Number(
      (values.data_completeness * getSoftWeight(state, "data_completeness")).toFixed(4)
    )
  };
}

function toCompositeScore(breakdown) {
  return Object.keys(breakdown).reduce((sum, key) => sum + Number(breakdown[key] || 0), 0);
}

function sortByKey(list, key) {
  return list.slice().sort((a, b) => Number(b[key] || 0) - Number(a[key] || 0));
}

function makeCardItem(item, bucketLabel) {
  return {
    listing_id: item.listing_id,
    title: item.title,
    city: item.city,
    district: item.district,
    community_name: item.community_name,
    price_total: item.price_total,
    area_sqm: item.area_sqm,
    layout_desc: item.layout_desc,
    elevator_flag: item.elevator_flag,
    missing_fields_json: item.missing_fields_json,
    score: Number(item.composite_score.toFixed(2)),
    bucket_label: bucketLabel
  };
}

function pickUnique(sorted, usedIds) {
  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i];
    if (!usedIds.has(current.listing_id)) {
      usedIds.add(current.listing_id);
      return current;
    }
  }
  return null;
}

function buildPairwiseQuestion(scoredListings, pairwiseMemory = []) {
  const seen = new Set(
    (Array.isArray(pairwiseMemory) ? pairwiseMemory : []).map((item) =>
      [item.winner_listing_id, item.loser_listing_id].filter(Boolean).sort().join("::")
    )
  );
  const safe = Array.isArray(scoredListings) ? scoredListings : [];
  for (let i = 0; i < safe.length; i += 1) {
    for (let j = i + 1; j < safe.length; j += 1) {
      const key = [safe[i].listing_id, safe[j].listing_id].sort().join("::");
      if (!seen.has(key)) {
        return {
          prompt: "杩欎袱濂楁埧閲岋紝浣犵幇鍦ㄦ洿鍊惧悜鍝竴濂楋紵",
          left: makeCardItem(safe[i], "left"),
          right: makeCardItem(safe[j], "right")
        };
      }
    }
  }
  return null;
}

function rankListings(listings, state = {}) {
  const safeListings = (Array.isArray(listings) ? listings : [])
    .map((item) => sanitizeListing(item))
    .filter(Boolean);
  const stats = buildStats(safeListings);

  const scored = safeListings.map((item) => {
    const featureValues = getFeatureValues(item, {
      hardConstraints: state.hard_constraints || {},
      stats
    });
    const scoreBreakdown = buildScoreBreakdown(featureValues, state);
    const compositeScore = toCompositeScore(scoreBreakdown);
    const stableScore = compositeScore + featureValues.data_completeness * 1.2 + featureValues.affordability * 0.6;
    const valueScore = compositeScore + featureValues.affordability * 1.6;

    return {
      ...item,
      feature_values: featureValues,
      score_breakdown: scoreBreakdown,
      composite_score: compositeScore,
      stable_score: stableScore,
      balanced_score: compositeScore,
      value_score: valueScore
    };
  });

  const used = new Set();
  const stable = pickUnique(sortByKey(scored, "stable_score"), used);
  const balanced = pickUnique(sortByKey(scored, "balanced_score"), used);
  const value = pickUnique(sortByKey(scored, "value_score"), used);
  const rankedByComposite = sortByKey(scored, "composite_score");
  const topListingIds = rankedByComposite.slice(0, 5).map((item) => item.listing_id);

  return {
    scoredListings: rankedByComposite,
    buckets: {
      stable: stable ? [makeCardItem(stable, "stable")] : [],
      balanced: balanced ? [makeCardItem(balanced, "balanced")] : [],
      value: value ? [makeCardItem(value, "value")] : []
    },
    topListingIds,
    nextPairwiseQuestion: buildPairwiseQuestion(rankedByComposite, state.pairwise_memory)
  };
}

module.exports = {
  rankListings
};
