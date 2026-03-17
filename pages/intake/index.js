const { requireLogin, getSession } = require("../../utils/auth");
const { EVENTS, trackEvent, writeActivityLog } = require("../../utils/track");
const { STORAGE_KEYS, get, set, append, uid } = require("../../utils/storage");
const { syncBuyerIntake } = require("../../utils/cloud");

const USAGE_OPTIONS = ["自住", "父母住", "婚房", "改善", "投资"];

Page({
  data: {
    raw_text: "",
    city: "",
    budget_min: "",
    budget_max: "",
    usage_options: USAGE_OPTIONS,
    usage_index: 0,
    usage_type: USAGE_OPTIONS[0],
    max_concern: ""
  },

  onLoad() {
    const draft = get(STORAGE_KEYS.DRAFT_INTAKE, null);
    if (draft) {
      this.setData(draft, () => this.syncUsageIndex());
      return;
    }
    this.syncUsageIndex();
  },

  onShow() {
    trackEvent(EVENTS.PAGE_INTAKE_VIEW);
    set(STORAGE_KEYS.RECENT_CONTINUE_ROUTE, "/pages/intake/index");
  },

  handleInput(e) {
    const field = e.currentTarget.dataset.field;
    const value = e.detail.value;
    this.setData({
      [field]: value
    });
  },

  handleUsageChange(e) {
    const index = Number(e.detail.value || 0);
    const options = this.data.usage_options || [];
    this.setData({
      usage_index: index,
      usage_type: options[index] || USAGE_OPTIONS[0]
    });
  },

  syncUsageIndex() {
    const options = this.data.usage_options || [];
    const idx = options.indexOf(this.data.usage_type);
    this.setData({
      usage_index: idx >= 0 ? idx : 0,
      usage_type: idx >= 0 ? options[idx] : USAGE_OPTIONS[0]
    });
  },

  async handleSaveContinue() {
    const draft = { ...this.data };
    set(STORAGE_KEYS.DRAFT_INTAKE, draft);

    if (!requireLogin("/pages/intake/index")) {
      return;
    }

    if (!draft.raw_text || !draft.city) {
      wx.showToast({
        title: "请先填写需求描述和城市",
        icon: "none"
      });
      return;
    }

    const session = getSession();
    const now = new Date().toISOString();
    const intake = {
      intake_id: uid("intake"),
      user_id: session.login_code,
      raw_text: draft.raw_text,
      city: draft.city,
      budget_min: draft.budget_min ? Number(draft.budget_min) : null,
      budget_max: draft.budget_max ? Number(draft.budget_max) : null,
      usage_type: draft.usage_type,
      max_concern: draft.max_concern,
      status: "submitted",
      created_at: now,
      updated_at: now
    };

    append(STORAGE_KEYS.BUYER_INTAKES, intake);
    set(STORAGE_KEYS.DRAFT_INTAKE, null);

    try {
      await syncBuyerIntake(intake);
    } catch (err) {
      console.warn("[cloud] buyer_intake sync failed", err);
      writeActivityLog({
        actor_type: "system",
        actor_id: intake.user_id,
        action_type: "cloud_sync_failed",
        object_type: "buyer_intake",
        object_id: intake.intake_id,
        detail_json: {
          collection: "buyer_intakes",
          message: err && err.message ? err.message : "sync failed"
        }
      });
    }

    trackEvent(EVENTS.INTAKE_SUBMIT, {
      city: intake.city,
      budget_range: `${intake.budget_min || ""}-${intake.budget_max || ""}`,
      usage_type: intake.usage_type
    });

    writeActivityLog({
      actor_type: "user",
      actor_id: intake.user_id,
      action_type: "intake_submit",
      object_type: "buyer_intake",
      object_id: intake.intake_id,
      detail_json: { city: intake.city }
    });

    wx.showToast({
      title: "需求已保存",
      icon: "success"
    });

    set(STORAGE_KEYS.RECENT_CONTINUE_ROUTE, "/pages/ai/index");
    setTimeout(() => {
      wx.navigateTo({
        url: "/pages/ai/index"
      });
    }, 250);
  }
});
