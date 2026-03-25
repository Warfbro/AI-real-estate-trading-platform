const CRITICAL_MISSING_FIELDS = ["price_total", "area_sqm", "community_name", "title"];

function toNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function pickMaxLevel(levels) {
  if ((levels || []).includes("high")) return "high";
  if ((levels || []).includes("medium")) return "medium";
  return "low";
}

function toLevelText(level) {
  if (level === "high") return "高风险";
  if (level === "medium") return "中风险";
  return "低风险";
}

function hasCriticalMissing(item) {
  const missingFields = Array.isArray(item && item.missing_fields_json)
    ? item.missing_fields_json
    : [];
  return CRITICAL_MISSING_FIELDS.some((field) => missingFields.includes(field));
}

function buildRiskSummary(tags, riskLevel, manualReviewRequired) {
  if (!tags.length) {
    return "暂未识别到明显风险，可继续推进但建议保持信息核验。";
  }
  const base = `共识别 ${tags.length} 项风险，当前为${toLevelText(riskLevel)}。`;
  if (manualReviewRequired) {
    return `${base} 建议发起人工复核。`;
  }
  return base;
}

function evaluateRisk({ listings, intake }) {
  const safeListings = Array.isArray(listings) ? listings : [];
  const safeIntake = intake || null;
  const tags = [];
  const rulesHit = {
    missing_info: false,
    info_conflict: false,
    price_anomaly: false,
    cost_pressure: false,
    sample_limited: false,
    manual_review_required: false
  };

  const missingHeavyCount = safeListings.filter(
    (item) => (Array.isArray(item.missing_fields_json) ? item.missing_fields_json.length : 0) >= 2
  ).length;
  const criticalMissingCount = safeListings.filter((item) => hasCriticalMissing(item)).length;
  if (missingHeavyCount > 0 || criticalMissingCount > 0) {
    rulesHit.missing_info = true;
    tags.push({
      code: "RISK_MISSING_INFO",
      title: "信息不完整",
      level: "medium",
      evidence: `缺失较多房源 ${missingHeavyCount} 套，关键字段缺失 ${criticalMissingCount} 套`,
      explanation: "关键字段缺失会降低比较和风险结论可信度。",
      action_suggestion: "补全总价、面积、小区等核心字段后再决策。"
    });
  }

  const priceValues = safeListings
    .map((item) => toNumber(item && item.price_total))
    .filter((value) => value !== null && value > 0);
  if (priceValues.length >= 2) {
    const min = Math.min(...priceValues);
    const max = Math.max(...priceValues);
    if (min > 0 && max / min >= 1.4) {
      rulesHit.price_anomaly = true;
      tags.push({
        code: "RISK_PRICE_ANOMALY",
        title: "价格异常待确认",
        level: "medium",
        evidence: `同批房源价格跨度较大：${min}万~${max}万`,
        explanation: "价格差异明显，需核对房源条件和真实成交背景。",
        action_suggestion: "补充同区域同户型样本并核验房源真实性。"
      });
    }
  }

  if (safeIntake && safeIntake.city) {
    const cityMismatchCount = safeListings.filter(
      (item) => item && item.city && item.city !== safeIntake.city
    ).length;
    if (cityMismatchCount > 0) {
      rulesHit.info_conflict = true;
      tags.push({
        code: "RISK_INFO_CONFLICT",
        title: "信息不一致",
        level: "medium",
        evidence: `${cityMismatchCount} 套房源与需求城市 ${safeIntake.city} 不一致`,
        explanation: "需求条件与候选房源上下文不一致，会影响推荐和比较结果。",
        action_suggestion: "确认需求城市并排除无关房源后重新比较。"
      });
    }
  }

  const budgetMax = safeIntake ? toNumber(safeIntake.budget_max) : null;
  if (budgetMax !== null) {
    const overBudgetCount = safeListings.filter((item) => {
      const priceTotal = toNumber(item && item.price_total);
      return priceTotal !== null && priceTotal > budgetMax;
    }).length;

    if (overBudgetCount > 0) {
      rulesHit.cost_pressure = true;
      tags.push({
        code: "RISK_COST_PRESSURE",
        title: "成本压力偏高",
        level: "high",
        evidence: `${overBudgetCount} 套房源超出预算上限 ${budgetMax}万`,
        explanation: "超预算会提升交易与持有成本压力，需评估现金流风险。",
        action_suggestion: "优先保留预算内方案，或降低面积/区域要求。"
      });
    } else {
      const nearBudgetCount = safeListings.filter((item) => {
        const priceTotal = toNumber(item && item.price_total);
        return priceTotal !== null && priceTotal >= budgetMax * 0.9;
      }).length;
      if (nearBudgetCount > 0) {
        rulesHit.cost_pressure = true;
        tags.push({
          code: "RISK_BUDGET_EDGE",
          title: "预算边缘压力",
          level: "medium",
          evidence: `${nearBudgetCount} 套房源接近预算上限 ${budgetMax}万`,
          explanation: "接近预算上限会压缩后续议价与持有成本缓冲空间。",
          action_suggestion: "预留税费、装修与交易成本，再判断可承受区间。"
        });
      }
    }
  }

  if (safeListings.length <= 1) {
    rulesHit.sample_limited = true;
    tags.push({
      code: "RISK_SAMPLE_LIMITED",
      title: "样本不足",
      level: "low",
      evidence: "参与风险确认的房源数量不足 2 套",
      explanation: "样本过少会降低横向比较参考价值。",
      action_suggestion: "建议补充同区域同预算候选后再次评估。"
    });
  }

  const riskLevel = pickMaxLevel(tags.map((item) => item.level));
  const manualReviewRequired = Boolean(
    riskLevel === "high" ||
      (rulesHit.info_conflict && rulesHit.price_anomaly) ||
      (rulesHit.missing_info && rulesHit.cost_pressure)
  );
  rulesHit.manual_review_required = manualReviewRequired;

  if (manualReviewRequired) {
    tags.push({
      code: "RISK_MANUAL_REVIEW",
      title: "建议人工复核",
      level: riskLevel === "high" ? "high" : "medium",
      evidence: "命中人工复核触发条件",
      explanation: "当前风险条件较复杂，建议顾问介入复核关键信息。",
      action_suggestion: "发起人工复核并暂停高风险推进动作。"
    });
  }

  const summary = buildRiskSummary(tags, riskLevel, manualReviewRequired);
  return {
    riskLevel,
    tags,
    summary,
    manualReviewRequired,
    rulesHit
  };
}

module.exports = {
  evaluateRisk,
  pickMaxLevel,
  toLevelText
};
