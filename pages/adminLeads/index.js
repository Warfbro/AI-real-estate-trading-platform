const { requireRole, getSession } = require("../../utils/auth");
const { writeActivityLog } = require("../../utils/track");
const { STORAGE_KEYS, get, set } = require("../../utils/storage");

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

const LEAD_TYPE_VALUES = ["all", "manual_review", "consult", "appointment"];
const LEAD_TYPE_LABELS = ["全部类型", "manual_review", "consult", "appointment"];
const RISK_LEVEL_VALUES = ["all", "high", "medium", "low", "-"];
const RISK_LEVEL_LABELS = ["全部风险", "high", "medium", "low", "-"];
const SOURCE_PAGE_VALUES = ["all", "risk", "comparison", "-"];
const SOURCE_PAGE_LABELS = ["全部来源", "risk", "comparison", "-"];

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

function buildNotePreview(note) {
  const text = String(note || "").replace(/\s+/g, " ").trim();
  if (!text) return "-";
  return text.length > 48 ? `${text.slice(0, 48)}...` : text;
}

Page({
  data: {
    status_values: ["all", "new", "in_progress", "pending_confirmed", "booked", "completed", "closed"],
    status_labels: ["全部状态", "new", "in_progress", "pending_confirmed", "booked", "completed", "closed"],
    lead_type_values: LEAD_TYPE_VALUES,
    lead_type_labels: LEAD_TYPE_LABELS,
    risk_level_values: RISK_LEVEL_VALUES,
    risk_level_labels: RISK_LEVEL_LABELS,
    source_page_values: SOURCE_PAGE_VALUES,
    source_page_labels: SOURCE_PAGE_LABELS,
    selected_status_index: 0,
    selected_status_value: "all",
    selected_status_label: "全部状态",
    selected_lead_type_index: 0,
    selected_lead_type_value: "all",
    selected_lead_type_label: "全部类型",
    selected_risk_level_index: 0,
    selected_risk_level_value: "all",
    selected_risk_level_label: "全部风险",
    selected_source_page_index: 0,
    selected_source_page_value: "all",
    selected_source_page_label: "全部来源",
    search_keyword: "",
    all_items: [],
    lead_items: [],
    has_lead_items: false,
    manual_review_count: 0,
    quick_manual_mode: false,
    quick_manual_button_text: "仅看人工复核（0）"
  },

  onShow() {
    if (!requireRole(["advisor", "admin"], "/pages/adminLeads/index")) {
      return;
    }
    this.bootstrap();
  },

  bootstrap() {
    const leads = get(STORAGE_KEYS.ADVISOR_LEADS, []);
    const actions = get(STORAGE_KEYS.NEXT_ACTIONS, []);
    const riskChecks = get(STORAGE_KEYS.RISK_CHECKS, []);
    const actionsMap = {};
    const riskChecksMap = {};
    actions.forEach((item) => {
      actionsMap[item.action_id] = item;
    });
    riskChecks.forEach((item) => {
      riskChecksMap[item.risk_check_id] = item;
    });

    const items = leads
      .map((lead) => this.buildLeadItem(lead, actionsMap, riskChecksMap))
      .sort(byLeadPriority);
    const manualReviewCount = items.filter((item) => item.lead_type === "manual_review").length;

    this.setData(
      {
        all_items: items,
        manual_review_count: manualReviewCount
      },
      () => this.applyFilters()
    );
  },

  buildLeadItem(lead, actionsMap, riskChecksMap) {
    const summary = lead.summary_json || {};
    const action = actionsMap[lead.source_action_id] || null;
    const actionType = action && action.action_type ? action.action_type : lead.lead_type || "-";
    const actionStatus = action && action.status ? action.status : "-";
    const actionResult = action && action.result_json && action.result_json.message
      ? action.result_json.message
      : "-";
    const payload = action && action.payload_json ? action.payload_json : {};
    const retryOfActionId = payload.retry_of_action_id || "-";
    const attemptNo = Number(payload.attempt_no || 1);
    const listingIds = Array.isArray(summary.listing_ids) ? summary.listing_ids : [];
    const intakeId = summary.intake_id || "-";
    const comparisonId = summary.comparison_id || "-";
    const riskCheckId = summary.risk_check_id || "-";
    const riskCheck = riskChecksMap[riskCheckId] || null;
    const riskLevel = summary.risk_level || (riskCheck ? riskCheck.risk_level : "") || "-";
    const sourcePage = summary.source_page || "-";
    const notePreview = buildNotePreview(summary.manual_review_note);
    const noteUpdatedAt = summary.manual_review_note_updated_at || "-";
    const noteUpdatedBy = summary.manual_review_note_updated_by || "-";
    const contextLine = `intake:${intakeId} | compare:${comparisonId} | risk:${riskCheckId}`;
    const traceLine = `action:${lead.source_action_id || "-"} | attempt:${attemptNo} | retry_of:${retryOfActionId}`;
    const searchText = `${lead.user_id || ""} ${lead.lead_type || ""} ${actionType} ${lead.source_action_id || ""} ${riskLevel} ${sourcePage} ${notePreview}`.toLowerCase();

    return {
      ...lead,
      display_user_id: lead.user_id || "-",
      display_lead_type: lead.lead_type || "-",
      display_action_type: actionType,
      display_action_status: actionStatus,
      display_action_result: actionResult,
      display_status: lead.status || "-",
      display_risk_level: riskLevel,
      display_source_page: sourcePage,
      display_note_preview: notePreview,
      display_note_updated_at: noteUpdatedAt,
      display_note_updated_by: noteUpdatedBy,
      display_trace_line: traceLine,
      display_updated_at: lead.updated_at || lead.created_at || "-",
      listing_count_text: String(listingIds.length),
      context_line: contextLine,
      search_text: searchText,
      priority_lead_type: lead.lead_type === "manual_review" ? 0 : 1,
      priority_status: getStatusPriority(lead.status || ""),
      priority_risk: getRiskPriority(riskLevel)
    };
  },

  applyFilters() {
    const status = this.data.selected_status_value;
    const leadType = this.data.selected_lead_type_value;
    const riskLevel = this.data.selected_risk_level_value;
    const sourcePage = this.data.selected_source_page_value;
    const keyword = String(this.data.search_keyword || "").trim().toLowerCase();
    const filtered = (this.data.all_items || []).filter((item) => {
      const matchStatus = status === "all" || item.status === status;
      const matchLeadType = leadType === "all" || item.lead_type === leadType;
      const matchRiskLevel = riskLevel === "all" || item.display_risk_level === riskLevel;
      const matchSourcePage = sourcePage === "all" || item.display_source_page === sourcePage;
      const matchKeyword = !keyword || item.search_text.includes(keyword);
      return matchStatus && matchLeadType && matchRiskLevel && matchSourcePage && matchKeyword;
    });
    const quickManualMode =
      leadType === "manual_review" &&
      status === "all" &&
      riskLevel === "all" &&
      sourcePage === "all" &&
      !keyword;
    const quickButtonText = quickManualMode
      ? "查看全部线索"
      : `仅看人工复核（${this.data.manual_review_count}）`;
    this.setData({
      lead_items: filtered,
      has_lead_items: filtered.length > 0,
      quick_manual_mode: quickManualMode,
      quick_manual_button_text: quickButtonText
    });
  },

  handleStatusChange(e) {
    const index = Number(e.detail.value || 0);
    const values = this.data.status_values || [];
    const labels = this.data.status_labels || [];
    this.setData(
      {
        selected_status_index: index,
        selected_status_value: values[index] || "all",
        selected_status_label: labels[index] || "全部状态"
      },
      () => this.applyFilters()
    );
  },

  handleLeadTypeChange(e) {
    const index = Number(e.detail.value || 0);
    const values = this.data.lead_type_values || [];
    const labels = this.data.lead_type_labels || [];
    this.setData(
      {
        selected_lead_type_index: index,
        selected_lead_type_value: values[index] || "all",
        selected_lead_type_label: labels[index] || "全部类型"
      },
      () => this.applyFilters()
    );
  },

  handleRiskLevelChange(e) {
    const index = Number(e.detail.value || 0);
    const values = this.data.risk_level_values || [];
    const labels = this.data.risk_level_labels || [];
    this.setData(
      {
        selected_risk_level_index: index,
        selected_risk_level_value: values[index] || "all",
        selected_risk_level_label: labels[index] || "全部风险"
      },
      () => this.applyFilters()
    );
  },

  handleSourcePageChange(e) {
    const index = Number(e.detail.value || 0);
    const values = this.data.source_page_values || [];
    const labels = this.data.source_page_labels || [];
    this.setData(
      {
        selected_source_page_index: index,
        selected_source_page_value: values[index] || "all",
        selected_source_page_label: labels[index] || "全部来源"
      },
      () => this.applyFilters()
    );
  },

  handleQuickManualReview() {
    if (this.data.quick_manual_mode) {
      this.setData(
        {
          selected_lead_type_index: 0,
          selected_lead_type_value: "all",
          selected_lead_type_label: "全部类型",
          selected_status_index: 0,
          selected_status_value: "all",
          selected_status_label: "全部状态",
          selected_risk_level_index: 0,
          selected_risk_level_value: "all",
          selected_risk_level_label: "全部风险",
          selected_source_page_index: 0,
          selected_source_page_value: "all",
          selected_source_page_label: "全部来源",
          search_keyword: ""
        },
        () => this.applyFilters()
      );
      return;
    }

    const manualIndex = (this.data.lead_type_values || []).indexOf("manual_review");
    this.setData(
      {
        selected_lead_type_index: manualIndex >= 0 ? manualIndex : 0,
        selected_lead_type_value: "manual_review",
        selected_lead_type_label: "manual_review",
        selected_status_index: 0,
        selected_status_value: "all",
        selected_status_label: "全部状态",
        selected_risk_level_index: 0,
        selected_risk_level_value: "all",
        selected_risk_level_label: "全部风险",
        selected_source_page_index: 0,
        selected_source_page_value: "all",
        selected_source_page_label: "全部来源",
        search_keyword: ""
      },
      () => this.applyFilters()
    );
  },

  handleSearchInput(e) {
    this.setData({
      search_keyword: e.detail.value || ""
    }, () => this.applyFilters());
  },

  handleOpenDetail(e) {
    const leadId = e.currentTarget.dataset.leadId;
    wx.navigateTo({
      url: `/pages/adminLeadDetail/index?lead_id=${encodeURIComponent(leadId || "")}`
    });
  },

  handleRefresh() {
    const session = getSession();
    writeActivityLog({
      actor_type: "advisor",
      actor_id: session ? session.login_code : "",
      action_type: "lead_list_refresh",
      object_type: "advisor_lead_list",
      object_id: ""
    });
    this.bootstrap();
  }
});
