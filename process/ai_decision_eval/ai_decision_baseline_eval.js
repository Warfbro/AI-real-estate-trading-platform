const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const datasetPath = path.resolve(__dirname, "ai_decision_eval_dataset.json");
const reportPathArgIndex = process.argv.indexOf("--out");
const reportPath =
  reportPathArgIndex >= 0 && process.argv[reportPathArgIndex + 1]
    ? path.resolve(process.cwd(), process.argv[reportPathArgIndex + 1])
    : "";

if (!process.env.OPENAI_COMPAT_TIMEOUT_MS) {
  process.env.OPENAI_COMPAT_TIMEOUT_MS = "30000";
}

const decisionEngine = require("../../cloudfunctions/decisionEngine/index");
const { createInitialDecisionState } = require("../../cloudfunctions/decisionEngine/lib/preferenceUpdater");
const { filterFeasibleListings } = require("../../cloudfunctions/decisionEngine/lib/feasibilityEngine");
const { rankListings } = require("../../cloudfunctions/decisionEngine/lib/decisionRanker");
const { sanitizeListing } = require("../../cloudfunctions/decisionEngine/lib/featureExtractor");
const openaiCompatibleProvider = require("../../cloudfunctions/queryPropertyRecommend/providers/openaiCompatible");

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const DEFAULT_MODEL = "qwen-plus";

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readApiKeyFallback() {
  const filePath = path.resolve(__dirname, "../..", "新需求", "apikey");
  if (!fs.existsSync(filePath)) {
    return "";
  }
  return normalizeText(fs.readFileSync(filePath, "utf8"));
}

function getEnvValue(keys, fallback = "") {
  for (const key of keys) {
    const value = normalizeText(process.env[key]);
    if (value) {
      return value;
    }
  }
  return fallback;
}

function normalizeProxyUrl(value) {
  const text = normalizeText(value);
  if (!text) {
    return "";
  }
  if (/^https?:\/\//i.test(text)) {
    return text;
  }
  return `http://${text}`;
}

function detectWindowsProxyUrl() {
  try {
    const command = [
      "$item = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';",
      "if ($item.ProxyEnable -eq 1 -and $item.ProxyServer) {",
      "  Write-Output $item.ProxyServer",
      "}"
    ].join(" ");
    const output = cp.execSync(`powershell -NoProfile -Command "${command}"`, {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const raw = normalizeText(output);
    if (!raw) {
      return "";
    }
    if (raw.includes("=")) {
      const httpsMatch = raw.match(/https=([^;]+)/i);
      const httpMatch = raw.match(/http=([^;]+)/i);
      return normalizeProxyUrl((httpsMatch && httpsMatch[1]) || (httpMatch && httpMatch[1]) || "");
    }
    return normalizeProxyUrl(raw);
  } catch (err) {
    return "";
  }
}

function ensureProviderEnv() {
  if (!getEnvValue(["OPENAI_COMPAT_API_KEY", "BAILIAN_API_KEY", "DASHSCOPE_API_KEY"])) {
    const fallbackKey = readApiKeyFallback();
    if (fallbackKey) {
      process.env.OPENAI_COMPAT_API_KEY = fallbackKey;
    }
  }
  if (!getEnvValue(["OPENAI_COMPAT_BASE_URL", "BAILIAN_COMPAT_BASE_URL", "DASHSCOPE_BASE_URL"])) {
    process.env.OPENAI_COMPAT_BASE_URL = DEFAULT_BASE_URL;
  }
  if (!getEnvValue(["OPENAI_COMPAT_MODEL", "BAILIAN_COMPAT_MODEL", "DASHSCOPE_MODEL"])) {
    process.env.OPENAI_COMPAT_MODEL = DEFAULT_MODEL;
  }
  if (!process.env.OPENAI_COMPAT_PROXY_URL && !process.env.HTTPS_PROXY && !process.env.HTTP_PROXY) {
    const detectedProxy = detectWindowsProxyUrl();
    if (detectedProxy) {
      process.env.OPENAI_COMPAT_PROXY_URL = detectedProxy;
      process.env.HTTPS_PROXY = detectedProxy;
      process.env.HTTP_PROXY = detectedProxy;
    }
  }
}

function uniqueIds(value) {
  const source = Array.isArray(value) ? value : [value];
  const ids = [];
  source.forEach((item) => {
    const text = normalizeText(item);
    if (text && !ids.includes(text)) {
      ids.push(text);
    }
  });
  return ids;
}

function getListingMap(caseItem) {
  const map = new Map();
  (caseItem.listings || []).forEach((listing) => {
    const safe = sanitizeListing(listing);
    if (safe && safe.listing_id) {
      map.set(safe.listing_id, safe);
    }
  });
  return map;
}

function getListingById(caseItem, listingId) {
  return getListingMap(caseItem).get(normalizeText(listingId)) || null;
}

function buildInteractionTranscript(caseItem) {
  return (caseItem.interactions || [])
    .map((item, index) => {
      if (item.type === "pairwise") {
        return `${index + 1}. 二选一：更偏向 ${normalizeText(item.winner_listing_id)}，不选 ${normalizeText(
          item.loser_listing_id
        )}。${normalizeText(item.spoken_preference)}`;
      }
      if (item.type === "critique") {
        return `${index + 1}. 文字修正：${normalizeText(item.text)}`;
      }
      return `${index + 1}. ${normalizeText(item.spoken_preference || item.text)}`;
    })
    .filter(Boolean)
    .join("\n");
}

function buildListingPrompt(caseItem) {
  return (caseItem.listings || [])
    .map((item) => {
      const safe = sanitizeListing(item) || {};
      return [
        `listing_id=${safe.listing_id}`,
        `title=${normalizeText(safe.title)}`,
        `price_total=${safe.price_total == null ? "null" : safe.price_total}`,
        `area_sqm=${safe.area_sqm == null ? "null" : safe.area_sqm}`,
        `layout_desc=${normalizeText(safe.layout_desc)}`,
        `district=${normalizeText(safe.district)}`,
        `elevator_flag=${safe.elevator_flag == null ? "null" : safe.elevator_flag}`,
        `missing_fields=${Array.isArray(safe.missing_fields_json) ? safe.missing_fields_json.length : 0}`
      ].join(" | ");
    })
    .join("\n");
}

function buildLlmQuery(caseItem) {
  const interactions = buildInteractionTranscript(caseItem);
  const listingLines = buildListingPrompt(caseItem);
  return [
    "请根据用户需求，从给定候选房源中直接做推荐排序。",
    "只能使用给定的 listing_id，禁止编造不存在的 listing_id。",
    "请把最推荐的 3 套房源按优先级放在 recommendations 数组中。",
    "每条 recommendation 至少包含 listing_id、recommendation、match_highlights、concerns。",
    `用户原始需求：${normalizeText(caseItem.query)}`,
    interactions ? `用户后续反馈：\n${interactions}` : "用户后续反馈：无",
    `候选房源：\n${listingLines}`
  ].join("\n");
}

function extractRecommendationIds(result, caseItem) {
  const allowedIds = new Set((caseItem.listings || []).map((item) => normalizeText(item.listing_id)));
  const ids = [];
  const recommendations = Array.isArray(result && result.data && result.data.recommendations)
    ? result.data.recommendations
    : [];

  recommendations.forEach((item) => {
    const listingId = normalizeText(
      (item && item.listing_id) ||
        (item && item.id) ||
        (item && item.listing_detail && item.listing_detail.listing_id)
    );
    if (listingId && allowedIds.has(listingId) && !ids.includes(listingId)) {
      ids.push(listingId);
    }
  });

  if (ids.length) {
    return ids;
  }

  const fallbackText = JSON.stringify(result || {});
  Array.from(allowedIds).forEach((listingId) => {
    if (fallbackText.includes(listingId) && !ids.includes(listingId)) {
      ids.push(listingId);
    }
  });
  return ids;
}

function buildErrorResult({ code, message, traceId, durationMs, details, mode }) {
  return {
    success: false,
    data: null,
    error: {
      code,
      message,
      details
    },
    meta: {
      trace_id: traceId,
      duration_ms: durationMs,
      mode
    }
  };
}

async function runCurrentSystem(caseItem) {
  const start = await decisionEngine.main(
    {
      action: "start",
      user_id: `eval_user_${caseItem.case_id}`,
      chat_session_id: `eval_chat_${caseItem.case_id}`,
      context: caseItem.context || {},
      local_listings: caseItem.listings || []
    },
    {}
  );
  if (!start.success) {
    return {
      ranking: [],
      raw: start,
      error: normalizeText(start.error && start.error.code, "CURRENT_START_FAILED")
    };
  }

  const decisionSessionId = normalizeText(start.data && start.data.decision_session_id);
  let current = start;
  for (const interaction of caseItem.interactions || []) {
    if (interaction.type === "pairwise") {
      current = await decisionEngine.main(
        {
          action: "pairwise",
          decision_session_id: decisionSessionId,
          winner_listing_id: normalizeText(interaction.winner_listing_id),
          loser_listing_id: normalizeText(interaction.loser_listing_id),
          local_listings: caseItem.listings || []
        },
        {}
      );
    } else if (interaction.type === "critique") {
      current = await decisionEngine.main(
        {
          action: "critique",
          decision_session_id: decisionSessionId,
          text: normalizeText(interaction.text),
          local_listings: caseItem.listings || []
        },
        {}
      );
    }
    if (!current.success) {
      return {
        ranking: [],
        raw: current,
        error: normalizeText(current.error && current.error.code, "CURRENT_INTERACTION_FAILED")
      };
    }
  }

  const state = await decisionEngine.main(
    {
      action: "state",
      decision_session_id: decisionSessionId,
      local_listings: caseItem.listings || []
    },
    {}
  );
  if (!state.success) {
    return {
      ranking: [],
      raw: state,
      error: normalizeText(state.error && state.error.code, "CURRENT_STATE_FAILED")
    };
  }

  return {
    ranking: uniqueIds((state.data && state.data.top_listing_ids) || []),
    raw: state,
    error: ""
  };
}

function sortRuleListings(listings, state) {
  const layoutPref = normalizeText(state && state.hard_constraints && state.hard_constraints.layout_pref).toLowerCase();
  return listings
    .map((item) => sanitizeListing(item))
    .filter(Boolean)
    .sort((a, b) => {
      const aLayout = layoutPref && normalizeText(a.layout_desc).toLowerCase().includes(layoutPref) ? 1 : 0;
      const bLayout = layoutPref && normalizeText(b.layout_desc).toLowerCase().includes(layoutPref) ? 1 : 0;
      if (bLayout !== aLayout) return bLayout - aLayout;

      const aPrice = Number.isFinite(a.price_total) ? a.price_total : Number.POSITIVE_INFINITY;
      const bPrice = Number.isFinite(b.price_total) ? b.price_total : Number.POSITIVE_INFINITY;
      if (aPrice !== bPrice) return aPrice - bPrice;

      const aArea = Number.isFinite(a.area_sqm) ? a.area_sqm : -1;
      const bArea = Number.isFinite(b.area_sqm) ? b.area_sqm : -1;
      if (bArea !== aArea) return bArea - aArea;

      const aElevator = a.elevator_flag === true ? 1 : 0;
      const bElevator = b.elevator_flag === true ? 1 : 0;
      if (bElevator !== aElevator) return bElevator - aElevator;

      const aMissing = Array.isArray(a.missing_fields_json) ? a.missing_fields_json.length : 99;
      const bMissing = Array.isArray(b.missing_fields_json) ? b.missing_fields_json.length : 99;
      if (aMissing !== bMissing) return aMissing - bMissing;

      return normalizeText(a.listing_id).localeCompare(normalizeText(b.listing_id), "zh-Hans-CN");
    });
}

function runRuleBaseline(caseItem) {
  const state = createInitialDecisionState(caseItem.context || {}, []);
  const feasibility = filterFeasibleListings(caseItem.listings || [], state.hard_constraints || {});
  const candidates = feasibility.feasibleListings.length ? feasibility.feasibleListings : caseItem.listings || [];
  const ranking = sortRuleListings(candidates, state).map((item) => item.listing_id);
  return {
    ranking,
    raw: {
      blockers: feasibility.blockers,
      feasible_count: feasibility.feasibleCount
    },
    error: ""
  };
}

function runAblationBaseline(caseItem) {
  const state = createInitialDecisionState(caseItem.context || {}, []);
  const feasibility = filterFeasibleListings(caseItem.listings || [], state.hard_constraints || {});
  const ranked = rankListings(feasibility.feasibleListings, state);
  return {
    ranking: uniqueIds(ranked.topListingIds || []),
    raw: {
      blockers: feasibility.blockers,
      feasible_count: feasibility.feasibleCount,
      buckets: ranked.buckets
    },
    error: ""
  };
}

async function runLlmBaseline(caseItem) {
  const apiKey = getEnvValue(["OPENAI_COMPAT_API_KEY", "BAILIAN_API_KEY", "DASHSCOPE_API_KEY"]);
  if (!apiKey) {
    return {
      ranking: [],
      raw: null,
      error: "LLM_API_KEY_MISSING",
      skipped: true
    };
  }

  const result = await openaiCompatibleProvider.request(
    {
      query: buildLlmQuery(caseItem),
      userId: `eval_user_${caseItem.case_id}`,
      sessionId: `eval_llm_${caseItem.case_id}`,
      context: {
        active_intake: (caseItem.context && caseItem.context.active_intake) || {},
        memory_profile: (caseItem.context && caseItem.context.memory_profile) || {},
        flow_stage: "ranking"
      }
    },
    {
      traceId: `eval_llm_${caseItem.case_id}_${Date.now()}`,
      startTime: Date.now(),
      buildErrorResult
    }
  );

  if (!result.success) {
    return {
      ranking: [],
      raw: result,
      error: normalizeText(result.error && result.error.code, "LLM_REQUEST_FAILED")
    };
  }

  return {
    ranking: extractRecommendationIds(result, caseItem),
    raw: result,
    error: ""
  };
}

function dcgAtK(rankedIds, relevanceMap, k) {
  return rankedIds.slice(0, k).reduce((sum, listingId, index) => {
    const rel = Number((relevanceMap && relevanceMap[listingId]) || 0);
    if (rel <= 0) {
      return sum;
    }
    return sum + (Math.pow(2, rel) - 1) / Math.log2(index + 2);
  }, 0);
}

function ndcgAtK(rankedIds, relevanceMap, k = 3) {
  const idealIds = Object.keys(relevanceMap || {}).sort(
    (a, b) => Number((relevanceMap && relevanceMap[b]) || 0) - Number((relevanceMap && relevanceMap[a]) || 0)
  );
  const ideal = dcgAtK(idealIds, relevanceMap, k);
  if (!ideal) {
    return 0;
  }
  return Number((dcgAtK(rankedIds, relevanceMap, k) / ideal).toFixed(4));
}

function satisfiesTop1Rules(listing, rules = {}) {
  const safe = sanitizeListing(listing);
  if (!safe) {
    return false;
  }
  if (rules.city_equals) {
    if (normalizeText(safe.city) !== normalizeText(rules.city_equals)) {
      return false;
    }
  }
  if (rules.district_equals) {
    if (normalizeText(safe.district) !== normalizeText(rules.district_equals)) {
      return false;
    }
  }
  if (rules.budget_max != null && safe.price_total != null && Number(safe.price_total) > Number(rules.budget_max)) {
    return false;
  }
  if (rules.area_min != null && safe.area_sqm != null && Number(safe.area_sqm) < Number(rules.area_min)) {
    return false;
  }
  if (rules.elevator_flag === true && safe.elevator_flag !== true) {
    return false;
  }
  if (rules.layout_includes) {
    const target = normalizeText(rules.layout_includes).toLowerCase();
    if (!normalizeText(safe.layout_desc).toLowerCase().includes(target)) {
      return false;
    }
  }
  if (rules.max_missing_fields != null) {
    const missingCount = Array.isArray(safe.missing_fields_json) ? safe.missing_fields_json.length : 99;
    if (missingCount > Number(rules.max_missing_fields)) {
      return false;
    }
  }
  return true;
}

function computePairwiseWin(rankedIds, caseItem) {
  const pairwiseInteractions = (caseItem.interactions || []).filter((item) => item.type === "pairwise");
  if (!pairwiseInteractions.length) {
    return null;
  }

  let passed = 0;
  pairwiseInteractions.forEach((item) => {
    const winnerIndex = rankedIds.indexOf(normalizeText(item.winner_listing_id));
    const loserIndex = rankedIds.indexOf(normalizeText(item.loser_listing_id));
    if (winnerIndex >= 0 && loserIndex >= 0 && winnerIndex < loserIndex) {
      passed += 1;
    }
  });
  return Number((passed / pairwiseInteractions.length).toFixed(4));
}

function evaluateCase(caseItem, runResult) {
  const rankedIds = uniqueIds(runResult.ranking || []);
  const topListingId = rankedIds[0] || "";
  const topListing = getListingById(caseItem, topListingId);
  const pairwiseWin = computePairwiseWin(rankedIds, caseItem);
  return {
    case_id: caseItem.case_id,
    title: caseItem.title,
    tags: Array.isArray(caseItem.tags) ? caseItem.tags.slice() : [],
    gold_top_listing_id: normalizeText(caseItem.gold && caseItem.gold.top_listing_id),
    predicted_top_listing_id: topListingId,
    top1_hit:
      topListingId && topListingId === normalizeText(caseItem.gold && caseItem.gold.top_listing_id) ? 1 : 0,
    hit_at_3: rankedIds.slice(0, 3).includes(normalizeText(caseItem.gold && caseItem.gold.top_listing_id)) ? 1 : 0,
    ndcg_at_3: ndcgAtK(rankedIds, (caseItem.gold && caseItem.gold.relevance) || {}, 3),
    top1_rule_hit:
      topListing && satisfiesTop1Rules(topListing, (caseItem.gold && caseItem.gold.top1_rules) || {}) ? 1 : 0,
    pairwise_win_rate: pairwiseWin,
    ranking: rankedIds,
    error: normalizeText(runResult.error)
  };
}

function average(values) {
  if (!values.length) {
    return null;
  }
  const sum = values.reduce((acc, item) => acc + Number(item || 0), 0);
  return Number((sum / values.length).toFixed(4));
}

function summarizeMetricGroup(caseResults) {
  const validCaseResults = caseResults.filter((item) => !item.error);
  const pairwiseValues = caseResults
    .map((item) => item.pairwise_win_rate)
    .filter((value) => typeof value === "number");

  return {
    total_cases: caseResults.length,
    successful_cases: validCaseResults.length,
    top1_accuracy: average(caseResults.map((item) => item.top1_hit)),
    hit_at_3: average(caseResults.map((item) => item.hit_at_3)),
    ndcg_at_3: average(caseResults.map((item) => item.ndcg_at_3)),
    top1_rule_hit_rate: average(caseResults.map((item) => item.top1_rule_hit)),
    pairwise_win_rate: average(pairwiseValues)
  };
}

function summarizeByTag(caseResults) {
  const groups = {};
  caseResults.forEach((item) => {
    const tags = Array.isArray(item.tags) ? item.tags : [];
    tags.forEach((tag) => {
      const key = normalizeText(tag);
      if (!key) {
        return;
      }
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(item);
    });
  });

  return Object.keys(groups)
    .sort()
    .reduce((acc, key) => {
      acc[key] = summarizeMetricGroup(groups[key]);
      return acc;
    }, {});
}

function summarizeBaseline(name, caseResults) {
  return {
    baseline: name,
    ...summarizeMetricGroup(caseResults),
    by_tag: summarizeByTag(caseResults),
    case_results: caseResults
  };
}

function buildDatasetOverview(cases) {
  const tagCounts = {};
  (cases || []).forEach((item) => {
    const tags = Array.isArray(item.tags) ? item.tags : [];
    tags.forEach((tag) => {
      const key = normalizeText(tag);
      if (key) {
        tagCounts[key] = (tagCounts[key] || 0) + 1;
      }
    });
  });

  return {
    total_cases: Array.isArray(cases) ? cases.length : 0,
    tag_counts: Object.keys(tagCounts)
      .sort()
      .reduce((acc, key) => {
        acc[key] = tagCounts[key];
        return acc;
      }, {})
  };
}

async function main() {
  ensureProviderEnv();
  const dataset = readJson(datasetPath);
  const cases = Array.isArray(dataset.cases) ? dataset.cases : [];

  const baselineRunners = [
    {
      label: "Current System",
      run: runCurrentSystem
    },
    {
      label: "Baseline 1 - Pure Rules",
      run: async (caseItem) => runRuleBaseline(caseItem)
    },
    {
      label: "Baseline 2 - LLM Direct",
      run: runLlmBaseline
    },
    {
      label: "Baseline 3 - No Explicit State",
      run: async (caseItem) => runAblationBaseline(caseItem)
    }
  ];

  const summaries = [];
  for (const baseline of baselineRunners) {
    const caseResults = [];
    for (const caseItem of cases) {
      const runResult = await baseline.run(caseItem);
      caseResults.push(evaluateCase(caseItem, runResult));
    }
    summaries.push(summarizeBaseline(baseline.label, caseResults));
  }

  const report = {
    dataset_version: dataset.dataset_version,
    generated_at: new Date().toISOString(),
    dataset_overview: buildDatasetOverview(cases),
    provider: {
      base_url: getEnvValue(
        ["OPENAI_COMPAT_BASE_URL", "BAILIAN_COMPAT_BASE_URL", "DASHSCOPE_BASE_URL"],
        DEFAULT_BASE_URL
      ),
      model: getEnvValue(
        ["OPENAI_COMPAT_MODEL", "BAILIAN_COMPAT_MODEL", "DASHSCOPE_MODEL"],
        DEFAULT_MODEL
      ),
      proxy_enabled: Boolean(
        process.env.OPENAI_COMPAT_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY
      )
    },
    summaries
  };

  if (reportPath) {
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  console.log(`ai_decision_baseline_eval dataset=${dataset.dataset_version} cases=${cases.length}`);
  summaries.forEach((summary) => {
    console.log(
      [
        summary.baseline,
        `top1=${summary.top1_accuracy}`,
        `hit@3=${summary.hit_at_3}`,
        `ndcg@3=${summary.ndcg_at_3}`,
        `rule_hit=${summary.top1_rule_hit_rate}`,
        `pairwise=${summary.pairwise_win_rate}`
      ].join(" | ")
    );
    summary.case_results.forEach((item) => {
      console.log(
        `  - ${item.case_id}: gold=${item.gold_top_listing_id} pred=${item.predicted_top_listing_id || "none"} ranking=${item.ranking.join(",") || "none"}${item.error ? ` error=${item.error}` : ""}`
      );
    });
  });
}

main().catch((err) => {
  console.error("ai_decision_baseline_eval_failed", err && err.message ? err.message : err);
  process.exitCode = 1;
});
