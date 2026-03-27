const { isLoggedIn, requireLogin, getSession } = require("../../utils/auth");
const { EVENTS, trackEvent, writeActivityLog } = require("../../utils/track");
const { STORAGE_KEYS, get, set, append, uid } = require("../../utils/storage");
const { intakeRepo } = require("../../repos");
const { evaluateRisk, toLevelText } = require("../../utils/risk");

function byUpdatedDesc(a, b) {
  return a.updated_at > b.updated_at ? -1 : 1;
}

Page({
  data: {
    source: "comparison",
    source_text: "比较结果",
    intake_id: "",
    intake_id_text: "无",
    listing_ids: [],
    comparison_id: "",
    has_comparison_id: false,
    intake: null,
    selected_listings: [],
    selected_count_text: "0",
    has_selected_listings: false,
    generated: false,
    risk_check_id: "",
    risk_level: "low",
    risk_level_text: "低风险",
    risk_summary_text: "",
    risk_tags: [],
    has_risk_tags: false,
    manual_review_required: false
  },

  onLoad(options) {
    const listingIds = options.listing_ids
      ? decodeURIComponent(options.listing_ids).split(",").filter(Boolean)
      : [];
    const singleListingId = options.listing_id ? decodeURIComponent(options.listing_id) : "";

    this.setData({
      source: options.source || "comparison",
      intake_id: options.intake_id ? decodeURIComponent(options.intake_id) : "",
      listing_ids: listingIds.length ? listingIds : singleListingId ? [singleListingId] : [],
      comparison_id: options.comparison_id ? decodeURIComponent(options.comparison_id) : ""
    }, () => this.syncContextView());
  },

  onShow() {
    const query = [
      `source=${this.data.source}`,
      `intake_id=${encodeURIComponent(this.data.intake_id || "")}`,
      `comparison_id=${encodeURIComponent(this.data.comparison_id || "")}`,
      `listing_ids=${encodeURIComponent((this.data.listing_ids || []).join(","))}`
    ].join("&");

    if (!isLoggedIn()) {
      requireLogin(`/pages/risk/index?${query}`);
      return;
    }

    trackEvent(EVENTS.PAGE_RISK_VIEW, {
      source: this.data.source,
      comparison_id: this.data.comparison_id || "",
      listing_count: (this.data.listing_ids || []).length
    });
    this.bootstrap();
  },

  bootstrap() {
    const session = getSession();
    const allListings = get(STORAGE_KEYS.LISTINGS, []).filter(
      (item) => item.user_id === session.login_code && item.status === "active"
    );

    let listingIds = [...this.data.listing_ids];
    let intakeId = this.data.intake_id;

    if (this.data.comparison_id) {
      const reports = get(STORAGE_KEYS.COMPARISON_REPORTS, []).filter(
        (item) => item.user_id === session.login_code
      );
      const report = reports.find((item) => item.comparison_id === this.data.comparison_id);
      if (report) {
        listingIds = report.listing_ids_json || listingIds;
        intakeId = intakeId || report.intake_id || "";
      }
    }

    const selectedListings = listingIds
      .map((id) => allListings.find((item) => item.listing_id === id))
      .filter(Boolean);

    const intakeResult = intakeRepo.getIntakes({ userId: session.login_code, status: "submitted" });
    const intakesRaw = intakeResult && intakeResult.status === "success" ? intakeResult.data : [];
    const intakes = intakesRaw.slice().sort(byUpdatedDesc);
    const intake =
      intakes.find((item) => intakeId && item.intake_id === intakeId) ||
      (intakes.length ? intakes[0] : null);

    this.setData({
      listing_ids: listingIds,
      intake_id: intake ? intake.intake_id : "",
      intake,
      selected_listings: selectedListings.map((item, idx) => ({
        ...item,
        display_line: this.buildSelectedListingLine(item, idx + 1)
      }))
    }, () => this.syncContextView());
  },

  syncContextView() {
    const source = this.data.source;
    const sourceText = source === "listing" ? "单房源" : "比较结果";
    const intakeId = this.data.intake_id || "";
    const selectedListings = this.data.selected_listings || [];
    this.setData({
      source_text: sourceText,
      intake_id_text: intakeId || "无",
      has_comparison_id: Boolean(this.data.comparison_id),
      selected_count_text: String(selectedListings.length),
      has_selected_listings: selectedListings.length > 0
    });
  },

  buildSelectedListingLine(item, rankNo) {
    const title = item.title || "待完善房源";
    const price =
      item.price_total === null || item.price_total === undefined ? "待补充" : `${item.price_total}万`;
    const missingCount = Array.isArray(item.missing_fields_json) ? item.missing_fields_json.length : 0;
    return `${rankNo}. ${title} ｜ 总价：${price} ｜ 缺失字段：${missingCount}项`;
  },

  handleGenerateRisk() {
    const listings = this.data.selected_listings;
    if (!listings.length) {
      wx.showToast({
        title: "缺少可用于风险确认的房源",
        icon: "none"
      });
      return;
    }

    const intake = this.data.intake;
    const evaluation = evaluateRisk({
      listings,
      intake
    });
    const riskLevel = evaluation.riskLevel;
    const tags = evaluation.tags;
    const summary = evaluation.summary;
    const manualReviewRequired = evaluation.manualReviewRequired;

    const riskCheckId = uid("risk");
    const now = new Date().toISOString();
    const session = getSession();

    const riskCheck = {
      risk_check_id: riskCheckId,
      user_id: session.login_code,
      intake_id: this.data.intake_id || "",
      listing_ids_json: listings.map((item) => item.listing_id),
      risk_level: riskLevel,
      risk_tags_json: tags,
      risk_rules_hit_json: {
        ...evaluation.rulesHit,
        rule_codes: tags.map((item) => item.code),
        manual_review_required: manualReviewRequired
      },
      risk_summary_text: summary,
      manual_review_required: manualReviewRequired,
      created_at: now,
      updated_at: now
    };

    append(STORAGE_KEYS.RISK_CHECKS, riskCheck);

    this.setData({
      generated: true,
      risk_check_id: riskCheckId,
      risk_level: riskLevel,
      risk_level_text: toLevelText(riskLevel),
      risk_summary_text: summary,
      risk_tags: tags,
      has_risk_tags: tags.length > 0,
      manual_review_required: manualReviewRequired
    });

    trackEvent(EVENTS.RISK_GENERATE, {
      risk_level: riskLevel,
      risk_tag_count: tags.length,
      manual_review_required: manualReviewRequired
    });

    writeActivityLog({
      actor_type: "user",
      actor_id: session.login_code,
      action_type: "risk_generate",
      object_type: "risk_check",
      object_id: riskCheckId,
      detail_json: {
        risk_level: riskLevel,
        risk_tag_count: tags.length
      }
    });

    wx.showToast({
      title: "风险结果已生成",
      icon: "success"
    });
  },

  handleManualReviewHint() {
    if (!this.data.generated) {
      wx.showToast({
        title: "请先生成风险结果",
        icon: "none"
      });
      return;
    }
    wx.navigateTo({
      url: `/pages/action/index?${this.buildActionQuery("manual_review")}`
    });
  },

  handleNextActionHint() {
    if (!this.data.generated) {
      wx.showToast({
        title: "请先生成风险结果",
        icon: "none"
      });
      return;
    }
    wx.navigateTo({
      url: `/pages/action/index?${this.buildActionQuery("")}`
    });
  },

  buildActionQuery(defaultAction) {
    const query = [
      `source=risk`,
      `intake_id=${encodeURIComponent(this.data.intake_id || "")}`,
      `comparison_id=${encodeURIComponent(this.data.comparison_id || "")}`,
      `risk_check_id=${encodeURIComponent(this.data.risk_check_id || "")}`,
      `listing_ids=${encodeURIComponent((this.data.listing_ids || []).join(","))}`,
      `action_type=${encodeURIComponent(defaultAction || "")}`
    ];
    return query.join("&");
  }
});
