const { STORAGE_KEYS, get, set } = require("./storage");

const DEFAULT_CONTINUE_ROUTE = "/pages/ai/index";
const ADMIN_CONTINUE_ROUTE = "/pages/import/index?source=broker";

const ROUTE_LABELS = {
  "/pages/home/index": "首页",
  "/pages/search/index": "搜索页",
  "/pages/ai/index": "AI咨询页",
  "/pages/import/index": "房源导入页",
  "/pages/searchResult/index": "搜索结果页",
  "/pages/detail/index": "房源详情页",
  "/pages/my/index": "我的页面",
  "/pages/myFavorites/index": "我的收藏"
};

const BLOCKED_PATHS = {
  "/pages/login/index": true,
  "/pages/my/index": true
};

const LEGACY_PATHS = {
  "/pages/intake/index": true,
  "/pages/candidates/index": true,
  "/pages/compare/index": true,
  "/pages/action/index": true,
  "/pages/risk/index": true,
  "/pages/adminLeads/index": true,
  "/pages/adminLeadDetail/index": true
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

function pickLatest(items, key) {
  const list = (items || [])
    .filter((item) => item && item[key])
    .sort(byUpdatedDesc);

  return list[0] || null;
}

function buildSnapshotMaps(snapshot) {
  const intakeMap = {};
  const listingMap = {};

  (snapshot.intakes || []).forEach((item) => {
    if (item && item.intake_id) intakeMap[item.intake_id] = item;
  });
  (snapshot.listings || []).forEach((item) => {
    if (item && item.listing_id) listingMap[item.listing_id] = item;
  });

  return {
    intakeMap,
    listingMap
  };
}

function isAdminRole(role) {
  return role === "advisor" || role === "admin";
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

  if (path.startsWith("/pages/admin") && !isAdminRole(role)) {
    return {
      valid: false,
      reasonCode: "admin_forbidden"
    };
  }

  if (LEGACY_PATHS[path]) {
    return {
      valid: false,
      reasonCode: "legacy_route"
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

  const maps = buildSnapshotMaps(snapshot || {});
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

function buildActionContinueRoute(action) {
  const payload = action && typeof action.payload_json === "object" && !Array.isArray(action.payload_json)
    ? action.payload_json
    : {};

  return buildRoute(DEFAULT_CONTINUE_ROUTE, {
    source: payload.source || action.source || action.action_type || "continue"
  });
}

function buildComparisonContinueRoute(comparison) {
  return buildRoute(DEFAULT_CONTINUE_ROUTE, {
    source: comparison && comparison.source ? comparison.source : "comparison"
  });
}

function buildRiskContinueRoute(riskCheck) {
  return buildRoute(DEFAULT_CONTINUE_ROUTE, {
    source: (riskCheck && riskCheck.source) || "risk"
  });
}

function buildBestContinueRoute(snapshot, role) {
  if (isAdminRole(role)) {
    return ADMIN_CONTINUE_ROUTE;
  }

  const latestAction = pickLatest(snapshot.actions, "action_id");
  if (latestAction) {
    return buildActionContinueRoute(latestAction);
  }

  const latestComparison = pickLatest(snapshot.comparisons, "comparison_id");
  if (latestComparison) {
    return buildComparisonContinueRoute(latestComparison);
  }

  const latestRiskCheck = pickLatest(snapshot.riskChecks, "risk_check_id");
  if (latestRiskCheck) {
    return buildRiskContinueRoute(latestRiskCheck);
  }

  const latestListing = pickLatest(snapshot.listings, "listing_id");
  if (latestListing) {
    return buildRoute("/pages/detail/index", {
      listing_id: latestListing.listing_id,
      source: "continue"
    });
  }

  const latestIntake = pickLatest(snapshot.intakes, "intake_id");
  if (latestIntake) {
    return buildRoute(DEFAULT_CONTINUE_ROUTE, {
      source: "continue"
    });
  }

  return DEFAULT_CONTINUE_ROUTE;
}

function reasonToHint(reasonCode, usedFallback) {
  if (!usedFallback) {
    return "已定位到最近可继续节点。";
  }

  if (reasonCode === "stale_listing" || reasonCode === "stale_context") {
    return "上次关联对象已失效，已切换到最近有效节点。";
  }

  if (reasonCode === "blocked_path") {
    return "上次停留页不支持继续，已切换到最近有效节点。";
  }

  if (reasonCode === "admin_forbidden") {
    return "当前角色无权进入该页，已切换到最近有效节点。";
  }

  if (reasonCode === "legacy_route") {
    return "上次停留页已下线，已切换到新架构下的可继续节点。";
  }

  if (reasonCode === "invalid_path") {
    return "上次路由无效，已回到默认继续节点。";
  }

  return "已切换到最近可继续节点。";
}

function resolveContinueContext({ storedRoute, role, snapshot }) {
  const route = storedRoute || DEFAULT_CONTINUE_ROUTE;
  const check = validateContinueRoute(route, role, snapshot || {});

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

  const fallbackRoute = buildBestContinueRoute(snapshot || {}, role);
  const fallbackCheck = validateContinueRoute(fallbackRoute, role, snapshot || {});
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
  const storedRoute = get(STORAGE_KEYS.LAST_ROUTE, DEFAULT_CONTINUE_ROUTE);
  const result = resolveContinueContext({
    storedRoute,
    role,
    snapshot
  });

  if (result.route !== storedRoute) {
    set(STORAGE_KEYS.LAST_ROUTE, result.route);
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
