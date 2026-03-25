const { filterFeasibleListings } = require("./feasibilityEngine");

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function cloneConstraints(hardConstraints = {}) {
  return {
    ...hardConstraints,
    district: Array.isArray(hardConstraints.district) ? hardConstraints.district.slice() : hardConstraints.district
  };
}

function planRelaxation({ candidatePool = [], hardConstraints = {}, currentFeasibleCount = 0 }) {
  const suggestions = [];
  const budgetMax = toNumber(hardConstraints.budget_max);
  const areaMin = toNumber(hardConstraints.area_min);
  const districtList = Array.isArray(hardConstraints.district) ? hardConstraints.district.filter(Boolean) : [];

  const candidates = [];
  if (budgetMax != null) {
    candidates.push({
      code: "budget_max_plus_20",
      label: "预算上限上调 20 万",
      mutate(next) {
        next.budget_max = budgetMax + 20;
      }
    });
  }
  if (Boolean(hardConstraints.elevator_required)) {
    candidates.push({
      code: "drop_elevator_hard_constraint",
      label: "电梯从硬要求降为偏好",
      mutate(next) {
        next.elevator_required = false;
      }
    });
  }
  if (districtList.length) {
    candidates.push({
      code: "expand_district",
      label: "放宽区域限制",
      mutate(next) {
        next.district = [];
      }
    });
  }
  if (areaMin != null) {
    candidates.push({
      code: "area_min_minus_10",
      label: "面积下限下调 10㎡",
      mutate(next) {
        next.area_min = Math.max(0, areaMin - 10);
      }
    });
  }

  candidates.forEach((item) => {
    const nextConstraints = cloneConstraints(hardConstraints);
    item.mutate(nextConstraints);
    const feasible = filterFeasibleListings(candidatePool, nextConstraints);
    const gain = feasible.feasibleCount - currentFeasibleCount;
    if (gain > 0 || currentFeasibleCount === 0) {
      suggestions.push({
        code: item.code,
        label: item.label,
        estimated_gain: gain,
        reason: gain > 0 ? `预计可新增 ${gain} 套可行房源` : "当前可行房源较少，建议作为下一步探索"
      });
    }
  });

  return suggestions.sort((a, b) => b.estimated_gain - a.estimated_gain).slice(0, 4);
}

module.exports = {
  planRelaxation
};
