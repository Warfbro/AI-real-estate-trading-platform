const { isLoggedIn, requireLogin, getSession } = require("../../utils/auth");
const { EVENTS, trackEvent, writeActivityLog } = require("../../utils/track");
const { STORAGE_KEYS, get, set, append, uid } = require("../../utils/storage");

const ACTION_TYPES = ["consult", "appointment", "send_report", "manual_review", "save_for_later"];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REPORT_SEND_MESSAGES = {
  REPORT_NOT_FOUND: "报告发送失败：比较结果不存在",
  INVALID_EMAIL: "报告发送失败：邮箱格式不正确",
  CHANNEL_UNAVAILABLE: "报告发送失败：发送通道暂不可用，请稍后重试",
  SUCCESS_EMAIL: "报告发送成功",
  SUCCESS_IN_APP: "报告已保存，可在我的报告中查看"
};

function byUpdatedDesc(a, b) {
  const aTime = a.updated_at || a.created_at || "";
  const bTime = b.updated_at || b.created_at || "";
  return aTime > bTime ? -1 : 1;
}

function nowIso() {
  return new Date().toISOString();
}

function isValidEmail(value) {
  return EMAIL_PATTERN.test(String(value || "").trim());
}

Page({
  data: {
    source: "risk",
    intake_id: "",
    comparison_id: "",
    risk_check_id: "",
    listing_ids: [],
    intake_id_text: "无",
    comparison_id_text: "无",
    risk_check_id_text: "无",
    selected_count_text: "0",
    selected_action: "consult",
    btn_class_consult: "btn-action btn-action-active",
    btn_class_appointment: "btn-action",
    btn_class_send_report: "btn-action",
    btn_class_manual_review: "btn-action",
    btn_class_save_for_later: "btn-action",
    is_action_appointment: false,
    is_action_send_report: false,
    note_text: "",
    preferred_time: "",
    report_email: "",
    has_report_retry_target: false,
    report_retry_action_id: "",
    report_retry_hint_text: "",
    intake: null,
    comparison: null,
    risk_check: null,
    selected_listings: [],
    actions_history: [],
    show_empty_history: true
  },

  onLoad(options) {
    const actionType = options.action_type ? decodeURIComponent(options.action_type) : "";
    this.setData({
      source: options.source || "risk",
      intake_id: options.intake_id ? decodeURIComponent(options.intake_id) : "",
      comparison_id: options.comparison_id ? decodeURIComponent(options.comparison_id) : "",
      risk_check_id: options.risk_check_id ? decodeURIComponent(options.risk_check_id) : "",
      listing_ids: options.listing_ids
        ? decodeURIComponent(options.listing_ids).split(",").filter(Boolean)
        : [],
      selected_action: ACTION_TYPES.includes(actionType) ? actionType : "consult"
    }, () => this.syncActionView());
  },

  onShow() {
    const query = [
      `source=${this.data.source}`,
      `intake_id=${encodeURIComponent(this.data.intake_id || "")}`,
      `comparison_id=${encodeURIComponent(this.data.comparison_id || "")}`,
      `risk_check_id=${encodeURIComponent(this.data.risk_check_id || "")}`,
      `listing_ids=${encodeURIComponent((this.data.listing_ids || []).join(","))}`,
      `action_type=${encodeURIComponent(this.data.selected_action || "")}`
    ].join("&");

    if (!isLoggedIn()) {
      requireLogin(`/pages/action/index?${query}`);
      return;
    }

    set(STORAGE_KEYS.RECENT_CONTINUE_ROUTE, `/pages/action/index?${query}`);
    trackEvent(EVENTS.PAGE_ACTION_VIEW, {
      source: this.data.source
    });
    this.bootstrap();
  },

  bootstrap() {
    const session = getSession();
    const userId = session.login_code;

    const intakes = get(STORAGE_KEYS.BUYER_INTAKES, [])
      .filter((item) => item.user_id === userId && item.status === "submitted")
      .sort(byUpdatedDesc);
    const intake =
      intakes.find((item) => this.data.intake_id && item.intake_id === this.data.intake_id) ||
      (intakes.length ? intakes[0] : null);

    const comparisons = get(STORAGE_KEYS.COMPARISON_REPORTS, [])
      .filter((item) => item.user_id === userId)
      .sort(byUpdatedDesc);
    const comparison =
      comparisons.find(
        (item) => this.data.comparison_id && item.comparison_id === this.data.comparison_id
      ) || null;

    const riskChecks = get(STORAGE_KEYS.RISK_CHECKS, [])
      .filter((item) => item.user_id === userId)
      .sort(byUpdatedDesc);
    const riskCheck =
      riskChecks.find((item) => this.data.risk_check_id && item.risk_check_id === this.data.risk_check_id) ||
      null;

    let listingIds = [...this.data.listing_ids];
    if (!listingIds.length && riskCheck) {
      listingIds = riskCheck.listing_ids_json || [];
    }
    if (!listingIds.length && comparison) {
      listingIds = comparison.listing_ids_json || [];
    }
    if (!listingIds.length) {
      listingIds = get(STORAGE_KEYS.COMPARE_LISTING_IDS, []);
    }

    const listings = get(STORAGE_KEYS.LISTINGS, []).filter((item) => item.user_id === userId);
    const selectedListings = listingIds
      .map((id) => listings.find((item) => item.listing_id === id))
      .filter(Boolean);

    const history = get(STORAGE_KEYS.NEXT_ACTIONS, [])
      .filter((item) => item.user_id === userId)
      .sort(byUpdatedDesc)
      .slice(0, 10);
    const latestFailedReportAction = this.findLatestFailedReportAction(history);

    this.setData({
      intake_id: intake ? intake.intake_id : "",
      comparison_id: comparison ? comparison.comparison_id : this.data.comparison_id,
      risk_check_id: riskCheck ? riskCheck.risk_check_id : this.data.risk_check_id,
      listing_ids: listingIds,
      intake,
      comparison,
      risk_check: riskCheck,
      selected_listings: selectedListings,
      has_report_retry_target: Boolean(latestFailedReportAction),
      report_retry_action_id: latestFailedReportAction ? latestFailedReportAction.action_id : "",
      report_retry_hint_text: this.buildRetryHintText(latestFailedReportAction),
      actions_history: history.map((item) => this.mapActionHistoryItem(item))
    }, () => this.syncActionView());
  },

  mapActionHistoryItem(item) {
    const result = item.result_json || {};
    const payload = item.payload_json || {};
    const retryFrom = payload.retry_of_action_id || "";
    const attemptNo = Number(payload.attempt_no || 1);
    return {
      ...item,
      display_title: `${item.action_type} ｜ ${item.status}`,
      display_result: result.message || "-",
      show_retry_from: Boolean(retryFrom),
      display_retry_from: retryFrom || "-",
      display_attempt_no: String(attemptNo)
    };
  },

  findLatestFailedReportAction(actions) {
    return (actions || []).find(
      (item) => item.action_type === "send_report" && item.status === "failed"
    ) || null;
  },

  buildRetryHintText(action) {
    if (!action) {
      return "";
    }
    const result = action.result_json || {};
    const message = result.message || "上一次发送报告失败";
    const errorCode = result.error_code ? ` / ${result.error_code}` : "";
    return `${message}${errorCode}（action_id：${action.action_id}）`;
  },

  syncActionView() {
    const selectedAction = ACTION_TYPES.includes(this.data.selected_action)
      ? this.data.selected_action
      : "consult";
    this.setData({
      selected_action: selectedAction,
      intake_id_text: this.data.intake_id || "无",
      comparison_id_text: this.data.comparison_id || "无",
      risk_check_id_text: this.data.risk_check_id || "无",
      selected_count_text: String((this.data.selected_listings || []).length),
      btn_class_consult:
        selectedAction === "consult" ? "btn-action btn-action-active" : "btn-action",
      btn_class_appointment:
        selectedAction === "appointment" ? "btn-action btn-action-active" : "btn-action",
      btn_class_send_report:
        selectedAction === "send_report" ? "btn-action btn-action-active" : "btn-action",
      btn_class_manual_review:
        selectedAction === "manual_review" ? "btn-action btn-action-active" : "btn-action",
      btn_class_save_for_later:
        selectedAction === "save_for_later" ? "btn-action btn-action-active" : "btn-action",
      is_action_appointment: selectedAction === "appointment",
      is_action_send_report: selectedAction === "send_report",
      show_empty_history: (this.data.actions_history || []).length === 0
    });
  },

  handleSelectAction(e) {
    this.setData({
      selected_action: e.currentTarget.dataset.actionType
    }, () => this.syncActionView());
  },

  handleRetryLastReport() {
    const retryActionId = this.data.report_retry_action_id;
    if (!retryActionId) {
      wx.showToast({
        title: "暂无可重试的失败记录",
        icon: "none"
      });
      return;
    }

    const session = getSession();
    const userId = session.login_code;
    const history = get(STORAGE_KEYS.NEXT_ACTIONS, []);
    const failedAction = history.find(
      (item) =>
        item.user_id === userId &&
        item.action_id === retryActionId &&
        item.action_type === "send_report" &&
        item.status === "failed"
    );
    const sameComparison = !this.data.comparison_id ||
      !failedAction ||
      !failedAction.comparison_id ||
      failedAction.comparison_id === this.data.comparison_id;
    if (!failedAction || !sameComparison) {
      wx.showToast({
        title: "重试目标无效，请重新选择",
        icon: "none"
      });
      this.setData({
        has_report_retry_target: false,
        report_retry_action_id: "",
        report_retry_hint_text: ""
      });
      return;
    }
    const payload = failedAction && failedAction.payload_json ? failedAction.payload_json : {};

    this.setData({
      selected_action: "send_report",
      report_email: payload.report_email || "",
      note_text: payload.note_text || ""
    }, () => this.syncActionView());

    wx.showToast({
      title: "已填充上次失败参数",
      icon: "none"
    });
  },

  handleInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({
      [field]: e.detail.value
    });
  },

  handleSubmitAction() {
    const actionType = this.data.selected_action;
    if (!this.hasValidContext()) {
      wx.showToast({
        title: "缺少动作上下文，请先完成比较或风险确认",
        icon: "none"
      });
      return;
    }

    trackEvent(EVENTS.NEXT_ACTION_CLICK, {
      action_type: actionType,
      from_page: this.data.source
    });

    if (actionType === "appointment" && !this.data.preferred_time) {
      wx.showToast({
        title: "请填写预约时间",
        icon: "none"
      });
      return;
    }

    if (actionType === "send_report" && !this.data.comparison_id) {
      wx.showToast({
        title: "发送报告需要已保存比较结果",
        icon: "none"
      });
      return;
    }

    const userId = getSession().login_code;
    const reportSendResult = actionType === "send_report" ? this.buildReportSendResult(userId) : null;
    const action = this.createActionRecord({
      actionType,
      status: reportSendResult ? reportSendResult.status : undefined,
      resultJson: reportSendResult ? reportSendResult.resultJson : null,
      payloadPatch: reportSendResult ? reportSendResult.payloadPatch : null
    });

    if (actionType === "consult") {
      this.createLead({
        userId,
        actionId: action.action_id,
        leadType: "consult",
        status: "new"
      });
      trackEvent(EVENTS.ACTION_CONSULT_SUBMIT, { status: action.status });
    } else if (actionType === "appointment") {
      this.createAppointment({
        userId,
        actionId: action.action_id
      });
      this.createLead({
        userId,
        actionId: action.action_id,
        leadType: "appointment",
        status: "pending_confirmed"
      });
      trackEvent(EVENTS.ACTION_APPOINTMENT_SUBMIT, {
        status: action.status,
        preferred_time_text_length: this.data.preferred_time.length
      });
    } else if (actionType === "manual_review") {
      this.createLead({
        userId,
        actionId: action.action_id,
        leadType: "manual_review",
        status: "new"
      });
      trackEvent(EVENTS.ACTION_MANUAL_REVIEW_SUBMIT, { status: action.status });
    } else if (actionType === "send_report") {
      if (action.status === "done") {
        this.markComparisonSent();
        this.setData({
          has_report_retry_target: false,
          report_retry_action_id: "",
          report_retry_hint_text: ""
        });
      } else {
        this.setData({
          has_report_retry_target: true,
          report_retry_action_id: action.action_id,
          report_retry_hint_text: this.buildRetryHintText(action)
        });
      }

      trackEvent(EVENTS.ACTION_REPORT_SEND, {
        status: action.status,
        error_code: action.result_json && action.result_json.error_code
          ? action.result_json.error_code
          : "",
        send_channel: action.payload_json && action.payload_json.send_channel
          ? action.payload_json.send_channel
          : "",
        attempt_no: action.payload_json && action.payload_json.attempt_no
          ? action.payload_json.attempt_no
          : 1
      });

      writeActivityLog({
        actor_type: "system",
        actor_id: userId,
        action_type: action.status === "done" ? "report_send_done" : "report_send_failed",
        object_type: "comparison_report",
        object_id: this.data.comparison_id || "",
        detail_json: {
          action_id: action.action_id,
          status: action.status,
          message:
            (action.result_json && action.result_json.message) || "",
          send_channel:
            (action.payload_json && action.payload_json.send_channel) || "",
          attempt_no:
            (action.payload_json && action.payload_json.attempt_no) || 1,
          error_code:
            (action.result_json && action.result_json.error_code) || "",
          retry_of_action_id:
            (action.payload_json && action.payload_json.retry_of_action_id) || ""
        }
      });
    } else if (actionType === "save_for_later") {
      this.saveForLater();
      trackEvent(EVENTS.ACTION_SAVE_FOR_LATER, {
        last_page: this.buildCurrentRoute()
      });
    }

    writeActivityLog({
      actor_type: "user",
      actor_id: userId,
      action_type: "next_action_submit",
      object_type: "next_action",
      object_id: action.action_id,
      detail_json: {
        action_type: actionType,
        status: action.status,
        error_code:
          (action.result_json && action.result_json.error_code) || "",
        retry_of_action_id:
          (action.payload_json && action.payload_json.retry_of_action_id) || "",
        attempt_no:
          (action.payload_json && action.payload_json.attempt_no) || 1
      }
    });

    const actionResultMessage = action.result_json && action.result_json.message
      ? action.result_json.message
      : "";

    wx.showToast({
      title: action.status === "failed" ? actionResultMessage || "动作提交失败" : "动作已提交",
      icon: action.status === "failed" ? "none" : "success"
    });

    this.setData({
      note_text: "",
      preferred_time: "",
      report_email: ""
    });
    this.bootstrap();
  },

  hasValidContext() {
    return Boolean(
      this.data.intake_id ||
        this.data.comparison_id ||
        this.data.risk_check_id ||
        (this.data.listing_ids || []).length
    );
  },

  getDefaultStatus(actionType) {
    if (actionType === "save_for_later") {
      return "done";
    }
    return "submitted";
  },

  getDefaultResultMessage(status) {
    return status === "done" ? "动作处理完成" : "动作已进入待处理队列";
  },

  getActionById(userId, actionId) {
    if (!actionId) {
      return null;
    }
    const actions = get(STORAGE_KEYS.NEXT_ACTIONS, []);
    return actions.find((item) => item.user_id === userId && item.action_id === actionId) || null;
  },

  resolveRetryAction(userId, retryActionId) {
    if (!retryActionId) {
      return null;
    }
    const action = this.getActionById(userId, retryActionId);
    if (!action) {
      return null;
    }
    const sameComparison =
      !this.data.comparison_id ||
      !action.comparison_id ||
      action.comparison_id === this.data.comparison_id;
    if (action.action_type !== "send_report" || action.status !== "failed" || !sameComparison) {
      return null;
    }
    return action;
  },

  buildReportSendResult(userId) {
    const rawRetryActionId = this.data.report_retry_action_id || "";
    const retryAction = this.resolveRetryAction(userId, rawRetryActionId);
    const retryOfActionId = retryAction ? retryAction.action_id : "";
    const lastAttemptNo = retryAction && retryAction.payload_json
      ? Number(retryAction.payload_json.attempt_no || 1)
      : 0;
    const attemptNo = lastAttemptNo > 0 ? lastAttemptNo + 1 : 1;
    const reportEmail = String(this.data.report_email || "").trim();
    const sendChannel = reportEmail ? "email" : "in_app";
    const payloadPatch = {
      retry_of_action_id: retryOfActionId,
      attempt_no: attemptNo,
      send_channel: sendChannel
    };

    const reports = get(STORAGE_KEYS.COMPARISON_REPORTS, []);
    const report = reports.find(
      (item) =>
        item.user_id === userId &&
        item.comparison_id === this.data.comparison_id
    );
    if (!report) {
      return {
        status: "failed",
        resultJson: {
          message: REPORT_SEND_MESSAGES.REPORT_NOT_FOUND,
          error_code: "REPORT_NOT_FOUND"
        },
        payloadPatch
      };
    }

    if (reportEmail && !isValidEmail(reportEmail)) {
      return {
        status: "failed",
        resultJson: {
          message: REPORT_SEND_MESSAGES.INVALID_EMAIL,
          error_code: "INVALID_EMAIL"
        },
        payloadPatch
      };
    }

    if (reportEmail && /fail/i.test(reportEmail)) {
      return {
        status: "failed",
        resultJson: {
          message: REPORT_SEND_MESSAGES.CHANNEL_UNAVAILABLE,
          error_code: "CHANNEL_UNAVAILABLE"
        },
        payloadPatch
      };
    }

    return {
      status: "done",
      resultJson: {
        message: reportEmail ? REPORT_SEND_MESSAGES.SUCCESS_EMAIL : REPORT_SEND_MESSAGES.SUCCESS_IN_APP,
        error_code: ""
      },
      payloadPatch
    };
  },

  createActionRecord({ actionType, status, resultJson, payloadPatch }) {
    const actionId = uid("action");
    const userId = getSession().login_code;
    const now = nowIso();
    const finalStatus = status || this.getDefaultStatus(actionType);

    const payload = {
      note_text: this.data.note_text || "",
      preferred_time: this.data.preferred_time || "",
      report_email: this.data.report_email || "",
      source: this.data.source,
      listing_ids: this.data.listing_ids || [],
      last_page: this.buildCurrentRoute(),
      attempt_no: 1,
      retry_of_action_id: "",
      send_channel: actionType === "send_report"
        ? (this.data.report_email ? "email" : "in_app")
        : ""
    };
    if (payloadPatch && typeof payloadPatch === "object") {
      Object.assign(payload, payloadPatch);
    }

    const action = {
      action_id: actionId,
      user_id: userId,
      intake_id: this.data.intake_id || "",
      comparison_id: this.data.comparison_id || "",
      risk_check_id: this.data.risk_check_id || "",
      action_type: actionType,
      status: finalStatus,
      payload_json: payload,
      result_json: resultJson || {
        message: this.getDefaultResultMessage(finalStatus),
        error_code: ""
      },
      created_at: now,
      updated_at: now
    };

    append(STORAGE_KEYS.NEXT_ACTIONS, action);
    return action;
  },

  createLead({ userId, actionId, leadType, status }) {
    const leadId = uid("lead");
    const now = nowIso();
    const riskLevel = this.resolveRiskLevel();
    const lead = {
      lead_id: leadId,
      user_id: userId,
      advisor_id: "",
      source_action_id: actionId,
      lead_type: leadType,
      status,
      summary_json: {
        intake_id: this.data.intake_id || "",
        comparison_id: this.data.comparison_id || "",
        risk_check_id: this.data.risk_check_id || "",
        listing_ids: this.data.listing_ids || [],
        source_page: this.data.source || "",
        risk_level: riskLevel
      },
      updated_at: now,
      created_at: now
    };
    append(STORAGE_KEYS.ADVISOR_LEADS, lead);

    trackEvent(EVENTS.LEAD_CREATED, {
      action_type: leadType,
      priority: "medium"
    });
    writeActivityLog({
      actor_type: "system",
      action_type: "lead_created",
      object_type: "advisor_lead",
      object_id: leadId,
      detail_json: {
        source_action_id: actionId,
        intake_id: this.data.intake_id || "",
        comparison_id: this.data.comparison_id || "",
        risk_check_id: this.data.risk_check_id || "",
        lead_type: leadType,
        status,
        risk_level: riskLevel
      }
    });
  },

  resolveRiskLevel() {
    if (this.data.risk_check && this.data.risk_check.risk_level) {
      return this.data.risk_check.risk_level;
    }
    if (!this.data.risk_check_id) {
      return "";
    }
    const userId = getSession().login_code;
    const riskChecks = get(STORAGE_KEYS.RISK_CHECKS, []);
    const riskCheck = riskChecks.find(
      (item) =>
        item.user_id === userId &&
        item.risk_check_id === this.data.risk_check_id
    );
    return riskCheck ? riskCheck.risk_level || "" : "";
  },

  createAppointment({ userId, actionId }) {
    const appointment = {
      appointment_id: uid("appointment"),
      action_id: actionId,
      user_id: userId,
      preferred_time: this.data.preferred_time,
      status: "pending_confirmed",
      advisor_id: "",
      notes: this.data.note_text || "",
      created_at: nowIso(),
      updated_at: nowIso()
    };
    append(STORAGE_KEYS.APPOINTMENTS, appointment);
  },

  markComparisonSent() {
    const comparisonId = this.data.comparison_id;
    if (!comparisonId) {
      return;
    }

    const userId = getSession().login_code;
    const reports = get(STORAGE_KEYS.COMPARISON_REPORTS, []);
    const nextReports = reports.map((item) => {
      if (item.user_id === userId && item.comparison_id === comparisonId) {
        return {
          ...item,
          status: "sent",
          updated_at: nowIso()
        };
      }
      return item;
    });
    set(STORAGE_KEYS.COMPARISON_REPORTS, nextReports);
  },

  saveForLater() {
    const route = this.buildCurrentRoute();
    set(STORAGE_KEYS.RECENT_CONTINUE_ROUTE, route);
  },

  buildCurrentRoute() {
    const query = [
      `source=${this.data.source}`,
      `intake_id=${encodeURIComponent(this.data.intake_id || "")}`,
      `comparison_id=${encodeURIComponent(this.data.comparison_id || "")}`,
      `risk_check_id=${encodeURIComponent(this.data.risk_check_id || "")}`,
      `listing_ids=${encodeURIComponent((this.data.listing_ids || []).join(","))}`,
      `action_type=${encodeURIComponent(this.data.selected_action || "")}`
    ].join("&");
    return `/pages/action/index?${query}`;
  }
});
