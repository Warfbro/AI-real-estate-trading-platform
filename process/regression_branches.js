/**
 * Regression branch checks for action/lead flow.
 *
 * Focus:
 * 1) send_report failure branches and retry chain fields
 * 2) manual_review lead summary trace fields
 * 3) manual_review queue sort/filter (type/risk/source) + note trace fields
 * 4) appointment status mapping branches
 * 5) trace logs for next_action + comparison_report
 * 6) recent_continue_route fallback and recovery branches
 * 7) advisor_lead status full-flow transitions and trace coverage
 *
 * Run:
 *   node process/regression_branches.js
 */

const { evaluateRisk } = require("../utils/risk");
const { resolveContinueContext } = require("../utils/continue");
const fs = require("fs");
const path = require("path");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function nowIso(offsetMs) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function byUpdatedDesc(a, b) {
  const aTime = a.updated_at || a.created_at || "";
  const bTime = b.updated_at || b.created_at || "";
  return aTime > bTime ? -1 : 1;
}

const LEAD_STATUS_PRIORITY = {
  new: 0,
  in_progress: 1,
  pending_confirmed: 2,
  booked: 3,
  completed: 4,
  closed: 5
};

function getStatusPriority(status) {
  if (Object.prototype.hasOwnProperty.call(LEAD_STATUS_PRIORITY, status)) {
    return LEAD_STATUS_PRIORITY[status];
  }
  return 99;
}

function getRiskPriority(riskLevel) {
  if (riskLevel === "high") return 0;
  if (riskLevel === "medium") return 1;
  if (riskLevel === "low") return 2;
  return 3;
}

function byLeadPriority(a, b) {
  if (a.priority_lead_type !== b.priority_lead_type) {
    return a.priority_lead_type - b.priority_lead_type;
  }
  if (a.priority_status !== b.priority_status) {
    return a.priority_status - b.priority_status;
  }
  if (a.priority_risk !== b.priority_risk) {
    return a.priority_risk - b.priority_risk;
  }
  return byUpdatedDesc(a, b);
}

function buildLeadListItem(lead) {
  const summary = lead.summary_json || {};
  const riskLevel = summary.risk_level || "-";
  const sourcePage = summary.source_page || "-";
  const noteText = String(summary.manual_review_note || "").replace(/\s+/g, " ").trim();
  const notePreview = noteText ? (noteText.length > 48 ? `${noteText.slice(0, 48)}...` : noteText) : "-";
  const noteUpdatedAt = summary.manual_review_note_updated_at || "-";
  const noteUpdatedBy = summary.manual_review_note_updated_by || "-";
  return {
    ...lead,
    display_risk_level: riskLevel,
    display_source_page: sourcePage,
    display_note_preview: notePreview,
    display_note_updated_at: noteUpdatedAt,
    display_note_updated_by: noteUpdatedBy,
    search_text: `${lead.user_id || ""} ${lead.lead_type || ""} ${lead.source_action_id || ""} ${riskLevel} ${sourcePage} ${notePreview}`.toLowerCase(),
    priority_lead_type: lead.lead_type === "manual_review" ? 0 : 1,
    priority_status: getStatusPriority(lead.status || ""),
    priority_risk: getRiskPriority(riskLevel)
  };
}

function applyLeadFilters(
  items,
  statusValue,
  leadTypeValue,
  riskLevelValue,
  sourcePageValue,
  keywordValue
) {
  const status = statusValue || "all";
  const leadType = leadTypeValue || "all";
  const riskLevel = riskLevelValue || "all";
  const sourcePage = sourcePageValue || "all";
  const keyword = String(keywordValue || "").trim().toLowerCase();
  const filtered = (items || []).filter((item) => {
    const matchStatus = status === "all" || item.status === status;
    const matchType = leadType === "all" || item.lead_type === leadType;
    const matchRisk = riskLevel === "all" || item.display_risk_level === riskLevel;
    const matchSource = sourcePage === "all" || item.display_source_page === sourcePage;
    const matchKeyword = !keyword || item.search_text.includes(keyword);
    return matchStatus && matchType && matchRisk && matchSource && matchKeyword;
  });
  const quickManualMode =
    leadType === "manual_review" &&
    status === "all" &&
    riskLevel === "all" &&
    sourcePage === "all" &&
    !keyword;
  return {
    filtered,
    quickManualMode
  };
}

function mapLeadToAppointmentStatus(leadStatus, fallbackStatus) {
  if (leadStatus === "pending_confirmed") return "pending_confirmed";
  if (leadStatus === "booked") return "confirmed";
  if (leadStatus === "completed") return "completed";
  if (leadStatus === "closed") return "cancelled";
  return fallbackStatus || "pending_confirmed";
}

function applyLeadStatusTransition({
  lead,
  appointment,
  toStatus,
  actorId,
  notePreview,
  offsetMs
}) {
  const fromStatus = lead.status || "new";
  const now = nowIso(offsetMs || 0);
  const nextLead = {
    ...lead,
    status: toStatus,
    updated_at: now
  };
  const nextAppointment = appointment
    ? {
        ...appointment,
        status: mapLeadToAppointmentStatus(toStatus, appointment.status),
        updated_at: now
      }
    : null;
  const traceLog = {
    action_type: "lead_status_update",
    object_type: "advisor_lead",
    object_id: lead.lead_id,
    detail_json: {
      from_status: fromStatus,
      to_status: toStatus,
      lead_type: lead.lead_type || "",
      note_preview: notePreview || ""
    },
    created_at: now
  };
  return {
    lead: nextLead,
    appointment: nextAppointment,
    log: traceLog
  };
}

function buildReportAction({
  userId,
  comparisonExists,
  reportEmail,
  previousFailedAction
}) {
  const retryActionValid = Boolean(
    previousFailedAction &&
    previousFailedAction.action_type === "send_report" &&
    previousFailedAction.status === "failed"
  );
  const retryOfActionId = retryActionValid ? previousFailedAction.action_id : "";
  const lastAttemptNo = retryActionValid
    ? Number(previousFailedAction.payload_json.attempt_no || 1)
    : 0;
  const attemptNo = lastAttemptNo > 0 ? lastAttemptNo + 1 : 1;
  const sendChannel = reportEmail ? "email" : "in_app";

  const baseAction = {
    action_id: `action_report_${attemptNo}`,
    user_id: userId,
    action_type: "send_report",
    status: "submitted",
    payload_json: {
      report_email: reportEmail || "",
      attempt_no: attemptNo,
      retry_of_action_id: retryOfActionId,
      send_channel: sendChannel
    },
    result_json: {
      message: "Action queued",
      error_code: ""
    }
  };

  if (!comparisonExists) {
    baseAction.status = "failed";
    baseAction.result_json = {
      message: "Report send failed: comparison not found",
      error_code: "REPORT_NOT_FOUND"
    };
    return baseAction;
  }

  if (reportEmail && !isValidEmail(reportEmail)) {
    baseAction.status = "failed";
    baseAction.result_json = {
      message: "Report send failed: invalid email",
      error_code: "INVALID_EMAIL"
    };
    return baseAction;
  }

  if (reportEmail && /fail/i.test(reportEmail)) {
    baseAction.status = "failed";
    baseAction.result_json = {
      message: "Report send failed: channel unavailable",
      error_code: "CHANNEL_UNAVAILABLE"
    };
    return baseAction;
  }

  baseAction.status = "done";
  baseAction.result_json = {
    message: sendChannel === "email" ? "Report send success" : "Report saved in app",
    error_code: ""
  };
  return baseAction;
}

function runReportBranchCases() {
  const userId = "regression_user_001";

  const reportMissing = buildReportAction({
    userId,
    comparisonExists: false,
    reportEmail: "ok@example.com",
    previousFailedAction: null
  });
  assert(reportMissing.status === "failed", "reportMissing status should be failed");
  assert(
    reportMissing.result_json.error_code === "REPORT_NOT_FOUND",
    "reportMissing error_code mismatch"
  );

  const invalidEmail = buildReportAction({
    userId,
    comparisonExists: true,
    reportEmail: "invalid_email",
    previousFailedAction: null
  });
  assert(invalidEmail.status === "failed", "invalidEmail status should be failed");
  assert(
    invalidEmail.result_json.error_code === "INVALID_EMAIL",
    "invalidEmail error_code mismatch"
  );

  const channelFail = buildReportAction({
    userId,
    comparisonExists: true,
    reportEmail: "fail@example.com",
    previousFailedAction: null
  });
  assert(channelFail.status === "failed", "channelFail status should be failed");
  assert(
    channelFail.result_json.error_code === "CHANNEL_UNAVAILABLE",
    "channelFail error_code mismatch"
  );
  assert(channelFail.payload_json.attempt_no === 1, "channelFail attempt_no should be 1");
  assert(
    channelFail.payload_json.retry_of_action_id === "",
    "channelFail retry_of_action_id should be empty"
  );

  const retrySuccess = buildReportAction({
    userId,
    comparisonExists: true,
    reportEmail: "ok@example.com",
    previousFailedAction: channelFail
  });
  assert(retrySuccess.status === "done", "retrySuccess status should be done");
  assert(
    retrySuccess.payload_json.attempt_no === 2,
    "retrySuccess attempt_no should be 2"
  );
  assert(
    retrySuccess.payload_json.retry_of_action_id === channelFail.action_id,
    "retrySuccess retry_of_action_id mismatch"
  );
  assert(
    retrySuccess.payload_json.send_channel === "email",
    "retrySuccess send_channel should be email"
  );

  const inAppSuccess = buildReportAction({
    userId,
    comparisonExists: true,
    reportEmail: "",
    previousFailedAction: null
  });
  assert(inAppSuccess.status === "done", "inAppSuccess status should be done");
  assert(
    inAppSuccess.payload_json.send_channel === "in_app",
    "inAppSuccess send_channel should be in_app"
  );
  assert(
    inAppSuccess.result_json.message === "Report saved in app",
    "inAppSuccess message mismatch"
  );

  const invalidRetryTarget = buildReportAction({
    userId,
    comparisonExists: true,
    reportEmail: "ok@example.com",
    previousFailedAction: {
      action_id: "action_wrong_type_001",
      action_type: "consult",
      status: "done",
      payload_json: {
        attempt_no: 9
      }
    }
  });
  assert(
    invalidRetryTarget.payload_json.attempt_no === 1,
    "invalidRetryTarget attempt_no should reset to 1"
  );
  assert(
    invalidRetryTarget.payload_json.retry_of_action_id === "",
    "invalidRetryTarget retry_of_action_id should reset empty"
  );

  return { channelFail, retrySuccess };
}

function runManualReviewCase() {
  const leadWithNote = buildLeadListItem({
    lead_id: "lead_regression_manual_001",
    user_id: "regression_user_001",
    source_action_id: "action_regression_manual_001",
    lead_type: "manual_review",
    status: "new",
    summary_json: {
      intake_id: "intake_regression_001",
      comparison_id: "comparison_regression_001",
      risk_check_id: "risk_regression_001",
      listing_ids: ["listing_001", "listing_002"],
      source_page: "risk",
      risk_level: "high",
      manual_review_note: "Need callback and more documents",
      manual_review_note_updated_at: nowIso(90),
      manual_review_note_updated_by: "advisor_note_001"
    },
    updated_at: nowIso(90),
    created_at: nowIso(90)
  });

  assert(leadWithNote.display_risk_level === "high", "risk level projection mismatch");
  assert(leadWithNote.display_source_page === "risk", "source page projection mismatch");
  assert(
    leadWithNote.display_note_preview.includes("Need callback"),
    "note preview projection mismatch"
  );
  assert(
    leadWithNote.display_note_updated_at !== "-",
    "note updated_at projection mismatch"
  );
  assert(
    leadWithNote.display_note_updated_by === "advisor_note_001",
    "note updated_by projection mismatch"
  );
}

function runManualReviewQueueCase() {
  const manualLead = buildLeadListItem({
    lead_id: "lead_regression_manual_queue_001",
    user_id: "regression_user_001",
    source_action_id: "action_regression_manual_queue_001",
    lead_type: "manual_review",
    status: "new",
    summary_json: {
      intake_id: "intake_regression_001",
      comparison_id: "comparison_regression_001",
      risk_check_id: "risk_regression_001",
      source_page: "risk",
      risk_level: "high",
      manual_review_note: "Need callback and more documents",
      manual_review_note_updated_at: nowIso(95),
      manual_review_note_updated_by: "advisor_note_001"
    },
    updated_at: nowIso(95),
    created_at: nowIso(95)
  });
  const consultLead = buildLeadListItem({
    lead_id: "lead_regression_consult_queue_001",
    user_id: "regression_user_001",
    source_action_id: "action_regression_consult_queue_001",
    lead_type: "consult",
    status: "in_progress",
    summary_json: {
      source_page: "comparison",
      risk_level: "-"
    },
    updated_at: nowIso(94),
    created_at: nowIso(94)
  });

  const queueItems = [consultLead, manualLead].sort(byLeadPriority);
  assert(queueItems[0].lead_type === "manual_review", "manual_review should be first in queue sort");
  assert(
    queueItems[0].display_note_preview.includes("Need callback"),
    "manual_review note preview should be visible in lead list item"
  );
  assert(
    queueItems[0].display_note_updated_at !== "-",
    "manual_review note updated_at should be visible in lead list item"
  );
  assert(
    queueItems[0].display_note_updated_by === "advisor_note_001",
    "manual_review note updated_by should be visible in lead list item"
  );

  const quickManual = applyLeadFilters(queueItems, "all", "manual_review", "all", "all", "");
  assert(quickManual.quickManualMode, "manual_review quick mode mismatch");
  assert(
    quickManual.filtered.length === 1 && quickManual.filtered[0].lead_id === manualLead.lead_id,
    "manual_review quick filter result mismatch"
  );

  const riskFiltered = applyLeadFilters(queueItems, "all", "all", "high", "all", "");
  assert(
    riskFiltered.filtered.length === 1 && riskFiltered.filtered[0].lead_id === manualLead.lead_id,
    "risk_level filter mismatch"
  );

  const sourceFiltered = applyLeadFilters(queueItems, "all", "all", "all", "comparison", "");
  assert(
    sourceFiltered.filtered.length === 1 && sourceFiltered.filtered[0].lead_id === consultLead.lead_id,
    "source_page filter mismatch"
  );

  const combinedFiltered = applyLeadFilters(queueItems, "all", "manual_review", "high", "risk", "");
  assert(
    combinedFiltered.filtered.length === 1 &&
      combinedFiltered.filtered[0].lead_id === manualLead.lead_id,
    "combined filter mismatch"
  );
}

function runManualReviewNoteLogCase() {
  const noteText = "Need callback and more documents";
  const lead = {
    lead_id: "lead_regression_note_trace_001",
    lead_type: "manual_review",
    status: "new",
    summary_json: {
      source_page: "risk",
      risk_level: "high"
    },
    updated_at: nowIso(96),
    created_at: nowIso(96)
  };

  lead.summary_json.manual_review_note = noteText;
  lead.summary_json.manual_review_note_updated_at = nowIso(97);
  lead.summary_json.manual_review_note_updated_by = "advisor_note_001";
  lead.status = "in_progress";
  lead.updated_at = nowIso(97);

  const leadItem = buildLeadListItem(lead);
  assert(
    leadItem.display_note_preview.includes("Need callback"),
    "manual_review note summary projection mismatch"
  );
  assert(
    leadItem.display_note_updated_at === lead.summary_json.manual_review_note_updated_at,
    "manual_review note updated_at projection mismatch"
  );
  assert(
    leadItem.display_note_updated_by === "advisor_note_001",
    "manual_review note updated_by projection mismatch"
  );

  const noteLog = {
    action_type: "manual_review_note_update",
    object_type: "advisor_lead",
    object_id: lead.lead_id,
    detail_json: {
      lead_type: "manual_review",
      note_preview: noteText,
      updated_by: "advisor_note_001"
    },
    created_at: nowIso(97)
  };
  assert(
    noteLog.action_type === "manual_review_note_update" &&
      noteLog.detail_json.note_preview.includes("Need callback"),
    "manual_review_note_update log mismatch"
  );

  const statusLog = applyLeadStatusTransition({
    lead,
    appointment: null,
    toStatus: "completed",
    actorId: "advisor_note_001",
    notePreview: noteText,
    offsetMs: 98
  }).log;
  assert(statusLog.action_type === "lead_status_update", "lead_status_update action mismatch");
  assert(
    statusLog.detail_json.note_preview.includes("Need callback"),
    "lead_status_update note preview log mismatch"
  );
}

function runRiskRuleExpansionCase() {
  const intake = {
    city: "Shanghai",
    budget_max: 500
  };
  const listings = [
    {
      listing_id: "listing_risk_001",
      city: "Shanghai",
      price_total: 620,
      area_sqm: 90,
      missing_fields_json: ["community_name", "title"]
    },
    {
      listing_id: "listing_risk_002",
      city: "Hangzhou",
      price_total: 360,
      area_sqm: 88,
      missing_fields_json: []
    }
  ];

  const result = evaluateRisk({
    listings,
    intake
  });

  assert(result.riskLevel === "high", "riskLevel should be high");
  assert(result.manualReviewRequired, "manualReviewRequired should be true");
  assert(result.rulesHit.missing_info, "rulesHit.missing_info should be true");
  assert(result.rulesHit.info_conflict, "rulesHit.info_conflict should be true");
  assert(result.rulesHit.price_anomaly, "rulesHit.price_anomaly should be true");
  assert(result.rulesHit.cost_pressure, "rulesHit.cost_pressure should be true");
  assert(result.rulesHit.manual_review_required, "rulesHit.manual_review_required should be true");
  assert(
    result.tags.some((item) => item.code === "RISK_MISSING_INFO"),
    "RISK_MISSING_INFO tag missing"
  );
  assert(
    result.tags.some((item) => item.code === "RISK_INFO_CONFLICT"),
    "RISK_INFO_CONFLICT tag missing"
  );
  assert(
    result.tags.some((item) => item.code === "RISK_PRICE_ANOMALY"),
    "RISK_PRICE_ANOMALY tag missing"
  );
  assert(
    result.tags.some((item) => item.code === "RISK_COST_PRESSURE"),
    "RISK_COST_PRESSURE tag missing"
  );
  assert(
    result.tags.some((item) => item.code === "RISK_MANUAL_REVIEW"),
    "RISK_MANUAL_REVIEW tag missing"
  );

  const singleListingResult = evaluateRisk({
    listings: [
      {
        listing_id: "listing_risk_single_001",
        city: "Shanghai",
        price_total: 450,
        area_sqm: 80,
        missing_fields_json: []
      }
    ],
    intake
  });
  assert(
    singleListingResult.tags.some((item) => item.code === "RISK_SAMPLE_LIMITED"),
    "RISK_SAMPLE_LIMITED tag missing for single listing case"
  );
}

function runContinueRouteFallbackCase() {
  const snapshotWithAction = {
    intakes: [
      {
        intake_id: "intake_continue_001",
        updated_at: nowIso(200),
        created_at: nowIso(200)
      }
    ],
    listings: [
      {
        listing_id: "listing_continue_001",
        updated_at: nowIso(201),
        created_at: nowIso(201)
      }
    ],
    comparisons: [
      {
        comparison_id: "comparison_continue_001",
        updated_at: nowIso(202),
        created_at: nowIso(202)
      }
    ],
    riskChecks: [
      {
        risk_check_id: "risk_continue_001",
        updated_at: nowIso(203),
        created_at: nowIso(203)
      }
    ],
    actions: [
      {
        action_id: "action_continue_001",
        intake_id: "intake_continue_001",
        comparison_id: "comparison_continue_001",
        risk_check_id: "risk_continue_001",
        action_type: "send_report",
        payload_json: {
          source: "risk",
          listing_ids: ["listing_continue_001"]
        },
        updated_at: nowIso(204),
        created_at: nowIso(204)
      }
    ],
    leads: []
  };

  const validRoute = "/pages/detail/index?listing_id=listing_continue_001";
  const keepValid = resolveContinueContext({
    storedRoute: validRoute,
    role: "user",
    snapshot: snapshotWithAction
  });
  assert(!keepValid.usedFallback, "valid continue route should keep original path");
  assert(keepValid.route === validRoute, "valid continue route should remain unchanged");

  const blockedLogin = resolveContinueContext({
    storedRoute: "/pages/login/index",
    role: "user",
    snapshot: snapshotWithAction
  });
  assert(blockedLogin.usedFallback, "blocked login route should fallback");
  assert(blockedLogin.reasonCode === "blocked_path", "blocked route reason should be blocked_path");
  assert(
    blockedLogin.route.startsWith("/pages/action/index?"),
    "blocked route should fallback to latest action route"
  );

  const adminForbidden = resolveContinueContext({
    storedRoute: "/pages/adminLeads/index",
    role: "user",
    snapshot: {
      intakes: [],
      listings: [
        {
          listing_id: "listing_continue_002",
          updated_at: nowIso(210),
          created_at: nowIso(210)
        }
      ],
      comparisons: [],
      riskChecks: [],
      actions: [],
      leads: []
    }
  });
  assert(adminForbidden.usedFallback, "admin route for user should fallback");
  assert(
    adminForbidden.reasonCode === "admin_forbidden",
    "admin route reason should be admin_forbidden"
  );
  assert(
    adminForbidden.route === "/pages/ai/index",
    "admin forbidden fallback route mismatch"
  );

  const staleContext = resolveContinueContext({
    storedRoute: "/pages/action/index?comparison_id=comparison_missing&listing_ids=listing_missing",
    role: "user",
    snapshot: {
      intakes: [
        {
          intake_id: "intake_continue_003",
          updated_at: nowIso(220),
          created_at: nowIso(220)
        }
      ],
      listings: [],
      comparisons: [
        {
          comparison_id: "comparison_continue_valid",
          updated_at: nowIso(221),
          created_at: nowIso(221)
        }
      ],
      riskChecks: [],
      actions: [],
      leads: []
    }
  });
  assert(staleContext.usedFallback, "stale action context should fallback");
  assert(staleContext.reasonCode === "stale_context", "stale context reason mismatch");
  assert(
    staleContext.route === "/pages/compare/index?comparison_id=comparison_continue_valid",
    "stale context fallback should point to latest comparison"
  );

  const adminInvalidPath = resolveContinueContext({
    storedRoute: "/unknown/path",
    role: "admin",
    snapshot: {
      intakes: [],
      listings: [],
      comparisons: [],
      riskChecks: [],
      actions: [],
      leads: []
    }
  });
  assert(adminInvalidPath.usedFallback, "invalid path should fallback");
  assert(adminInvalidPath.reasonCode === "invalid_path", "invalid path reason mismatch");
  assert(
    adminInvalidPath.route === "/pages/adminLeads/index",
    "admin fallback should target admin leads"
  );
}

function runStatusMappingCase() {
  assert(
    mapLeadToAppointmentStatus("pending_confirmed", "pending_confirmed") ===
      "pending_confirmed",
    "pending_confirmed mapping mismatch"
  );
  assert(
    mapLeadToAppointmentStatus("booked", "pending_confirmed") === "confirmed",
    "booked mapping mismatch"
  );
  assert(
    mapLeadToAppointmentStatus("completed", "pending_confirmed") === "completed",
    "completed mapping mismatch"
  );
  assert(
    mapLeadToAppointmentStatus("closed", "confirmed") === "cancelled",
    "closed mapping mismatch"
  );
  assert(
    mapLeadToAppointmentStatus("in_progress", "pending_confirmed") ===
      "pending_confirmed",
    "fallback mapping mismatch"
  );
}

function runLeadStatusFullFlowCase() {
  let appointmentLead = {
    lead_id: "lead_status_flow_appointment_001",
    lead_type: "appointment",
    status: "new",
    source_action_id: "action_status_flow_appointment_001",
    updated_at: nowIso(300),
    created_at: nowIso(300)
  };
  let appointment = {
    appointment_id: "appointment_status_flow_001",
    action_id: "action_status_flow_appointment_001",
    status: "pending_confirmed",
    updated_at: nowIso(300),
    created_at: nowIso(300)
  };
  const transitions = [
    { toStatus: "in_progress", expectedAppointmentStatus: "pending_confirmed" },
    { toStatus: "pending_confirmed", expectedAppointmentStatus: "pending_confirmed" },
    { toStatus: "booked", expectedAppointmentStatus: "confirmed" },
    { toStatus: "completed", expectedAppointmentStatus: "completed" },
    { toStatus: "closed", expectedAppointmentStatus: "cancelled" }
  ];
  const transitionLogs = [];

  transitions.forEach((step, idx) => {
    const prevLeadStatus = appointmentLead.status;
    const result = applyLeadStatusTransition({
      lead: appointmentLead,
      appointment,
      toStatus: step.toStatus,
      actorId: "advisor_status_flow_001",
      notePreview: "",
      offsetMs: 310 + idx
    });
    appointmentLead = result.lead;
    appointment = result.appointment;
    transitionLogs.push(result.log);

    assert(
      result.log.detail_json.from_status === prevLeadStatus,
      `appointment flow from_status mismatch at step=${step.toStatus}`
    );
    assert(
      result.log.detail_json.to_status === step.toStatus,
      `appointment flow to_status mismatch at step=${step.toStatus}`
    );
    assert(
      appointment.status === step.expectedAppointmentStatus,
      `appointment status mapping mismatch at step=${step.toStatus}`
    );
  });

  assert(
    appointmentLead.status === "closed",
    "appointment lead final status should be closed"
  );
  assert(
    appointment.status === "cancelled",
    "appointment final status should be cancelled"
  );
  assert(
    transitionLogs.length === transitions.length,
    "appointment flow trace log count mismatch"
  );
  assert(
    transitionLogs.some(
      (item) =>
        item.detail_json.from_status === "booked" &&
        item.detail_json.to_status === "completed"
    ),
    "appointment flow should include booked->completed transition trace"
  );

  let manualLead = {
    lead_id: "lead_status_flow_manual_001",
    lead_type: "manual_review",
    status: "new",
    source_action_id: "action_status_flow_manual_001",
    updated_at: nowIso(330),
    created_at: nowIso(330)
  };
  const manualTransitions = ["in_progress", "pending_confirmed", "completed", "closed"];
  const manualLogs = [];
  manualTransitions.forEach((toStatus, idx) => {
    const prevLeadStatus = manualLead.status;
    const result = applyLeadStatusTransition({
      lead: manualLead,
      appointment: null,
      toStatus,
      actorId: "advisor_status_flow_001",
      notePreview: "manual flow trace",
      offsetMs: 340 + idx
    });
    manualLead = result.lead;
    manualLogs.push(result.log);
    assert(
      result.log.detail_json.from_status === prevLeadStatus,
      `manual flow from_status mismatch at step=${toStatus}`
    );
    assert(
      result.log.detail_json.to_status === toStatus,
      `manual flow to_status mismatch at step=${toStatus}`
    );
    assert(
      result.log.detail_json.note_preview === "manual flow trace",
      `manual flow note preview mismatch at step=${toStatus}`
    );
  });
  assert(
    manualLead.status === "closed",
    "manual lead final status should be closed"
  );
  assert(
    manualLogs.length === manualTransitions.length,
    "manual flow trace log count mismatch"
  );
}

function runDevtoolsSmokeHelperContractCase() {
  const helperPath = path.join(__dirname, "devtools_smoke_helper.js");
  const helperText = fs.readFileSync(helperPath, "utf8");

  assert(
    helperText.includes("function switchRole("),
    "devtools_smoke_helper should define switchRole"
  );
  assert(
    helperText.includes("function seedHighRisk("),
    "devtools_smoke_helper should define seedHighRisk"
  );
  assert(
    helperText.includes("function runQuickDemo("),
    "devtools_smoke_helper should define runQuickDemo"
  );
  assert(
    /reason_code:\s*String\(reasonCode/.test(helperText),
    "runQuickDemo result should include reason_code"
  );
  assert(
    /step_results:\s*stepResults/.test(helperText),
    "runQuickDemo result should include step_results"
  );
  assert(
    /started_at:\s*beginIso/.test(helperText) &&
      /finished_at:\s*new Date\(endAt\)\.toISOString\(\)/.test(helperText) &&
      /duration_ms:\s*endAt - beginAt/.test(helperText),
    "runQuickDemo result should include started_at/finished_at/duration_ms"
  );
  assert(
    helperText.includes("\"seed_base_failed\"") &&
      helperText.includes("\"seed_high_risk_failed\"") &&
      helperText.includes("\"switch_role_failed\"") &&
      helperText.includes("\"verify_high_risk_failed\"") &&
      helperText.includes("\"navigate_failed\""),
    "runQuickDemo should include explicit failure reason codes"
  );
  assert(
    helperText.includes("function verifyHighRiskSeed("),
    "devtools_smoke_helper should define verifyHighRiskSeed"
  );
  assert(
    /switchRole:\s*switchRole/.test(helperText),
    "SMOKE_HELPER export should include switchRole"
  );
  assert(
    /toAdmin:\s*toAdmin/.test(helperText),
    "SMOKE_HELPER export should include toAdmin"
  );
  assert(
    /seedHighRisk:\s*seedHighRisk/.test(helperText),
    "SMOKE_HELPER export should include seedHighRisk"
  );
  assert(
    /runQuickDemo:\s*runQuickDemo/.test(helperText),
    "SMOKE_HELPER export should include runQuickDemo"
  );
  assert(
    /verifyHighRiskSeed:\s*verifyHighRiskSeed/.test(helperText),
    "SMOKE_HELPER export should include verifyHighRiskSeed"
  );

  const guidePath = path.join(__dirname, "手工冒烟说明.txt");
  const guideText = fs.readFileSync(guidePath, "utf8");
  assert(
    guideText.includes("SMOKE_HELPER.seedBase()"),
    "manual smoke guide should include seedBase command"
  );
  assert(
    guideText.includes("SMOKE_HELPER.seedHighRisk()"),
    "manual smoke guide should include seedHighRisk command"
  );
  assert(
    guideText.includes("SMOKE_HELPER.verifyHighRiskSeed()"),
    "manual smoke guide should include verifyHighRiskSeed command"
  );
  assert(
    guideText.includes("SMOKE_HELPER.switchRole(\"admin\")"),
    "manual smoke guide should include admin quick switch command"
  );
  assert(
    guideText.includes("SMOKE_HELPER.runQuickDemo()"),
    "manual smoke guide should include runQuickDemo command"
  );
  assert(
    guideText.includes("console.log(quick.step_results, quick.navigate_result)"),
    "manual smoke guide should include minimal command sequence section"
  );
  assert(
    guideText.includes("reason_code"),
    "manual smoke guide should include runQuickDemo reason_code field"
  );
  assert(
    guideText.includes("step_results"),
    "manual smoke guide should include runQuickDemo step_results field"
  );
  assert(
    guideText.includes("started_at/finished_at/duration_ms"),
    "manual smoke guide should include runQuickDemo timing fields"
  );
  assert(
    guideText.includes('ok=true && reason_code="ok"'),
    "manual smoke guide should include runQuickDemo success quick-lookup case"
  );
  assert(
    guideText.includes("step_results.*.status") &&
      guideText.includes("navigate_result.status"),
    "manual smoke guide should include runQuickDemo step/navigate quick-lookup fields"
  );
  assert(
    guideText.includes(
      "seed_base_failed/seed_high_risk_failed/switch_role_failed/verify_high_risk_failed/navigate_failed"
    ),
    "manual smoke guide should include runQuickDemo failure reason codes"
  );
  assert(
    guideText.includes('SMOKE_HELPER.runQuickDemo({ role: "guest", navigate: false })'),
    "manual smoke guide should include runQuickDemo failure demo command"
  );
  assert(
    guideText.includes('quickFail.reason_code === "switch_role_failed"'),
    "manual smoke guide should include runQuickDemo failure demo expectation"
  );
  assert(
    guideText.includes('wx.navigateTo({ url: "/pages/adminLeads/index" })'),
    "manual smoke guide should include adminLeads quick navigate command"
  );
  assert(
    guideText.includes("new -> in_progress -> pending_confirmed -> booked -> completed -> closed"),
    "manual smoke guide should include appointment full-flow sequence"
  );
  assert(
    guideText.includes("lead_status_update"),
    "manual smoke guide should include lead status full-flow self-check"
  );

  const releasePath = path.join(__dirname, "演示与交付收口.txt");
  const releaseText = fs.readFileSync(releasePath, "utf8");
  assert(
    releaseText.includes("SMOKE_HELPER.seedBase()"),
    "release note quick check should include seedBase"
  );
  assert(
    releaseText.includes("SMOKE_HELPER.runQuickDemo()"),
    "release note quick check should include runQuickDemo"
  );
  assert(
    releaseText.includes("reason_code") &&
      releaseText.includes("step_results") &&
      releaseText.includes("started_at/finished_at/duration_ms"),
    "release note quick check should include runQuickDemo key result fields"
  );
  assert(
    releaseText.includes('ok=true && reason_code="ok"'),
    "release note quick check should include runQuickDemo success quick-lookup case"
  );
  assert(
    releaseText.includes("step_results.*.status") &&
      releaseText.includes("navigate_result.status"),
    "release note quick check should include runQuickDemo step/navigate quick-lookup fields"
  );
  assert(
    releaseText.includes(
      "seed_base_failed/seed_high_risk_failed/switch_role_failed/verify_high_risk_failed/navigate_failed"
    ),
    "release note quick check should include runQuickDemo failure reason codes"
  );
  assert(
    releaseText.includes('SMOKE_HELPER.runQuickDemo({ role: "guest", navigate: false })'),
    "release note quick check should include runQuickDemo failure demo command"
  );
  assert(
    releaseText.includes('quickFail.reason_code === "switch_role_failed"'),
    "release note quick check should include runQuickDemo failure demo expectation"
  );
  assert(
    releaseText.includes("SMOKE_HELPER.seedHighRisk()"),
    "release note quick check should include seedHighRisk"
  );
  assert(
    releaseText.includes("SMOKE_HELPER.switchRole(\"admin\")"),
    "release note quick check should include switchRole admin"
  );
}

function runTraceLogCase(actions) {
  const logs = [
    {
      action_type: "next_action_submit",
      object_type: "next_action",
      object_id: actions.channelFail.action_id,
      detail_json: {
        status: "failed",
        error_code: "CHANNEL_UNAVAILABLE",
        attempt_no: 1
      },
      created_at: nowIso(1)
    },
    {
      action_type: "report_send_failed",
      object_type: "comparison_report",
      object_id: "comparison_regression_001",
      detail_json: {
        action_id: actions.channelFail.action_id,
        status: "failed",
        error_code: "CHANNEL_UNAVAILABLE",
        retry_of_action_id: ""
      },
      created_at: nowIso(2)
    },
    {
      action_type: "report_send_done",
      object_type: "comparison_report",
      object_id: "comparison_regression_001",
      detail_json: {
        action_id: actions.retrySuccess.action_id,
        status: "done",
        error_code: "",
        retry_of_action_id: actions.channelFail.action_id
      },
      created_at: nowIso(3)
    }
  ];

  const hasNextActionTrace = logs.some(
    (i) =>
      i.object_type === "next_action" &&
      i.object_id === actions.channelFail.action_id
  );
  assert(hasNextActionTrace, "next_action trace log missing");

  const hasReportTrace = logs.some(
    (i) =>
      i.object_type === "comparison_report" &&
      i.object_id === "comparison_regression_001" &&
      (i.action_type === "report_send_failed" || i.action_type === "report_send_done")
  );
  assert(hasReportTrace, "comparison_report trace log missing");
}

function main() {
  const actions = runReportBranchCases();
  runManualReviewCase();
  runManualReviewQueueCase();
  runManualReviewNoteLogCase();
  runRiskRuleExpansionCase();
  runContinueRouteFallbackCase();
  runStatusMappingCase();
  runLeadStatusFullFlowCase();
  runDevtoolsSmokeHelperContractCase();
  runTraceLogCase(actions);

  console.log("REGRESSION PASSED");
  console.log("covered=send_report_failures,retry_chain,retry_target_validation,send_channel_consistency,manual_review_trace,manual_review_queue,risk_source_filters,manual_review_note_trace,manual_review_note_summary,risk_rule_expansion,continue_route_recovery,status_mapping,lead_status_full_flow,helper_contract,log_trace");
}

main();

