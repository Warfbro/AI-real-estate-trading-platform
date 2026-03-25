/**
 * Minimal in-memory smoke run for:
 * - send_report failed -> retry success
 * - manual_review lead creation
 * - activity log traceability
 *
 * Run:
 *   node process/smoke_e2e.js
 */

const { evaluateRisk } = require("../utils/risk");
const { resolveContinueContext } = require("../utils/continue");
const fs = require("fs");
const path = require("path");

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

function buildBaseState() {
  return {
    buyer_intakes: [],
    listings: [],
    comparison_reports: [],
    risk_checks: [],
    next_actions: [],
    advisor_leads: [],
    appointments: [],
    activity_logs: []
  };
}

function append(list, item) {
  list.push(item);
  return item;
}

function seedAndRunFlow() {
  const state = buildBaseState();
  const userId = "smoke_user_001";

  const intake = append(state.buyer_intakes, {
    intake_id: "intake_smoke_001",
    user_id: userId,
    city: "Shanghai",
    budget_min: 300,
    budget_max: 500,
    usage_type: "self_use",
    status: "submitted",
    created_at: nowIso(1),
    updated_at: nowIso(1)
  });

  const listingA = append(state.listings, {
    listing_id: "listing_smoke_001",
    user_id: userId,
    city: "Shanghai",
    community_name: "DemoGarden A",
    price_total: 420,
    area_sqm: 89,
    layout_desc: "2B1L",
    missing_fields_json: [],
    status: "active",
    created_at: nowIso(2),
    updated_at: nowIso(2)
  });

  const listingB = append(state.listings, {
    listing_id: "listing_smoke_002",
    user_id: userId,
    city: "Shanghai",
    community_name: "DemoGarden B",
    price_total: 560,
    area_sqm: 96,
    layout_desc: "3B1L",
    missing_fields_json: ["elevator_flag"],
    status: "active",
    created_at: nowIso(3),
    updated_at: nowIso(3)
  });

  const comparison = append(state.comparison_reports, {
    comparison_id: "comparison_smoke_001",
    user_id: userId,
    intake_id: intake.intake_id,
    listing_ids_json: [listingA.listing_id, listingB.listing_id],
    comparison_result_json: { top_pick: listingA.listing_id },
    report_text: "Smoke compare report",
    status: "generated",
    created_at: nowIso(4),
    updated_at: nowIso(4)
  });

  const riskEval = evaluateRisk({
    listings: [listingA, listingB],
    intake
  });

  const risk = append(state.risk_checks, {
    risk_check_id: "risk_smoke_001",
    user_id: userId,
    intake_id: intake.intake_id,
    listing_ids_json: [listingA.listing_id, listingB.listing_id],
    risk_level: riskEval.riskLevel,
    risk_tags_json: riskEval.tags,
    risk_rules_hit_json: {
      ...riskEval.rulesHit,
      rule_codes: riskEval.tags.map((item) => item.code)
    },
    risk_summary_text: riskEval.summary,
    manual_review_required: riskEval.manualReviewRequired,
    created_at: nowIso(5),
    updated_at: nowIso(5)
  });

  const sendReportFail = append(state.next_actions, {
    action_id: "action_smoke_report_fail_001",
    user_id: userId,
    intake_id: intake.intake_id,
    comparison_id: comparison.comparison_id,
    risk_check_id: risk.risk_check_id,
    action_type: "send_report",
    status: "failed",
    payload_json: {
      note_text: "",
      report_email: "fail@example.com",
      source: "comparison",
      listing_ids: comparison.listing_ids_json,
      last_page: "/pages/action/index",
      attempt_no: 1,
      retry_of_action_id: "",
      send_channel: "email"
    },
    result_json: {
      message: "Report send failed: channel unavailable",
      error_code: "CHANNEL_UNAVAILABLE"
    },
    created_at: nowIso(6),
    updated_at: nowIso(6)
  });

  append(state.activity_logs, {
    actor_type: "user",
    actor_id: userId,
    action_type: "next_action_submit",
    object_type: "next_action",
    object_id: sendReportFail.action_id,
    detail_json: {
      action_type: "send_report",
      status: "failed",
      error_code: "CHANNEL_UNAVAILABLE",
      attempt_no: 1
    },
    created_at: nowIso(7)
  });

  append(state.activity_logs, {
    actor_type: "system",
    actor_id: userId,
    action_type: "report_send_failed",
    object_type: "comparison_report",
    object_id: comparison.comparison_id,
      detail_json: {
        action_id: sendReportFail.action_id,
        status: "failed",
        message: "鎶ュ憡鍙戦€佸け璐ワ細鍙戦€侀€氶亾鏆備笉鍙敤锛岃绋嶅悗閲嶈瘯",
        send_channel: "email",
        attempt_no: 1,
        error_code: "CHANNEL_UNAVAILABLE",
        retry_of_action_id: ""
      },
      created_at: nowIso(8)
  });

  const sendReportRetry = append(state.next_actions, {
    action_id: "action_smoke_report_retry_001",
    user_id: userId,
    intake_id: intake.intake_id,
    comparison_id: comparison.comparison_id,
    risk_check_id: risk.risk_check_id,
    action_type: "send_report",
    status: "done",
    payload_json: {
      note_text: "retry send report",
      report_email: "ok@example.com",
      source: "comparison",
      listing_ids: comparison.listing_ids_json,
      last_page: "/pages/action/index",
      attempt_no: 2,
      retry_of_action_id: sendReportFail.action_id,
      send_channel: "email"
    },
    result_json: {
      message: "Report send success",
      error_code: ""
    },
    created_at: nowIso(9),
    updated_at: nowIso(9)
  });

  comparison.status = "sent";
  comparison.updated_at = nowIso(10);

  append(state.activity_logs, {
    actor_type: "user",
    actor_id: userId,
    action_type: "next_action_submit",
    object_type: "next_action",
    object_id: sendReportRetry.action_id,
    detail_json: {
      action_type: "send_report",
      status: "done",
      error_code: "",
      retry_of_action_id: sendReportFail.action_id,
      attempt_no: 2
    },
    created_at: nowIso(11)
  });

  append(state.activity_logs, {
    actor_type: "system",
    actor_id: userId,
    action_type: "report_send_done",
    object_type: "comparison_report",
    object_id: comparison.comparison_id,
    detail_json: {
      action_id: sendReportRetry.action_id,
      status: "done",
      message: "Report send success",
      send_channel: "email",
      attempt_no: 2,
      error_code: "",
      retry_of_action_id: sendReportFail.action_id
    },
    created_at: nowIso(12)
  });

  const manualReviewAction = append(state.next_actions, {
    action_id: "action_smoke_manual_review_001",
    user_id: userId,
    intake_id: intake.intake_id,
    comparison_id: comparison.comparison_id,
    risk_check_id: risk.risk_check_id,
    action_type: "manual_review",
    status: "submitted",
    payload_json: {
      note_text: "please review",
      report_email: "",
      source: "risk",
      listing_ids: comparison.listing_ids_json,
      last_page: "/pages/action/index",
      attempt_no: 1,
      retry_of_action_id: "",
      send_channel: ""
    },
    result_json: {
      message: "Action queued",
      error_code: ""
    },
    created_at: nowIso(13),
    updated_at: nowIso(13)
  });

  const manualLead = append(state.advisor_leads, {
    lead_id: "lead_smoke_manual_review_001",
    user_id: userId,
    advisor_id: "",
    source_action_id: manualReviewAction.action_id,
    lead_type: "manual_review",
    status: "new",
    summary_json: {
      intake_id: intake.intake_id,
      comparison_id: comparison.comparison_id,
      risk_check_id: risk.risk_check_id,
      listing_ids: comparison.listing_ids_json,
      source_page: "risk",
      risk_level: risk.risk_level
    },
    updated_at: nowIso(14),
    created_at: nowIso(14)
  });

  append(state.advisor_leads, {
    lead_id: "lead_smoke_consult_001",
    user_id: userId,
    advisor_id: "",
    source_action_id: "action_smoke_consult_001",
    lead_type: "consult",
    status: "new",
    summary_json: {
      intake_id: intake.intake_id,
      comparison_id: comparison.comparison_id,
      risk_check_id: risk.risk_check_id,
      listing_ids: comparison.listing_ids_json,
      source_page: "comparison",
      risk_level: "-"
    },
    updated_at: nowIso(14.5),
    created_at: nowIso(14.5)
  });

  append(state.activity_logs, {
    actor_type: "system",
    actor_id: "",
    action_type: "lead_created",
    object_type: "advisor_lead",
    object_id: manualLead.lead_id,
    detail_json: {
      source_action_id: manualReviewAction.action_id,
      lead_type: "manual_review",
      status: "new",
      risk_level: risk.risk_level
    },
    created_at: nowIso(15)
  });

  const manualReviewNote = "Need callback and more documents";
  manualLead.summary_json.manual_review_note = manualReviewNote;
  manualLead.summary_json.manual_review_note_updated_at = nowIso(16);
  manualLead.summary_json.manual_review_note_updated_by = "advisor_smoke_001";
  manualLead.status = "in_progress";
  manualLead.updated_at = nowIso(16);

  append(state.activity_logs, {
    actor_type: "advisor",
    actor_id: "advisor_smoke_001",
    action_type: "manual_review_note_update",
    object_type: "advisor_lead",
    object_id: manualLead.lead_id,
    detail_json: {
      source_action_id: manualReviewAction.action_id,
      lead_type: "manual_review",
      note_preview: manualReviewNote.slice(0, 24)
    },
    created_at: nowIso(17)
  });

  append(state.activity_logs, {
    actor_type: "advisor",
    actor_id: "advisor_smoke_001",
    action_type: "lead_status_update",
    object_type: "advisor_lead",
    object_id: manualLead.lead_id,
    detail_json: {
      from_status: "new",
      to_status: "in_progress",
      source_action_id: manualReviewAction.action_id,
      lead_type: "manual_review",
      note_preview: manualReviewNote.slice(0, 24)
    },
    created_at: nowIso(18)
  });

  return state;
}

function buildContinueSnapshot(state, userId) {
  const byUser = (items, key) =>
    (items || []).filter((item) => item && item[key] === userId);
  return {
    intakes: byUser(state.buyer_intakes, "user_id"),
    listings: byUser(state.listings, "user_id"),
    comparisons: byUser(state.comparison_reports, "user_id"),
    riskChecks: byUser(state.risk_checks, "user_id"),
    actions: byUser(state.next_actions, "user_id"),
    leads: byUser(state.advisor_leads, "user_id")
  };
}

function runAssertions(state) {
  const errors = [];
  const userId = "smoke_user_001";

  const comparison = state.comparison_reports.find((i) => i.comparison_id === "comparison_smoke_001");
  if (!comparison) {
    errors.push("comparison report missing");
  }
  if (comparison && comparison.status !== "sent") {
    errors.push("comparison report status is not sent");
  }

  const failedSend = state.next_actions.find(
    (i) => i.action_id === "action_smoke_report_fail_001"
  );
  if (!failedSend || failedSend.status !== "failed") {
    errors.push("failed send_report action missing");
  }
  if (failedSend && !failedSend.result_json.error_code) {
    errors.push("failed send_report missing error_code");
  }

  const retrySend = state.next_actions.find(
    (i) => i.action_id === "action_smoke_report_retry_001"
  );
  if (!retrySend || retrySend.status !== "done") {
    errors.push("retry send_report action missing");
  }
  if (retrySend && retrySend.payload_json.attempt_no !== 2) {
    errors.push("retry send_report attempt_no should be 2");
  }
  if (retrySend && retrySend.payload_json.retry_of_action_id !== "action_smoke_report_fail_001") {
    errors.push("retry_of_action_id link invalid");
  }

  const lead = state.advisor_leads.find((i) => i.lead_id === "lead_smoke_manual_review_001");
  if (!lead) {
    errors.push("manual_review lead missing");
  }
  if (lead && !lead.summary_json.source_page) {
    errors.push("lead.summary_json.source_page missing");
  }
  if (lead && !lead.summary_json.risk_level) {
    errors.push("lead.summary_json.risk_level missing");
  }
  if (lead && !String(lead.summary_json.manual_review_note || "").trim()) {
    errors.push("manual_review note missing");
  }
  if (lead && !lead.summary_json.manual_review_note_updated_at) {
    errors.push("manual_review note updated_at missing");
  }
  if (lead && !lead.summary_json.manual_review_note_updated_by) {
    errors.push("manual_review note updated_by missing");
  }

  const risk = state.risk_checks.find((i) => i.risk_check_id === "risk_smoke_001");
  if (!risk) {
    errors.push("risk_check missing");
  }
  if (risk && !risk.risk_rules_hit_json) {
    errors.push("risk_rules_hit_json missing");
  }
  if (risk && !risk.risk_rules_hit_json.manual_review_required) {
    errors.push("risk_rules_hit_json.manual_review_required should be true");
  }
  if (risk && !Array.isArray(risk.risk_tags_json)) {
    errors.push("risk_tags_json should be array");
  }
  if (
    risk &&
    !risk.risk_tags_json.some((item) => item.code === "RISK_COST_PRESSURE")
  ) {
    errors.push("RISK_COST_PRESSURE should exist in risk tags");
  }

  const hasNextActionLog = state.activity_logs.some(
    (i) =>
      i.object_type === "next_action" &&
      i.object_id === "action_smoke_report_fail_001"
  );
  if (!hasNextActionLog) {
    errors.push("next_action log for failed send_report missing");
  }

  const hasReportLog = state.activity_logs.some(
    (i) =>
      i.object_type === "comparison_report" &&
      i.object_id === "comparison_smoke_001" &&
      (i.action_type === "report_send_failed" || i.action_type === "report_send_done")
  );
  if (!hasReportLog) {
    errors.push("comparison_report trace logs missing");
  }

  const hasReportLogFieldConsistency = state.activity_logs
    .filter(
      (i) =>
        i.object_type === "comparison_report" &&
        i.object_id === "comparison_smoke_001" &&
        (i.action_type === "report_send_failed" || i.action_type === "report_send_done")
    )
    .every((i) => {
      const detail = i.detail_json || {};
      return Boolean(detail.message) &&
        Boolean(detail.send_channel) &&
        Number(detail.attempt_no || 0) >= 1;
    });
  if (!hasReportLogFieldConsistency) {
    errors.push("comparison_report log fields incomplete");
  }

  const hasManualNoteLog = state.activity_logs.some(
    (i) =>
      i.object_type === "advisor_lead" &&
      i.object_id === "lead_smoke_manual_review_001" &&
      i.action_type === "manual_review_note_update"
  );
  if (!hasManualNoteLog) {
    errors.push("manual_review_note_update log missing");
  }

  const hasStatusNoteLog = state.activity_logs.some(
    (i) =>
      i.object_type === "advisor_lead" &&
      i.object_id === "lead_smoke_manual_review_001" &&
      i.action_type === "lead_status_update" &&
      i.detail_json &&
      i.detail_json.note_preview
  );
  if (!hasStatusNoteLog) {
    errors.push("lead_status_update note preview log missing");
  }

  let appointmentLead = {
    lead_id: "lead_smoke_status_flow_appointment_001",
    lead_type: "appointment",
    status: "new",
    source_action_id: "action_smoke_status_flow_appointment_001",
    updated_at: nowIso(30),
    created_at: nowIso(30)
  };
  let appointment = {
    appointment_id: "appointment_smoke_status_flow_001",
    action_id: "action_smoke_status_flow_appointment_001",
    status: "pending_confirmed",
    updated_at: nowIso(30),
    created_at: nowIso(30)
  };
  const appointmentTransitions = [
    { toStatus: "in_progress", expectedAppointmentStatus: "pending_confirmed" },
    { toStatus: "pending_confirmed", expectedAppointmentStatus: "pending_confirmed" },
    { toStatus: "booked", expectedAppointmentStatus: "confirmed" },
    { toStatus: "completed", expectedAppointmentStatus: "completed" },
    { toStatus: "closed", expectedAppointmentStatus: "cancelled" }
  ];
  const appointmentFlowLogs = [];
  appointmentTransitions.forEach((step, idx) => {
    const prevStatus = appointmentLead.status;
    const result = applyLeadStatusTransition({
      lead: appointmentLead,
      appointment,
      toStatus: step.toStatus,
      notePreview: "",
      offsetMs: 31 + idx
    });
    appointmentLead = result.lead;
    appointment = result.appointment;
    appointmentFlowLogs.push(result.log);

    if (result.log.detail_json.from_status !== prevStatus) {
      errors.push(`appointment flow from_status mismatch at ${step.toStatus}`);
    }
    if (result.log.detail_json.to_status !== step.toStatus) {
      errors.push(`appointment flow to_status mismatch at ${step.toStatus}`);
    }
    if (appointment.status !== step.expectedAppointmentStatus) {
      errors.push(`appointment flow mapping mismatch at ${step.toStatus}`);
    }
  });
  if (appointmentLead.status !== "closed") {
    errors.push("appointment lead final status should be closed");
  }
  if (appointment.status !== "cancelled") {
    errors.push("appointment final status should be cancelled");
  }
  if (appointmentFlowLogs.length !== appointmentTransitions.length) {
    errors.push("appointment flow log count mismatch");
  }

  let manualFlowLead = {
    lead_id: "lead_smoke_status_flow_manual_001",
    lead_type: "manual_review",
    status: "new",
    source_action_id: "action_smoke_status_flow_manual_001",
    updated_at: nowIso(40),
    created_at: nowIso(40)
  };
  const manualFlowTransitions = ["in_progress", "pending_confirmed", "completed", "closed"];
  manualFlowTransitions.forEach((toStatus, idx) => {
    const prevStatus = manualFlowLead.status;
    const result = applyLeadStatusTransition({
      lead: manualFlowLead,
      appointment: null,
      toStatus,
      notePreview: "manual flow trace",
      offsetMs: 41 + idx
    });
    manualFlowLead = result.lead;
    if (result.log.detail_json.from_status !== prevStatus) {
      errors.push(`manual flow from_status mismatch at ${toStatus}`);
    }
    if (result.log.detail_json.to_status !== toStatus) {
      errors.push(`manual flow to_status mismatch at ${toStatus}`);
    }
    if (result.log.detail_json.note_preview !== "manual flow trace") {
      errors.push(`manual flow note_preview mismatch at ${toStatus}`);
    }
  });
  if (manualFlowLead.status !== "closed") {
    errors.push("manual flow final status should be closed");
  }

  const queueItems = state.advisor_leads.map(buildLeadListItem).sort(byLeadPriority);
  if (!queueItems.length || queueItems[0].lead_type !== "manual_review") {
    errors.push("manual_review should be first in queue sort");
  }
  if (!queueItems.length || !queueItems[0].display_note_preview || queueItems[0].display_note_preview === "-") {
    errors.push("manual_review note preview should be visible in lead list item");
  }
  if (!queueItems.length || !queueItems[0].display_note_updated_at || queueItems[0].display_note_updated_at === "-") {
    errors.push("manual_review note updated_at should be visible in lead list item");
  }
  if (!queueItems.length || !queueItems[0].display_note_updated_by || queueItems[0].display_note_updated_by === "-") {
    errors.push("manual_review note updated_by should be visible in lead list item");
  }

  const quickManual = applyLeadFilters(queueItems, "all", "manual_review", "all", "all", "");
  if (!quickManual.quickManualMode) {
    errors.push("manual_review quick mode mismatch");
  }
  if (
    !quickManual.filtered.length ||
    !quickManual.filtered.every((i) => i.lead_type === "manual_review")
  ) {
    errors.push("manual_review quick filter result mismatch");
  }

  const riskFiltered = applyLeadFilters(queueItems, "all", "all", "high", "all", "");
  if (
    riskFiltered.filtered.length !== 1 ||
    riskFiltered.filtered[0].lead_id !== "lead_smoke_manual_review_001"
  ) {
    errors.push("risk_level filter mismatch");
  }

  const sourceFiltered = applyLeadFilters(queueItems, "all", "all", "all", "comparison", "");
  if (
    sourceFiltered.filtered.length !== 1 ||
    sourceFiltered.filtered[0].lead_id !== "lead_smoke_consult_001"
  ) {
    errors.push("source_page filter mismatch");
  }

  const combinedFiltered = applyLeadFilters(queueItems, "all", "manual_review", "high", "risk", "");
  if (
    combinedFiltered.filtered.length !== 1 ||
    combinedFiltered.filtered[0].lead_id !== "lead_smoke_manual_review_001"
  ) {
    errors.push("combined filter mismatch");
  }

  const continueSnapshot = buildContinueSnapshot(state, userId);
  const validContinueRoute = "/pages/action/index?source=risk&intake_id=intake_smoke_001&comparison_id=comparison_smoke_001&risk_check_id=risk_smoke_001&listing_ids=listing_smoke_001,listing_smoke_002&action_type=send_report";
  const validContinue = resolveContinueContext({
    storedRoute: validContinueRoute,
    role: "user",
    snapshot: continueSnapshot
  });
  if (validContinue.usedFallback) {
    errors.push("valid continue route should not fallback");
  }
  if (!validContinue.route.startsWith("/pages/action/index?")) {
    errors.push("valid continue route path mismatch");
  }
  if (!validContinue.route.includes("comparison_id=comparison_smoke_001")) {
    errors.push("valid continue route should preserve comparison_id");
  }
  if (!validContinue.route.includes("listing_smoke_001") || !validContinue.route.includes("listing_smoke_002")) {
    errors.push("valid continue route should preserve listing_ids");
  }

  const staleContinue = resolveContinueContext({
    storedRoute: "/pages/action/index?comparison_id=comparison_missing&listing_ids=listing_missing",
    role: "user",
    snapshot: continueSnapshot
  });
  if (!staleContinue.usedFallback || staleContinue.reasonCode !== "stale_context") {
    errors.push("stale continue route should fallback with stale_context");
  }
  if (!staleContinue.route.startsWith("/pages/action/index?")) {
    errors.push("stale continue route should fallback to latest action route");
  }

  const adminForbiddenContinue = resolveContinueContext({
    storedRoute: "/pages/adminLeads/index",
    role: "user",
    snapshot: continueSnapshot
  });
  if (!adminForbiddenContinue.usedFallback || adminForbiddenContinue.reasonCode !== "admin_forbidden") {
    errors.push("admin route should fallback for user role");
  }

  const adminDefaultContinue = resolveContinueContext({
    storedRoute: "/pages/login/index",
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
  if (!adminDefaultContinue.usedFallback || adminDefaultContinue.route !== "/pages/adminLeads/index") {
    errors.push("admin empty snapshot should fallback to admin leads");
  }

  try {
    const helperPath = path.join(__dirname, "devtools_smoke_helper.js");
    const helperText = fs.readFileSync(helperPath, "utf8");
    if (!helperText.includes("function switchRole(")) {
      errors.push("smoke helper missing switchRole function");
    }
    if (!helperText.includes("function seedHighRisk(")) {
      errors.push("smoke helper missing seedHighRisk function");
    }
    if (!helperText.includes("function runQuickDemo(")) {
      errors.push("smoke helper missing runQuickDemo function");
    }
    if (!/reason_code:\s*String\(reasonCode/.test(helperText)) {
      errors.push("runQuickDemo result missing reason_code");
    }
    if (!/step_results:\s*stepResults/.test(helperText)) {
      errors.push("runQuickDemo result missing step_results");
    }
    if (
      !(
        /started_at:\s*beginIso/.test(helperText) &&
        /finished_at:\s*new Date\(endAt\)\.toISOString\(\)/.test(helperText) &&
        /duration_ms:\s*endAt - beginAt/.test(helperText)
      )
    ) {
      errors.push("runQuickDemo result missing started_at/finished_at/duration_ms");
    }
    if (
      !(
        helperText.includes("\"seed_base_failed\"") &&
        helperText.includes("\"seed_high_risk_failed\"") &&
        helperText.includes("\"switch_role_failed\"") &&
        helperText.includes("\"verify_high_risk_failed\"") &&
        helperText.includes("\"navigate_failed\"")
      )
    ) {
      errors.push("runQuickDemo missing explicit failure reason codes");
    }
    if (!helperText.includes("function verifyHighRiskSeed(")) {
      errors.push("smoke helper missing verifyHighRiskSeed function");
    }
    if (!/switchRole:\s*switchRole/.test(helperText)) {
      errors.push("smoke helper export missing switchRole");
    }
    if (!/seedHighRisk:\s*seedHighRisk/.test(helperText)) {
      errors.push("smoke helper export missing seedHighRisk");
    }
    if (!/runQuickDemo:\s*runQuickDemo/.test(helperText)) {
      errors.push("smoke helper export missing runQuickDemo");
    }
    if (!/verifyHighRiskSeed:\s*verifyHighRiskSeed/.test(helperText)) {
      errors.push("smoke helper export missing verifyHighRiskSeed");
    }
  } catch (err) {
    errors.push(`read smoke helper failed: ${err.message}`);
  }

  try {
    const guidePath = path.join(__dirname, "手工冒烟说明.txt");
    const guideText = fs.readFileSync(guidePath, "utf8");
    if (!guideText.includes("SMOKE_HELPER.seedBase()")) {
      errors.push("manual smoke guide missing seedBase command");
    }
    if (!guideText.includes("SMOKE_HELPER.seedHighRisk()")) {
      errors.push("manual smoke guide missing seedHighRisk command");
    }
    if (!guideText.includes("SMOKE_HELPER.verifyHighRiskSeed()")) {
      errors.push("manual smoke guide missing verifyHighRiskSeed command");
    }
    if (!guideText.includes("SMOKE_HELPER.switchRole(\"admin\")")) {
      errors.push("manual smoke guide missing switchRole admin command");
    }
    if (!guideText.includes("SMOKE_HELPER.runQuickDemo()")) {
      errors.push("manual smoke guide missing runQuickDemo command");
    }
    if (!guideText.includes("console.log(quick.step_results, quick.navigate_result)")) {
      errors.push("manual smoke guide missing minimal command sequence section");
    }
    if (!guideText.includes("reason_code")) {
      errors.push("manual smoke guide missing runQuickDemo reason_code field");
    }
    if (!guideText.includes("step_results")) {
      errors.push("manual smoke guide missing runQuickDemo step_results field");
    }
    if (!guideText.includes("started_at/finished_at/duration_ms")) {
      errors.push("manual smoke guide missing runQuickDemo timing fields");
    }
    if (!guideText.includes('ok=true && reason_code="ok"')) {
      errors.push("manual smoke guide missing runQuickDemo success quick-lookup case");
    }
    if (!(guideText.includes("step_results.*.status") && guideText.includes("navigate_result.status"))) {
      errors.push("manual smoke guide missing runQuickDemo step/navigate quick-lookup fields");
    }
    if (
      !guideText.includes(
        "seed_base_failed/seed_high_risk_failed/switch_role_failed/verify_high_risk_failed/navigate_failed"
      )
    ) {
      errors.push("manual smoke guide missing runQuickDemo failure reason codes");
    }
    if (!guideText.includes('SMOKE_HELPER.runQuickDemo({ role: "guest", navigate: false })')) {
      errors.push("manual smoke guide missing runQuickDemo failure demo command");
    }
    if (!guideText.includes('quickFail.reason_code === "switch_role_failed"')) {
      errors.push("manual smoke guide missing runQuickDemo failure demo expectation");
    }
    if (!guideText.includes('wx.navigateTo({ url: "/pages/adminLeads/index" })')) {
      errors.push("manual smoke guide missing adminLeads quick navigate command");
    }
    if (!guideText.includes("new -> in_progress -> pending_confirmed -> booked -> completed -> closed")) {
      errors.push("manual smoke guide missing appointment full-flow sequence");
    }
    if (!guideText.includes("lead_status_update")) {
      errors.push("manual smoke guide missing lead status full-flow self-check");
    }
  } catch (err) {
    errors.push(`read manual smoke guide failed: ${err.message}`);
  }

  try {
    const releasePath = path.join(__dirname, "演示与交付收口.txt");
    const releaseText = fs.readFileSync(releasePath, "utf8");
    if (!releaseText.includes("SMOKE_HELPER.seedBase()")) {
      errors.push("release note quick check missing seedBase command");
    }
    if (!releaseText.includes("SMOKE_HELPER.runQuickDemo()")) {
      errors.push("release note quick check missing runQuickDemo command");
    }
    if (
      !(
        releaseText.includes("reason_code") &&
        releaseText.includes("step_results") &&
        releaseText.includes("started_at/finished_at/duration_ms")
      )
    ) {
      errors.push("release note quick check missing runQuickDemo key result fields");
    }
    if (!releaseText.includes('ok=true && reason_code="ok"')) {
      errors.push("release note quick check missing runQuickDemo success quick-lookup case");
    }
    if (!(releaseText.includes("step_results.*.status") && releaseText.includes("navigate_result.status"))) {
      errors.push("release note quick check missing runQuickDemo step/navigate quick-lookup fields");
    }
    if (
      !releaseText.includes(
        "seed_base_failed/seed_high_risk_failed/switch_role_failed/verify_high_risk_failed/navigate_failed"
      )
    ) {
      errors.push("release note quick check missing runQuickDemo failure reason codes");
    }
    if (!releaseText.includes('SMOKE_HELPER.runQuickDemo({ role: "guest", navigate: false })')) {
      errors.push("release note quick check missing runQuickDemo failure demo command");
    }
    if (!releaseText.includes('quickFail.reason_code === "switch_role_failed"')) {
      errors.push("release note quick check missing runQuickDemo failure demo expectation");
    }
    if (!releaseText.includes("SMOKE_HELPER.seedHighRisk()")) {
      errors.push("release note quick check missing seedHighRisk command");
    }
    if (!releaseText.includes("SMOKE_HELPER.switchRole(\"admin\")")) {
      errors.push("release note quick check missing switchRole admin command");
    }
  } catch (err) {
    errors.push(`read release note failed: ${err.message}`);
  }

  return errors;
}

function main() {
  const state = seedAndRunFlow();
  const errors = runAssertions(state);

  if (errors.length) {
    console.error("SMOKE FAILED");
    errors.forEach((err, idx) => {
      console.error(`${idx + 1}. ${err}`);
    });
    process.exit(1);
  }

  console.log("SMOKE PASSED");
  console.log(`buyer_intakes=${state.buyer_intakes.length}`);
  console.log(`listings=${state.listings.length}`);
  console.log(`comparison_reports=${state.comparison_reports.length}`);
  console.log(`risk_checks=${state.risk_checks.length}`);
  console.log(`next_actions=${state.next_actions.length}`);
  console.log(`advisor_leads=${state.advisor_leads.length}`);
  console.log(`activity_logs=${state.activity_logs.length}`);
}

main();

