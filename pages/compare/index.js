const { isLoggedIn, requireLogin, getSession } = require("../../utils/auth");
const { EVENTS, trackEvent, writeActivityLog } = require("../../utils/track");
const { STORAGE_KEYS, get, set, append, uid } = require("../../utils/storage");
const { listingRepo, intakeRepo } = require("../../repos");

function byUpdatedDesc(a, b) {
  return a.updated_at > b.updated_at ? -1 : 1;
}

function toDisplay(value, suffix = "") {
  if (value === null || value === undefined || value === "") {
    return "待补充";
  }
  return `${value}${suffix}`;
}

function uniqueCount(values) {
  const normalized = values.map((item) =>
    item === null || item === undefined || item === "" ? "NULL_VALUE" : String(item)
  );
  return new Set(normalized).size;
}

Page({
  data: {
    intake: null,
    selected_ids: [],
    selected_listings: [],
    selected_count_text: "0",
    has_selected_listings: false,
    matrix_rows: [],
    ranking: [],
    tradeoffs: [],
    followup_questions: [],
    generated: false,
    saved: false,
    last_comparison_id: ""
  },

  onShow() {
    if (!isLoggedIn()) {
      requireLogin("/pages/compare/index");
      return;
    }

    trackEvent(EVENTS.PAGE_COMPARE_VIEW);
    this.bootstrap();
  },

  bootstrap() {
    const session = getSession();
    
    // 通过 listingRepo 获取比较列表和所有房源
    const selectedIds = listingRepo.getCompareIds();
    const listingResult = listingRepo.getListings({ userId: session.login_code, includeInactive: false });
    const allListings =
      listingResult && listingResult.status === "success" ? listingResult.data : [];
    
    const selectedListingsRaw = selectedIds
      .map((id) => allListings.find((item) => item.listing_id === id))
      .filter(Boolean);
    const selectedListings = selectedListingsRaw.map((item, idx) => ({
      ...item,
      display_line: this.buildSelectedListingLine(item, idx + 1)
    }));

    const intakeResult = intakeRepo.getIntakes({ userId: session.login_code, status: "submitted" });
    const intakesRaw = intakeResult && intakeResult.status === "success" ? intakeResult.data : [];
    const intakes = intakesRaw.slice().sort(byUpdatedDesc);
    const intake = intakes.length ? intakes[0] : null;

    this.setData({
      intake,
      selected_ids: selectedIds,
      selected_listings: selectedListings,
      selected_count_text: String(selectedListings.length),
      has_selected_listings: selectedListings.length > 0
    });
  },

  buildSelectedListingLine(item, rankNo) {
    const title = item.title || "待完善房源";
    const price =
      item.price_total === null || item.price_total === undefined ? "待补充" : `${item.price_total}万`;
    const area = item.area_sqm === null || item.area_sqm === undefined ? "待补充" : `${item.area_sqm}㎡`;
    return `${rankNo}. ${title} ｜ 总价：${price} ｜ 面积：${area}`;
  },

  handleGenerateCompare() {
    const listings = this.data.selected_listings;
    if (listings.length < 2) {
      wx.showToast({
        title: "至少选择2套房源",
        icon: "none"
      });
      return;
    }
    if (listings.length > 5) {
      wx.showToast({
        title: "最多比较5套房源",
        icon: "none"
      });
      return;
    }

    const matrixRows = this.buildMatrixRows(listings);
    const rankingResult = this.buildRanking(listings, this.data.intake);
    const tradeoffs = this.buildTradeoffs(matrixRows);
    const followup = this.buildFollowupQuestions(listings, matrixRows);

    this.setData({
      matrix_rows: matrixRows,
      ranking: rankingResult,
      tradeoffs,
      followup_questions: followup,
      generated: true,
      saved: false,
      last_comparison_id: ""
    });

    trackEvent(EVENTS.COMPARE_GENERATE, {
      listing_count: listings.length
    });

    writeActivityLog({
      actor_type: "user",
      actor_id: getSession().login_code,
      action_type: "comparison_generate",
      object_type: "comparison_preview",
      detail_json: {
        listing_ids: listings.map((item) => item.listing_id)
      }
    });
  },

  buildMatrixRows(listings) {
    const dimensions = [
      {
        key: "price_total",
        label: "总价",
        suffix: "万"
      },
      {
        key: "area_sqm",
        label: "面积",
        suffix: "㎡"
      },
      {
        key: "layout_desc",
        label: "户型",
        suffix: ""
      },
      {
        key: "community_name",
        label: "小区",
        suffix: ""
      },
      {
        key: "missing_fields_json",
        label: "缺失字段数",
        suffix: "项",
        transform: (value) => (Array.isArray(value) ? value.length : 0)
      }
    ];

    return dimensions.map((dimension) => {
      const valuesRaw = listings.map((listing) => {
        if (typeof dimension.transform === "function") {
          return dimension.transform(listing[dimension.key]);
        }
        return listing[dimension.key];
      });
      return {
        label: dimension.label,
        highlight: uniqueCount(valuesRaw) > 1,
        row_class: uniqueCount(valuesRaw) > 1 ? "matrix-row highlight" : "matrix-row",
        values: valuesRaw.map((value) => toDisplay(value, dimension.suffix))
      };
    });
  },

  buildRanking(listings, intake) {
    const scored = listings.map((listing) => {
      let score = 100;
      const reasons = [];

      if (intake && intake.budget_max !== null && listing.price_total !== null) {
        if (listing.price_total <= intake.budget_max) {
          score += 10;
          reasons.push("预算内");
        } else {
          score -= 15;
          reasons.push("超预算");
        }
      }

      if (intake && intake.city && listing.city && intake.city === listing.city) {
        score += 5;
        reasons.push("城市匹配");
      }

      const missing = (listing.missing_fields_json || []).length;
      score -= missing * 4;
      if (missing > 0) {
        reasons.push(`缺失${missing}项字段`);
      }

      if (!reasons.length) {
        reasons.push("信息待补充");
      }

      return {
        listing_id: listing.listing_id,
        title: listing.title || "待完善房源",
        score,
        reasons,
        reason_text: reasons.join(" · "),
        rank_index_text: ""
      };
    });
    return scored.sort((a, b) => b.score - a.score).map((item, index) => ({
      ...item,
      rank_index_text: `${index + 1}.`
    }));
  },

  buildTradeoffs(matrixRows) {
    const lines = [];
    const priceRow = matrixRows.find((row) => row.label === "总价");
    const areaRow = matrixRows.find((row) => row.label === "面积");

    if (priceRow && priceRow.highlight) {
      lines.push("总价存在明显差异，需在预算压力与房源条件间权衡。");
    }
    if (areaRow && areaRow.highlight) {
      lines.push("面积差异较大，需权衡空间需求与预算。");
    }
    if (!lines.length) {
      lines.push("核心维度差异不大，建议关注缺失字段和风险项。");
    }
    return lines;
  },

  buildFollowupQuestions(listings, matrixRows) {
    const questions = [];
    const missingRow = matrixRows.find((row) => row.label === "缺失字段数");
    if (missingRow && missingRow.values.some((item) => item !== "0项")) {
      questions.push("缺失字段是否需要补全后再做最终决定？");
    }
    if (listings.some((item) => !item.price_total)) {
      questions.push("是否补充总价信息以提高比较可信度？");
    }
    questions.push("是否需要进入风险确认页查看潜在问题？");
    return questions;
  },

  handleSaveCompare() {
    if (!this.data.generated) {
      wx.showToast({
        title: "请先生成比较结果",
        icon: "none"
      });
      return;
    }

    if (this.data.saved && this.data.last_comparison_id) {
      wx.showToast({
        title: "已保存本次比较",
        icon: "none"
      });
      return;
    }

    const session = getSession();
    const comparisonId = uid("comparison");
    const now = new Date().toISOString();
    const report = {
      comparison_id: comparisonId,
      user_id: session.login_code,
      intake_id: this.data.intake ? this.data.intake.intake_id : "",
      listing_ids_json: this.data.selected_listings.map((item) => item.listing_id),
      comparison_result_json: {
        matrix: this.data.matrix_rows,
        ranking: this.data.ranking,
        tradeoffs: this.data.tradeoffs,
        followup_questions: this.data.followup_questions
      },
      report_text: this.data.ranking.length
        ? `首选：${this.data.ranking[0].title}，建议结合风险页继续确认。`
        : "暂无推荐结果",
      status: "generated",
      created_at: now,
      updated_at: now
    };

    append(STORAGE_KEYS.COMPARISON_REPORTS, report);
    this.setData({
      saved: true,
      last_comparison_id: comparisonId
    });

    trackEvent(EVENTS.COMPARE_SAVE, {
      comparison_id: comparisonId,
      listing_count: report.listing_ids_json.length
    });

    writeActivityLog({
      actor_type: "user",
      actor_id: session.login_code,
      action_type: "comparison_save",
      object_type: "comparison_report",
      object_id: comparisonId,
      detail_json: {
        listing_count: report.listing_ids_json.length
      }
    });

    wx.showToast({
      title: "比较已保存",
      icon: "success"
    });
  },

  handleGoCandidates() {
    wx.navigateTo({
      url: "/pages/candidates/index"
    });
  },

  handleGoRisk() {
    if (!this.data.generated) {
      wx.showToast({
        title: "请先生成比较结果",
        icon: "none"
      });
      return;
    }

    const listingIds = this.data.selected_listings.map((item) => item.listing_id);
    if (listingIds.length < 1) {
      wx.showToast({
        title: "缺少可用于风险确认的房源",
        icon: "none"
      });
      return;
    }

    const query = [
      `source=comparison`,
      `listing_ids=${encodeURIComponent(listingIds.join(","))}`,
      `comparison_id=${encodeURIComponent(this.data.last_comparison_id || "")}`,
      `intake_id=${encodeURIComponent(this.data.intake ? this.data.intake.intake_id : "")}`
    ].join("&");

    wx.navigateTo({
      url: `/pages/risk/index?${query}`
    });
  }
});
