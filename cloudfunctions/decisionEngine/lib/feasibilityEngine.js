const { sanitizeListing } = require("./featureExtractor");

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function addReason(counter, code) {
  counter[code] = (counter[code] || 0) + 1;
}

function formatBlockerMessage(code, count, hardConstraints) {
  switch (code) {
    case "city":
      return `${count} 套房源不在目标城市 ${normalizeText(hardConstraints.city)}`;
    case "district":
      return `${count} 套房源不在目标区域`;
    case "budget_min":
      return `${count} 套房源低于预算下限`;
    case "budget_max":
      return `${count} 套房源超出预算上限`;
    case "elevator_required":
      return `${count} 套房源不满足电梯要求`;
    case "area_min":
      return `${count} 套房源面积低于预期`;
    case "missing_price_total":
      return `${count} 套房源缺少价格信息`;
    case "missing_elevator_flag":
      return `${count} 套房源缺少电梯信息`;
    default:
      return `${count} 套房源因 ${code} 被过滤`;
  }
}

function filterFeasibleListings(listings, hardConstraints = {}) {
  const safeListings = (Array.isArray(listings) ? listings : [])
    .map((item) => sanitizeListing(item))
    .filter(Boolean);
  const districtList = Array.isArray(hardConstraints.district)
    ? hardConstraints.district.filter(Boolean)
    : normalizeText(hardConstraints.district)
      ? [normalizeText(hardConstraints.district)]
      : [];
  const budgetMin = toNumber(hardConstraints.budget_min);
  const budgetMax = toNumber(hardConstraints.budget_max);
  const areaMin = toNumber(hardConstraints.area_min);
  const elevatorRequired = Boolean(hardConstraints.elevator_required);
  const city = normalizeText(hardConstraints.city);
  const blockedCounter = {};
  const feasibleListings = [];

  safeListings.forEach((item) => {
    const reasons = [];

    if (city && normalizeText(item.city) && normalizeText(item.city) !== city) {
      reasons.push("city");
    }
    if (districtList.length && normalizeText(item.district) && !districtList.includes(normalizeText(item.district))) {
      reasons.push("district");
    }
    if (budgetMin != null) {
      if (item.price_total == null) {
        reasons.push("missing_price_total");
      } else if (item.price_total < budgetMin) {
        reasons.push("budget_min");
      }
    }
    if (budgetMax != null) {
      if (item.price_total == null) {
        reasons.push("missing_price_total");
      } else if (item.price_total > budgetMax) {
        reasons.push("budget_max");
      }
    }
    if (elevatorRequired) {
      if (item.elevator_flag == null) {
        reasons.push("missing_elevator_flag");
      } else if (item.elevator_flag !== true) {
        reasons.push("elevator_required");
      }
    }
    if (areaMin != null && item.area_sqm != null && item.area_sqm < areaMin) {
      reasons.push("area_min");
    }

    if (!reasons.length) {
      feasibleListings.push(item);
      return;
    }

    reasons.forEach((reason) => addReason(blockedCounter, reason));
  });

  const blockers = Object.keys(blockedCounter)
    .map((code) => ({
      code,
      count: blockedCounter[code],
      message: formatBlockerMessage(code, blockedCounter[code], hardConstraints)
    }))
    .sort((a, b) => b.count - a.count);

  return {
    feasibleListings,
    blockers,
    totalCount: safeListings.length,
    feasibleCount: feasibleListings.length
  };
}

module.exports = {
  filterFeasibleListings
};
