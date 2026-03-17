const { requireRole, getSession } = require("../../utils/auth");
const { EVENTS, trackEvent, writeActivityLog } = require("../../utils/track");
const { STORAGE_KEYS, get, set } = require("../../utils/storage");

const LEAD_STATUS_VALUES = ["new", "in_progress", "pending_confirmed", "booked", "completed", "closed"];

function findStatusIndex(statusValue) {
  const idx = LEAD_STATUS_VALUES.indexOf(statusValue);
  return idx >= 0 ? idx : 0;
}

function byCreatedDesc(a, b) {
  const aTime = a.created_at || "";
  const bTime = b.created_at || "";
  return aTime > bTime ? -1 : 1;
}

function toText(value, fallback = "-") {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  return String(value);
}

function buildTraceLine(sourceActionId, attemptNo, retryOfActionId) {
  return `action:${sourceActionId || "-"} | attempt:${attemptNo} | retry_of:${retryOfActionId || "-"}`;
}

function buildNotePreview(note) {
  const text = String(note || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

function buildLogDetailText(item) {
  const detail = item.detail_json || {};
  const parts = [];
  if (detail.status) parts.push(`status=${detail.status}`);
  if (detail.error_code) parts.push(`error_code=${detail.error_code}`);
  if (detail.retry_of_action_id) parts.push(`retry_of=${detail.retry_of_action_id}`);
  if (detail.from_status) parts.push(`from=${detail.from_status}`);
  if (detail.to_status) parts.push(`to=${detail.to_status}`);
  if (detail.lead_type) parts.push(`lead_type=${detail.lead_type}`);
  if (detail.action_type) parts.push(`action_type=${detail.action_type}`);
  if (detail.note_preview) parts.push(`note=${detail.note_preview}`);
  return parts.length ? parts.join(" | ") : "-";
}

function mapLeadToAppointmentStatus(leadStatus, fallbackStatus) {
  if (leadStatus === "pending_confirmed") return "pending_confirmed";
  if (leadStatus === "booked") return "confirmed";
  if (leadStatus === "completed") return "completed";
  if (leadStatus === "closed") return "cancelled";
  return fallbackStatus || "pending_confirmed";
}

Page({
  data: {
    lead_id: "",
    has_lead: false,
    lead: null,
    status_values: LEAD_STATUS_VALUES,
    status_labels: LEAD_STATUS_VALUES,
    selected_status_index: 0,
    selected_status_value: "new",
    selected_status_label: "new",
    action_type_text: "-",
    action_status_text: "-",
    action_result_text: "-",
    action_attempt_no_text: "1",
    retry_of_action_id_text: "-",
    risk_level_text: "-",
    source_page_text: "-",
    trace_line_text: "-",
    intake_id_text: "-",
    comparison_id_text: "-",
    risk_check_id_text: "-",
    listing_ids_text: "-",
    has_appointment: false,
    appointment_id_text: "-",
    appointment_status_text: "-",
    appointment_time_text: "-",
    is_manual_review: false,
    manual_review_note_input: "",
    manual_review_note_saved_text: "-",
    manual_review_note_updated_at_text: "-",
    manual_review_note_updated_by_text: "-",
    logs: [],
    has_logs: false
  },

  onLoad(options) {
    this.setData({
      lead_id: options.lead_id ? decodeURIComponent(options.lead_id) : ""
    });
  },

  onShow() {
    if (!requireRole(["advisor", "admin"], `/pages/adminLeadDetail/index?lead_id=${this.data.lead_id}`)) {
      return;
    }
    this.bootstrap();
  },

  bootstrap() {
    const leadId = this.data.lead_id;
    const leads = get(STORAGE_KEYS.ADVISOR_LEADS, []);
    const lead = leads.find((item) => item.lead_id === leadId) || null;
    if (!lead) {
      this.setData({
        has_lead: false,
        lead: null
      });
      return;
    }

    const summary = lead.summary_json || {};
    const nextActions = get(STORAGE_KEYS.NEXT_ACTIONS, []);
    const action = nextActions.find((item) => item.action_id === lead.source_action_id) || null;
    const actionPayload = action && action.payload_json ? action.payload_json : {};
    const actionResult = action && action.result_json ? action.result_json : {};
    const attemptNo = Number(actionPayload.attempt_no || 1);
    const retryOfActionId = actionPayload.retry_of_action_id || "";

    const appointments = get(STORAGE_KEYS.APPOINTMENTS, []);
    const appointment =
      appointments.find((item) => item.action_id === lead.source_action_id) || null;
    const riskChecks = get(STORAGE_KEYS.RISK_CHECKS, []);
    const riskCheck =
      riskChecks.find((item) => item.risk_check_id === summary.risk_check_id) || null;
    const riskLevel = summary.risk_level || (riskCheck ? riskCheck.risk_level : "") || "-";
    const sourcePage = summary.source_page || "-";
    const manualReviewNote = toText(summary.manual_review_note, "");
    const manualReviewUpdatedAt = toText(summary.manual_review_note_updated_at, "-");
    const manualReviewUpdatedBy = toText(summary.manual_review_note_updated_by, "-");

    const logs = get(STORAGE_KEYS.ACTIVITY_LOGS, [])
      .filter((item) => {
        const isLeadLog = item.object_type === "advisor_lead" && item.object_id === lead.lead_id;
        const isActionLog = item.object_type === "next_action" && item.object_id === lead.source_action_id;
        const isReportLog =
          item.object_type === "comparison_report" &&
          (
            (item.detail_json && item.detail_json.action_id === lead.source_action_id) ||
            (summary.comparison_id && item.object_id === summary.comparison_id)
          );
        return isLeadLog || isActionLog || isReportLog;
      })
      .sort(byCreatedDesc)
      .slice(0, 20)
      .map((item) => ({
        ...item,
        display_detail_text: buildLogDetailText(item)
      }));

    const statusIndex = findStatusIndex(lead.status);
    const listingIds = Array.isArray(summary.listing_ids) ? summary.listing_ids : [];

    this.setData({
      has_lead: true,
      lead,
      selected_status_index: statusIndex,
      selected_status_value: LEAD_STATUS_VALUES[statusIndex],
      selected_status_label: LEAD_STATUS_VALUES[statusIndex],
      action_type_text: action && action.action_type ? action.action_type : lead.lead_type || "-",
      action_status_text: action && action.status ? action.status : "-",
      action_result_text: toText(actionResult.message, "-"),
      action_attempt_no_text: String(attemptNo),
      retry_of_action_id_text: toText(retryOfActionId, "-"),
      risk_level_text: riskLevel,
      source_page_text: sourcePage,
      trace_line_text: buildTraceLine(lead.source_action_id, attemptNo, retryOfActionId),
      intake_id_text: summary.intake_id || "-",
      comparison_id_text: summary.comparison_id || "-",
      risk_check_id_text: summary.risk_check_id || "-",
      listing_ids_text: listingIds.length ? listingIds.join(",") : "-",
      has_appointment: Boolean(appointment),
      appointment_id_text: appointment ? appointment.appointment_id : "-",
      appointment_status_text: appointment ? appointment.status : "-",
      appointment_time_text: appointment ? appointment.preferred_time : "-",
      is_manual_review: lead.lead_type === "manual_review",
      manual_review_note_input: manualReviewNote,
      manual_review_note_saved_text: toText(manualReviewNote, "-"),
      manual_review_note_updated_at_text: manualReviewUpdatedAt,
      manual_review_note_updated_by_text: manualReviewUpdatedBy,
      logs,
      has_logs: logs.length > 0
    });
  },

  handleStatusChange(e) {
    const index = Number(e.detail.value || 0);
    const value = LEAD_STATUS_VALUES[index] || "new";
    this.setData({
      selected_status_index: index,
      selected_status_value: value,
      selected_status_label: value
    });
  },

  handleManualReviewNoteInput(e) {
    this.setData({
      manual_review_note_input: e.detail.value || ""
    });
  },

  handleSaveManualReviewNote() {
    const lead = this.data.lead;
    if (!lead || lead.lead_type !== "manual_review") {
      return;
    }
    const nextNote = String(this.data.manual_review_note_input || "").trim();
    if (!nextNote) {
      wx.showToast({
        title: "请输入处理意见",
        icon: "none"
      });
      return;
    }

    const summary = lead.summary_json || {};
    const prevNote = String(summary.manual_review_note || "").trim();
    if (prevNote === nextNote) {
      wx.showToast({
        title: "处理意见未变化",
        icon: "none"
      });
      return;
    }

    const session = getSession();
    const now = new Date().toISOString();
    const actorId = session ? session.login_code : "";
    const nextLeads = get(STORAGE_KEYS.ADVISOR_LEADS, []).map((item) => {
      if (item.lead_id === lead.lead_id) {
        return {
          ...item,
          summary_json: {
            ...(item.summary_json || {}),
            manual_review_note: nextNote,
            manual_review_note_updated_at: now,
            manual_review_note_updated_by: actorId
          },
          updated_at: now
        };
      }
      return item;
    });
    set(STORAGE_KEYS.ADVISOR_LEADS, nextLeads);

    writeActivityLog({
      actor_type: "advisor",
      actor_id: actorId,
      action_type: "manual_review_note_update",
      object_type: "advisor_lead",
      object_id: lead.lead_id,
      detail_json: {
        lead_type: lead.lead_type || "",
        source_action_id: lead.source_action_id || "",
        note_preview: buildNotePreview(nextNote)
      }
    });

    wx.showToast({
      title: "处理意见已保存",
      icon: "success"
    });
    this.bootstrap();
  },

  handleUpdateStatus() {
    const lead = this.data.lead;
    if (!lead) {
      return;
    }
    const fromStatus = lead.status || "new";
    const toStatus = this.data.selected_status_value || fromStatus;
    if (fromStatus === toStatus) {
      wx.showToast({
        title: "状态未变化",
        icon: "none"
      });
      return;
    }

    const now = new Date().toISOString();
    const session = getSession();
    const actorId = session ? session.login_code : "";
    const nextManualReviewNote = String(this.data.manual_review_note_input || "").trim();
    const nextLeads = get(STORAGE_KEYS.ADVISOR_LEADS, []).map((item) => {
      if (item.lead_id === lead.lead_id) {
        const nextSummary = {
          ...(item.summary_json || {})
        };
        if (lead.lead_type === "manual_review" && nextManualReviewNote) {
          nextSummary.manual_review_note = nextManualReviewNote;
          nextSummary.manual_review_note_updated_at = now;
          nextSummary.manual_review_note_updated_by = actorId;
        }
        return {
          ...item,
          status: toStatus,
          summary_json: nextSummary,
          updated_at: now
        };
      }
      return item;
    });
    set(STORAGE_KEYS.ADVISOR_LEADS, nextLeads);

    if (lead.lead_type === "appointment") {
      const appointments = get(STORAGE_KEYS.APPOINTMENTS, []);
      const nextAppointments = appointments.map((item) => {
        if (item.action_id === lead.source_action_id) {
          return {
            ...item,
            status: mapLeadToAppointmentStatus(toStatus, item.status),
            updated_at: now
          };
        }
        return item;
      });
      set(STORAGE_KEYS.APPOINTMENTS, nextAppointments);
    }

    writeActivityLog({
      actor_type: "advisor",
      actor_id: actorId,
      action_type: "lead_status_update",
      object_type: "advisor_lead",
      object_id: lead.lead_id,
      detail_json: {
        from_status: fromStatus,
        to_status: toStatus,
        source_action_id: lead.source_action_id || "",
        lead_type: lead.lead_type || "",
        note_preview: lead.lead_type === "manual_review" ? buildNotePreview(nextManualReviewNote) : ""
      }
    });

    trackEvent(EVENTS.LEAD_STATUS_UPDATE, {
      from_status: fromStatus,
      to_status: toStatus,
      lead_type: lead.lead_type || ""
    });

    wx.showToast({
      title: "状态已更新",
      icon: "success"
    });
    this.bootstrap();
  }
});
