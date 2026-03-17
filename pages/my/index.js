const { isLoggedIn, requireLogin, getSession, getUserRole } = require("../../utils/auth");
const { EVENTS, trackEvent } = require("../../utils/track");
const { STORAGE_KEYS, get } = require("../../utils/storage");
const {
  DEFAULT_CONTINUE_ROUTE,
  resolveContinueContextFromStorage
} = require("../../utils/continue");

const APPOINTMENT_CONSULT_ACTIONS = ["consult", "appointment", "manual_review"];

function byUpdatedDesc(a, b) {
  const aTime = a.updated_at || a.created_at || "";
  const bTime = b.updated_at || b.created_at || "";
  return aTime > bTime ? -1 : 1;
}

function pickLatest(items) {
  if (!Array.isArray(items) || !items.length) {
    return null;
  }
  return [...items].sort(byUpdatedDesc)[0];
}

function getDisplayTime(item) {
  return (item && (item.updated_at || item.created_at)) || "-";
}

function formatActionText(action) {
  if (!action) {
    return "暂无动作记录";
  }
  return `${action.action_type}：${action.status}（${getDisplayTime(action)}）`;
}

function resolveContinueLaneText(route) {
  const text = String(route || "");
  if (text.startsWith("/pages/candidates/index") || text.startsWith("/pages/detail/index")) {
    return "传统搜索";
  }
  if (text.startsWith("/pages/admin")) {
    return "后台协同";
  }
  return "AI 咨询";
}

Page({
  data: {
    role_text: "user",
    can_access_admin: false,
    recent_continue_route: DEFAULT_CONTINUE_ROUTE,
    recent_continue_label: "需求录入页",
    continue_hint_text: "已定位到最近可继续节点。",
    continue_lane_text: "AI 咨询",
    latest_action_text: "暂无动作记录",
    latest_report_text: "暂无报告记录",
    latest_consult_appointment_text: "暂无预约/咨询记录",
    counts: {
      intakes: 0,
      listings: 0,
      comparisons: 0,
      reports: 0,
      reports_sent: 0,
      appointment_consults: 0,
      actions: 0
    }
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }
    trackEvent(EVENTS.PAGE_MY_VIEW);

    if (!isLoggedIn()) {
      requireLogin("/pages/my/index");
      return;
    }

    const session = getSession();
    const role = getUserRole();
    const userId = session.login_code;
    const intakes = get(STORAGE_KEYS.BUYER_INTAKES, []).filter(
      (item) => item.user_id === userId
    );
    const listings = get(STORAGE_KEYS.LISTINGS, []).filter(
      (item) => item.user_id === userId
    );
    const comparisons = get(STORAGE_KEYS.COMPARISON_REPORTS, []).filter(
      (item) => item.user_id === userId
    );
    const reportsSent = comparisons.filter((item) => item.status === "sent");
    const actions = get(STORAGE_KEYS.NEXT_ACTIONS, []).filter(
      (item) => item.user_id === userId
    );
    const appointmentConsultActions = actions.filter((item) =>
      APPOINTMENT_CONSULT_ACTIONS.includes(item.action_type)
    );
    const appointments = get(STORAGE_KEYS.APPOINTMENTS, []).filter(
      (item) => item.user_id === userId
    );
    const appointmentByActionId = {};
    appointments.forEach((item) => {
      appointmentByActionId[item.action_id] = item;
    });

    const latestAction = pickLatest(actions);
    const latestReport = pickLatest(comparisons);
    const latestConsultAppointment = pickLatest(appointmentConsultActions);
    const continueContext = resolveContinueContextFromStorage({
      userId,
      role
    });

    this.setData({
      role_text: role,
      can_access_admin: role === "advisor" || role === "admin",
      recent_continue_route: continueContext.route,
      recent_continue_label: continueContext.label,
      continue_hint_text: continueContext.hintText,
      continue_lane_text: resolveContinueLaneText(continueContext.route),
      latest_action_text: formatActionText(latestAction),
      latest_report_text: this.formatReportText(latestReport),
      latest_consult_appointment_text: this.formatConsultAppointmentText(
        latestConsultAppointment,
        appointmentByActionId
      ),
      counts: {
        intakes: intakes.length,
        listings: listings.length,
        comparisons: comparisons.length,
        reports: comparisons.length,
        reports_sent: reportsSent.length,
        appointment_consults: appointmentConsultActions.length,
        actions: actions.length
      }
    });
  },

  formatReportText(report) {
    if (!report) {
      return "暂无报告记录";
    }
    return `comparison_id=${report.comparison_id}：${report.status}（${getDisplayTime(report)}）`;
  },

  formatConsultAppointmentText(action, appointmentByActionId) {
    if (!action) {
      return "暂无预约/咨询记录";
    }
    if (action.action_type === "appointment") {
      const appointment = appointmentByActionId[action.action_id];
      const appointmentStatus = appointment ? appointment.status : "pending_confirmed";
      return `appointment：${appointmentStatus}（${getDisplayTime(action)}）`;
    }
    return `${action.action_type}：${action.status}（${getDisplayTime(action)}）`;
  },

  handleContinue() {
    wx.navigateTo({
      url: this.data.recent_continue_route || DEFAULT_CONTINUE_ROUTE,
      fail: () => {
        wx.showToast({
          title: "继续路由不可用，已回到需求录入",
          icon: "none"
        });
        wx.navigateTo({ url: DEFAULT_CONTINUE_ROUTE });
      }
    });
  },

  handleGoAdminLeads() {
    wx.navigateTo({
      url: "/pages/adminLeads/index"
    });
  }
});
