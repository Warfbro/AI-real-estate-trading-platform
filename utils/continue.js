const { STORAGE_KEYS, get, set } = require("./storage");

const DEFAULT_CONTINUE_ROUTE = "/pages/intake/index";

const ROUTE_LABELS = {
  "/pages/home/index": "首页",
  "/pages/ai/index": "AI咨询页",
  "/pages/intake/index": "需求录入页",
  "/pages/import/index": "房源导入页",
  "/pages/candidates/index": "传统搜索页",
  "/pages/detail/index": "房源详情页",
  "/pages/compare/index": "房源比较页",
  "/pages/risk/index": "风险确认页",
  "/pages/action/index": "下一步动作页",
  "/pages/adminLeads/index": "后台线索列表",
  "/pages/adminLeadDetail/index": "后台线索详情"
};

const BLOCKED_PATHS = {
  "/pages/login/index": true,
  "/pages/my/index": true
};

function byUpdatedDesc(a, b) {
  const aTime = a.updated_at || a.created_at || "";
  const bTime = b.updated_at || b.created_at || "";
  return aTime > bTime ? -1 : 1;
}

function toSafeString(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

function splitRoute(route) {
  const text = toSafeString(route).trim();
  if (!text) {
    return {
      path: "",
      queryString: ""
    };
  }
  const mark = text.indexOf("?");
  if (mark < 0) {
    return {
      path: text,
      queryString: ""
    };
  }
  return {
    path: text.slice(0, mark),
    queryString: text.slice(mark + 1)
  };
}

function parseQuery(queryString) {
  const obj = {};
  const pairs = toSafeString(queryString).split("&").filter(Boolean);
  pairs.forEach((part) => {
    const mark = part.indexOf("=");
    if (mark < 0) {
      obj[decodeURIComponent(part)] = "";
      return;
    }
    const key = decodeURIComponent(part.slice(0, mark));
    const value = decodeURIComponent(part.slice(mark + 1));
    obj[key] = value;
  });
  return obj;
}

function buildRoute(path, queryObj) {
  const safePath = toSafeString(path).trim();
  if (!safePath) {
    return DEFAULT_CONTINUE_ROUTE;
  }
  const entries = Object.keys(queryObj || {}).filter((key) => {
    const value = queryObj[key];
    return value !== undefined && value !== null && String(value) !== "";
  });
  if (!entries.length) {
    return safePath;
  }
  const query = entries
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(queryObj[key]))}`)
    .join("&");
  return `${safePath}?${query}`;
}

function resolveRouteLabel(route) {
  const info = splitRoute(route);
  return ROUTE_LABELS[info.path] || "上次停留页";
}

function parseListingIds(raw) {
  if (!raw) {
    return [];
  }
  return String(raw)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildSnapshotMaps(snapshot) {
  const intakeMap = {};
  const listingMap = {};
  const comparisonMap = {};
  const riskCheckMap = {};
  const leadMap = {};

  (snapshot.intakes || []).forEach((item) => {
    if (item && item.intake_id) intakeMap[item.intake_id] = item;
  });
  (snapshot.listings || []).forEach((item) => {
    if (item && item.listing_id) listingMap[item.listing_id] = item;
  });
  (snapshot.comparisons || []).forEach((item) => {
    if (item && item.comparison_id) comparisonMap[item.comparison_id] = item;
  });
  (snapshot.riskChecks || []).forEach((item) => {
    if (item && item.risk_check_id) riskCheckMap[item.risk_check_id] = item;
  });
  (snapshot.leads || []).forEach((item) => {
    if (item && item.lead_id) leadMap[item.lead_id] = item;
  });

  return {
    intakeMap,
    listingMap,
    comparisonMap,
    riskCheckMap,
    leadMap
  };
}

function validateRoutePath(path, role) {
  if (!path || !path.startsWith("/pages/")) {
    return {
      valid: false,
      reasonCode: "invalid_path"
    };
  }
  if (BLOCKED_PATHS[path]) {
    return {
      valid: false,
      reasonCode: "blocked_path"
    };
  }
  if (path.startsWith("/pages/admin") && role !== "advisor" && role !== "admin") {
    return {
      valid: false,
      reasonCode: "admin_forbidden"
    };
  }
  return {
    valid: true,
    reasonCode: ""
  };
}

function validateRouteContext(path, query, maps) {
  if (path === "/pages/detail/index") {
    if (!query.listing_id || !maps.listingMap[query.listing_id]) {
      return {
        valid: false,
        reasonCode: "stale_listing"
      };
    }
  }

  if (path === "/pages/adminLeadDetail/index") {
    if (!query.lead_id || !maps.leadMap[query.lead_id]) {
      return {
        valid: false,
        reasonCode: "stale_lead"
      };
    }
  }

  if (path === "/pages/risk/index" || path === "/pages/action/index") {
    const listingIds = parseListingIds(query.listing_ids || "");
    const hasListingContext = listingIds.some((id) => Boolean(maps.listingMap[id]));
    const hasIntakeContext = query.intake_id && maps.intakeMap[query.intake_id];
    const hasComparisonContext = query.comparison_id && maps.comparisonMap[query.comparison_id];
    const hasRiskContext = query.risk_check_id && maps.riskCheckMap[query.risk_check_id];
    if (!hasListingContext && !hasIntakeContext && !hasComparisonContext && !hasRiskContext) {
      return {
        valid: false,
        reasonCode: "stale_context"
      };
    }
    if (query.comparison_id && !maps.comparisonMap[query.comparison_id]) {
      return {
        valid: false,
        reasonCode: "stale_comparison"
      };
    }
    if (query.risk_check_id && !maps.riskCheckMap[query.risk_check_id]) {
      return {
        valid: false,
        reasonCode: "stale_risk_check"
      };
    }
  }

  if (path === "/pages/compare/index") {
    if (query.comparison_id && !maps.comparisonMap[query.comparison_id]) {
      return {
        valid: false,
        reasonCode: "stale_comparison"
      };
    }
  }

  return {
    valid: true,
    reasonCode: ""
  };
}

function validateContinueRoute(route, role, snapshot) {
  const info = splitRoute(route);
  const pathCheck = validateRoutePath(info.path, role);
  if (!pathCheck.valid) {
    return {
      valid: false,
      reasonCode: pathCheck.reasonCode
    };
  }
  const maps = buildSnapshotMaps(snapshot);
  const query = parseQuery(info.queryString);
  const contextCheck = validateRouteContext(info.path, query, maps);
  if (!contextCheck.valid) {
    return {
      valid: false,
      reasonCode: contextCheck.reasonCode
    };
  }
  return {
    valid: true,
    reasonCode: "",
    route: buildRoute(info.path, query)
  };
}

function buildBestContinueRoute(snapshot, role) {
  const actions = [...(snapshot.actions || [])].sort(byUpdatedDesc);
  const riskChecks = [...(snapshot.riskChecks || [])].sort(byUpdatedDesc);
  const comparisons = [...(snapshot.comparisons || [])].sort(byUpdatedDesc);
  const listings = [...(snapshot.listings || [])].sort(byUpdatedDesc);
  const intakes = [...(snapshot.intakes || [])].sort(byUpdatedDesc);

  const latestAction = actions.find((item) => item && item.action_id);
  if (latestAction) {
    return buildRoute("/pages/action/index", {
      source: (latestAction.payload_json && latestAction.payload_json.source) || "",
      intake_id: latestAction.intake_id || "",
      comparison_id: latestAction.comparison_id || "",
      risk_check_id: latestAction.risk_check_id || "",
      listing_ids: Array.isArray(latestAction.payload_json && latestAction.payload_json.listing_ids)
        ? latestAction.payload_json.listing_ids.join(",")
        : "",
      action_type: latestAction.action_type || ""
    });
  }

  const latestRisk = riskChecks.find((item) => item && item.risk_check_id);
  if (latestRisk) {
    return buildRoute("/pages/risk/index", {
      source: "comparison",
      intake_id: latestRisk.intake_id || "",
      risk_check_id: latestRisk.risk_check_id || "",
      listing_ids: Array.isArray(latestRisk.listing_ids_json)
        ? latestRisk.listing_ids_json.join(",")
        : ""
    });
  }

  const latestComparison = comparisons.find((item) => item && item.comparison_id);
  if (latestComparison) {
    return buildRoute("/pages/compare/index", {
      comparison_id: latestComparison.comparison_id || ""
    });
  }

  const latestListing = listings.find((item) => item && item.listing_id);
  const latestIntake = intakes.find((item) => item && item.intake_id);
  if (latestListing || latestIntake) {
    return "/pages/ai/index";
  }

  if (role === "advisor" || role === "admin") {
    return "/pages/adminLeads/index";
  }
  return DEFAULT_CONTINUE_ROUTE;
}

function reasonToHint(reasonCode, usedFallback) {
  if (!usedFallback) {
    return "已定位到最近可继续节点。";
  }
  if (reasonCode === "admin_forbidden") {
    return "上次停留页需要管理权限，已切换到当前可继续节点。";
  }
  if (reasonCode === "stale_context" || reasonCode === "stale_comparison" || reasonCode === "stale_risk_check") {
    return "上次上下文已变化，已切换到最近有效节点。";
  }
  if (reasonCode === "stale_listing" || reasonCode === "stale_lead") {
    return "上次对象已失效，已切换到最近有效节点。";
  }
  if (reasonCode === "blocked_path") {
    return "上次停留页不支持继续，已切换到最近有效节点。";
  }
  if (reasonCode === "invalid_path") {
    return "上次路由无效，已回到默认继续节点。";
  }
  return "已切换到最近可继续节点。";
}

function resolveContinueContext({ storedRoute, role, snapshot }) {
  const route = storedRoute || DEFAULT_CONTINUE_ROUTE;
  const check = validateContinueRoute(route, role, snapshot);
  if (check.valid) {
    const finalRoute = check.route || route;
    return {
      route: finalRoute,
      label: resolveRouteLabel(finalRoute),
      usedFallback: false,
      reasonCode: "",
      hintText: reasonToHint("", false)
    };
  }

  const fallbackRoute = buildBestContinueRoute(snapshot, role);
  const fallbackCheck = validateContinueRoute(fallbackRoute, role, snapshot);
  const finalFallbackRoute = fallbackCheck.valid ? fallbackRoute : DEFAULT_CONTINUE_ROUTE;
  return {
    route: finalFallbackRoute,
    label: resolveRouteLabel(finalFallbackRoute),
    usedFallback: true,
    reasonCode: check.reasonCode || "unknown",
    hintText: reasonToHint(check.reasonCode || "unknown", true)
  };
}

function buildSnapshotFromStorage(userId) {
  const safeUserId = userId || "";
  const filterByUser = (items, key) =>
    (items || []).filter((item) => item && item[key] === safeUserId);

  return {
    intakes: filterByUser(get(STORAGE_KEYS.BUYER_INTAKES, []), "user_id"),
    listings: filterByUser(get(STORAGE_KEYS.LISTINGS, []), "user_id"),
    comparisons: filterByUser(get(STORAGE_KEYS.COMPARISON_REPORTS, []), "user_id"),
    riskChecks: filterByUser(get(STORAGE_KEYS.RISK_CHECKS, []), "user_id"),
    actions: filterByUser(get(STORAGE_KEYS.NEXT_ACTIONS, []), "user_id"),
    leads: filterByUser(get(STORAGE_KEYS.ADVISOR_LEADS, []), "user_id")
  };
}

function resolveContinueContextFromStorage({ userId, role }) {
  const snapshot = buildSnapshotFromStorage(userId);
  const storedRoute = get(STORAGE_KEYS.RECENT_CONTINUE_ROUTE, DEFAULT_CONTINUE_ROUTE);
  const result = resolveContinueContext({
    storedRoute,
    role,
    snapshot
  });
  if (result.route !== storedRoute) {
    set(STORAGE_KEYS.RECENT_CONTINUE_ROUTE, result.route);
  }
  return result;
}

module.exports = {
  DEFAULT_CONTINUE_ROUTE,
  resolveRouteLabel,
  validateContinueRoute,
  resolveContinueContext,
  resolveContinueContextFromStorage
};
