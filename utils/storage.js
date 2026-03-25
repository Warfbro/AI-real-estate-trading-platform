const STORAGE_KEYS = {
  AUTH_SESSION: "auth_session",
  LAST_ROUTE: "last_route",
  RECENT_CONTINUE_ROUTE: "recent_continue_route",
  DRAFT_INTAKE: "draft_intake",
  DRAFT_IMPORT: "draft_import",
  SEARCH_HISTORY: "search_history",
  HOME_CITY_REGION: "home_city_region",
  SEARCH_REGION_FILTER: "search_region_filter",
  COMPARE_LISTING_IDS: "compare_listing_ids",
  FAVORITE_LISTING_IDS: "favorite_listing_ids",
  AI_CHAT_THREADS: "ai_chat_threads",
  AI_CHAT_ACTIVE_SESSION_ID: "ai_chat_active_session_id",
  AI_MEMORY_PROFILE: "ai_memory_profile",
  AI_ACTIVE_REQUIREMENT: "ai_active_requirement",
  COMPARISON_REPORTS: "comparison_reports",
  RISK_CHECKS: "risk_checks",
  NEXT_ACTIONS: "next_actions",
  APPOINTMENTS: "appointments",
  ADVISOR_LEADS: "advisor_leads",
  BUYER_INTAKES: "buyer_intakes",
  LISTING_IMPORT_JOBS: "listing_import_jobs",
  LISTINGS: "listings",
  EVENT_LOGS: "event_logs",
  ACTIVITY_LOGS: "activity_logs"
};

function get(key, defaultValue = null) {
  try {
    const value = wx.getStorageSync(key);
    return value === "" || value === undefined ? defaultValue : value;
  } catch (err) {
    return defaultValue;
  }
}

function set(key, value) {
  wx.setStorageSync(key, value);
}

function append(key, item) {
  const current = get(key, []);
  current.push(item);
  set(key, current);
}

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
  STORAGE_KEYS,
  get,
  set,
  append,
  uid
};
