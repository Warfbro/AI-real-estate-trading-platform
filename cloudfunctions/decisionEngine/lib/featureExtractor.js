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

function normalizeMissingFields(value) {
  return Array.isArray(value)
    ? value.map((item) => normalizeText(item)).filter(Boolean)
    : [];
}

function sanitizeListing(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const listingId = normalizeText(item.listing_id || item.id);
  if (!listingId) {
    return null;
  }

  const city = normalizeText(item.city);
  const district = normalizeText(item.district);
  const communityName = normalizeText(item.community_name);
  const title = normalizeText(
    item.title,
    [district || city, communityName].filter(Boolean).join(" ").trim() || "房源待补充"
  );

  return {
    listing_id: listingId,
    title,
    city,
    district,
    community_name: communityName,
    price_total: toNumber(item.price_total),
    area_sqm: toNumber(item.area_sqm),
    layout_desc: normalizeText(item.layout_desc),
    elevator_flag: typeof item.elevator_flag === "boolean" ? item.elevator_flag : null,
    missing_fields_json: normalizeMissingFields(item.missing_fields_json)
  };
}

function buildStats(listings) {
  const safe = Array.isArray(listings) ? listings.map((item) => sanitizeListing(item)).filter(Boolean) : [];
  const prices = safe.map((item) => item.price_total).filter((item) => item != null);
  const areas = safe.map((item) => item.area_sqm).filter((item) => item != null);

  return {
    min_price: prices.length ? Math.min.apply(null, prices) : 0,
    max_price: prices.length ? Math.max.apply(null, prices) : 0,
    min_area: areas.length ? Math.min.apply(null, areas) : 0,
    max_area: areas.length ? Math.max.apply(null, areas) : 0
  };
}

function normalizeByRange(value, min, max, fallback = 0.5) {
  if (value == null || max <= min) {
    return fallback;
  }
  const normalized = (value - min) / (max - min);
  if (normalized < 0) return 0;
  if (normalized > 1) return 1;
  return normalized;
}

function getFeatureValues(listing, { hardConstraints = {}, stats = {} } = {}) {
  const safe = sanitizeListing(listing);
  if (!safe) {
    return null;
  }

  const budgetMax = toNumber(hardConstraints.budget_max);
  const priceNormalized = normalizeByRange(safe.price_total, stats.min_price, stats.max_price, 0.5);
  const areaNormalized = normalizeByRange(safe.area_sqm, stats.min_area, stats.max_area, 0.5);
  const affordability =
    budgetMax != null && budgetMax > 0 && safe.price_total != null
      ? Math.max(0, Math.min(1, 1 - safe.price_total / budgetMax))
      : 1 - priceNormalized;
  const districtList = Array.isArray(hardConstraints.district)
    ? hardConstraints.district
    : hardConstraints.district
      ? [hardConstraints.district]
      : [];
  const districtMatch = districtList.length
    ? districtList.includes(safe.district)
      ? 1
      : 0
    : 0.5;
  const layoutPref = normalizeText(hardConstraints.layout_pref).toLowerCase();
  const layoutMatch = layoutPref
    ? normalizeText(safe.layout_desc).toLowerCase().includes(layoutPref)
      ? 1
      : 0.35
    : 0.5;
  const completeness = Math.max(0, 1 - Math.min(safe.missing_fields_json.length, 6) / 6);

  return {
    price: affordability,
    area: safe.area_sqm == null ? 0.5 : areaNormalized,
    elevator: safe.elevator_flag === true ? 1 : safe.elevator_flag === false ? 0 : 0.5,
    district_match: districtMatch,
    layout: layoutMatch,
    data_completeness: completeness,
    affordability
  };
}

module.exports = {
  sanitizeListing,
  buildStats,
  getFeatureValues
};
