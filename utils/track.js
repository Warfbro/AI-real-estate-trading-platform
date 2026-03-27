const { STORAGE_KEYS, append } = require("./storage");

const EVENTS = {
  PAGE_HOME_VIEW: "EVT_PAGE_HOME_VIEW",
  PAGE_AI_VIEW: "EVT_PAGE_AI_VIEW",
  PAGE_INTAKE_VIEW: "EVT_PAGE_INTAKE_VIEW",
  PAGE_IMPORT_VIEW: "EVT_PAGE_IMPORT_VIEW",
  PAGE_CANDIDATE_VIEW: "EVT_PAGE_CANDIDATE_VIEW",
  PAGE_DETAIL_VIEW: "EVT_PAGE_DETAIL_VIEW",
  PAGE_COMPARE_VIEW: "EVT_PAGE_COMPARE_VIEW",
  PAGE_RISK_VIEW: "EVT_PAGE_RISK_VIEW",
  PAGE_ACTION_VIEW: "EVT_PAGE_ACTION_VIEW",
  PAGE_MY_VIEW: "EVT_PAGE_MY_VIEW",
  AI_ENTRY_CLICK: "EVT_AI_ENTRY_CLICK",
  AI_DECISION_START: "EVT_AI_DECISION_START",
  AI_DECISION_PAIRWISE_SUBMIT: "EVT_AI_DECISION_PAIRWISE_SUBMIT",
  AI_DECISION_CRITIQUE_SUBMIT: "EVT_AI_DECISION_CRITIQUE_SUBMIT",
  SEARCH_ENTRY_CLICK: "EVT_SEARCH_ENTRY_CLICK",
  SEARCH_HANDOFF_AI_CLICK: "EVT_SEARCH_HANDOFF_AI_CLICK",
  INTAKE_SUBMIT: "EVT_INTAKE_SUBMIT",
  IMPORT_SUBMIT: "EVT_IMPORT_SUBMIT",
  IMPORT_SUCCESS: "EVT_IMPORT_SUCCESS",
  IMPORT_FAIL: "EVT_IMPORT_FAIL",
  LISTING_FAVORITE: "EVT_LISTING_FAVORITE",
  ADD_TO_COMPARE: "EVT_ADD_TO_COMPARE",
  COMPARE_GENERATE: "EVT_COMPARE_GENERATE",
  COMPARE_SAVE: "EVT_COMPARE_SAVE",
  RISK_GENERATE: "EVT_RISK_GENERATE",
  NEXT_ACTION_CLICK: "EVT_NEXT_ACTION_CLICK",
  ACTION_CONSULT_SUBMIT: "EVT_ACTION_CONSULT_SUBMIT",
  ACTION_APPOINTMENT_SUBMIT: "EVT_ACTION_APPOINTMENT_SUBMIT",
  ACTION_REPORT_SEND: "EVT_ACTION_REPORT_SEND",
  ACTION_MANUAL_REVIEW_SUBMIT: "EVT_ACTION_MANUAL_REVIEW_SUBMIT",
  ACTION_SAVE_FOR_LATER: "EVT_ACTION_SAVE_FOR_LATER",
  LEAD_CREATED: "EVT_LEAD_CREATED",
  LEAD_STATUS_UPDATE: "EVT_LEAD_STATUS_UPDATE"
};

function getCurrentPageName() {
  try {
    if (typeof getCurrentPages !== "function") {
      return "unknown";
    }
    const pages = getCurrentPages();
    if (!pages || !pages.length) {
      return "unknown";
    }
    return pages[pages.length - 1].route || "unknown";
  } catch (err) {
    return "unknown";
  }
}

function trackEvent(eventName, payload = {}) {
  const record = {
    event_name: eventName,
    timestamp: new Date().toISOString(),
    page_name: getCurrentPageName(),
    payload
  };
  append(STORAGE_KEYS.EVENT_LOGS, record);
  console.info("[trackEvent]", record);
}

function writeActivityLog({
  actor_type = "user",
  actor_id = "",
  action_type,
  object_type,
  object_id = "",
  detail_json = {}
}) {
  const record = {
    actor_type,
    actor_id,
    action_type,
    object_type,
    object_id,
    detail_json,
    created_at: new Date().toISOString()
  };
  append(STORAGE_KEYS.ACTIVITY_LOGS, record);
  console.info("[activityLog]", record);
}

module.exports = {
  EVENTS,
  trackEvent,
  writeActivityLog
};
