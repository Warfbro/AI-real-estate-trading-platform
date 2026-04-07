/**
 * modules/aiAssistant/contextBuilder.js - 上下文构建服务
 *
 * 职责：
 * 1) recent messages 组装
 * 2) summary 组装
 * 3) compact context 组装
 * 4) selected listings 上下文注入
 * 5) 当前 thread / workflow_session 上下文打包
 *
 * 数据流：
 * 页面调用 -> contextBuilder.build() -> 返回统一 context 对象
 */

const { STORAGE_KEYS, get } = require("../../utils/storage");
const chatRepo = require("./chatRepo");
const listingRepo = require("../listingSearch/listingRepo");
const intakeRepo = require("../userState/intakeRepo");

const RECENT_MESSAGE_LIMIT = 5;
const PROFILE_ARRAY_FIELDS = ["district"];
const REQUIREMENT_ARRAY_FIELDS = ["target_area", "candidate_house_ids"];

function nowISOTime() {
  return new Date().toISOString();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function toNumber(value) {
  if (value == null) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function sanitizeStringArray(value, limit = 10) {
  const source = Array.isArray(value) ? value : [value];
  const list = [];
  for (let i = 0; i < source.length; i += 1) {
    const text = normalizeText(source[i]);
    if (text && !list.includes(text)) {
      list.push(text);
    }
    if (list.length >= limit) break;
  }
  return list;
}

function byUpdatedDesc(a, b) {
  const aTime = a.updated_at || a.created_at || "";
  const bTime = b.updated_at || b.created_at || "";
  return aTime > bTime ? -1 : 1;
}

/**
 * 获取用户身份别名列表（兼容 user_id/login_code/openid）
 */
function getUserAliases(userId, session = null) {
  return sanitizeStringArray(
    [
      userId,
      session && session.user_id,
      session && session.login_code,
      session && session.openid
    ],
    10
  );
}

/**
 * 获取最新已提交的需求单
 */
function getLatestSubmittedIntake(userId, session = null) {
  const userAliases = getUserAliases(userId, session);
  if (!userAliases.length) return null;

  const intakeResult = intakeRepo.getIntakes({ status: null });
  const allIntakes = intakeResult && intakeResult.status === "success" ? intakeResult.data : [];
  const list = allIntakes
    .filter(
      (item) =>
        item &&
        item.status === "submitted" &&
        userAliases.includes(normalizeText(item.user_id))
    )
    .sort(byUpdatedDesc);

  return list.length ? list[0] : null;
}

/**
 * 获取用户活跃房源列表
 */
function getActiveListings(userId, session = null) {
  const userAliases = getUserAliases(userId, session);
  if (!userAliases.length) return [];

  const listingResult = listingRepo.getListings({ includeInactive: false });
  const allListings = listingResult && listingResult.status === "success" ? listingResult.data : [];

  return allListings
    .filter(
      (item) =>
        item &&
        item.status === "active" &&
        userAliases.includes(normalizeText(item.user_id))
    )
    .sort(byUpdatedDesc);
}

/**
 * 构建决策所需的本地房源列表
 */
function buildDecisionLocalListings(userId, selectedListingIds = [], session = null) {
  const selectedIds = sanitizeStringArray(selectedListingIds, 20);
  const listings = getActiveListings(userId, session);
  if (!selectedIds.length) {
    return listings.slice(0, 30);
  }

  const selectedSet = new Set(selectedIds);
  const prioritized = [];
  const fallback = [];

  listings.forEach((item) => {
    const listingId = normalizeText(item && item.listing_id);
    if (!listingId) return;
    if (selectedSet.has(listingId)) {
      prioritized.push(item);
      return;
    }
    fallback.push(item);
  });

  return prioritized.concat(fallback).slice(0, 30);
}

/**
 * 构建最近消息列表（用于 AI 上下文）
 */
function buildRecentMessages(messages, limit = RECENT_MESSAGE_LIMIT) {
  const list = Array.isArray(messages) ? messages : [];
  return list
    .filter((item) => item && normalizeText(item.text || item.content))
    .slice(-limit)
    .map((item) => ({
      role: normalizeText(item.role, "user"),
      content: normalizeText(item.text || item.content),
      created_at: normalizeText(item.created_at)
    }));
}

/**
 * 净化 compact context
 */
function sanitizeCompactContext(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const summary = normalizeText(value);
    return summary ? { history_summary: summary } : null;
  }
  if (Array.isArray(value)) {
    return value.length ? { history_turns: value.slice(0, 50) } : null;
  }
  if (isPlainObject(value)) {
    return value;
  }
  return null;
}

/**
 * 从 AI 响应中提取 compact context
 */
function extractCompactContext(result) {
  if (!isPlainObject(result)) return null;

  const data = isPlainObject(result.data) ? result.data : {};
  const candidates = [
    data.compact_context,
    data.next_context,
    data.context_snapshot,
    data.compact_history,
    data.condensed_history,
    result.compact_context,
    result.next_context,
    result.context_snapshot,
    result.compact_history,
    result.condensed_history
  ];

  for (let i = 0; i < candidates.length; i += 1) {
    const compact = sanitizeCompactContext(candidates[i]);
    if (compact) return compact;
  }
  return null;
}

/**
 * 从 AI 响应中提取 session summary
 */
function extractSessionSummary(result) {
  if (!isPlainObject(result)) return "";

  const data = isPlainObject(result.data) ? result.data : {};
  const compactContext = extractCompactContext(result) || extractCompactContext(data);
  const candidates = [
    data.session_summary,
    data.history_summary,
    result.session_summary,
    result.history_summary,
    compactContext && compactContext.history_summary
  ];

  for (let i = 0; i < candidates.length; i += 1) {
    const summary = normalizeText(candidates[i]);
    if (summary) return summary;
  }
  return "";
}

/**
 * 构建完整的 AI 请求上下文
 */
function buildAIRequestContext({
  userId,
  sessionId,
  session = null,
  thread = null,
  selectedListingIds = [],
  compactContext = null,
  sessionSummary = ""
}) {
  const intake = getLatestSubmittedIntake(userId, session);
  const memoryProfile = get(STORAGE_KEYS.AI_MEMORY_PROFILE, {});
  const activeRequirement = get(STORAGE_KEYS.AI_ACTIVE_REQUIREMENT, {});

  const context = {
    session_id: normalizeText(sessionId),
    user_id: normalizeText(userId),
    selected_listing_ids: sanitizeStringArray(selectedListingIds, 10),
    timestamp: nowISOTime()
  };

  // 注入需求单上下文
  if (intake) {
    context.active_intake = {
      intake_id: intake.intake_id,
      city: normalizeText(intake.city),
      budget_min: toNumber(intake.budget_min),
      budget_max: toNumber(intake.budget_max),
      area_min: toNumber(intake.area_min),
      layout_pref: normalizeText(intake.layout_pref)
    };
  }

  // 注入记忆画像
  if (isPlainObject(memoryProfile) && Object.keys(memoryProfile).length) {
    context.memory_profile = memoryProfile;
  }

  // 注入活跃需求
  if (isPlainObject(activeRequirement) && Object.keys(activeRequirement).length) {
    context.active_requirement = activeRequirement;
  }

  // 注入 compact context
  if (compactContext) {
    context.compact_context = compactContext;
  }

  // 注入 session summary
  if (sessionSummary) {
    context.session_summary = sessionSummary;
  }

  // 注入最近消息
  if (thread && Array.isArray(thread.messages)) {
    context.recent_messages = buildRecentMessages(thread.messages);
  }

  return context;
}

/**
 * 构建决策引擎请求上下文
 */
function buildDecisionContext({
  userId,
  session = null,
  selectedListingIds = [],
  useHistoricalConstraints = false
}) {
  const intake = getLatestSubmittedIntake(userId, session);
  const memoryProfile = get(STORAGE_KEYS.AI_MEMORY_PROFILE, {});
  const activeRequirement = get(STORAGE_KEYS.AI_ACTIVE_REQUIREMENT, {});

  const context = {
    selected_listing_ids: sanitizeStringArray(selectedListingIds, 5),
    use_historical_constraints: useHistoricalConstraints
  };

  if (intake) {
    context.active_intake = {
      intake_id: intake.intake_id,
      city: normalizeText(intake.city),
      budget_min: toNumber(intake.budget_min),
      budget_max: toNumber(intake.budget_max),
      area_min: toNumber(intake.area_min),
      layout_pref: normalizeText(intake.layout_pref)
    };
  }

  if (isPlainObject(memoryProfile) && Object.keys(memoryProfile).length) {
    context.memory_profile = memoryProfile;
  }

  if (isPlainObject(activeRequirement) && Object.keys(activeRequirement).length) {
    context.active_requirement = activeRequirement;
  }

  return context;
}

/**
 * 获取决策种子（已选/收藏/活跃房源）
 */
function getDecisionSeed(userId, session = null) {
  const compareIds = sanitizeStringArray(listingRepo.getCompareIds(), 5);
  if (compareIds.length >= 2) {
    return { ids: compareIds, label: `已选房源 ${compareIds.length} 套` };
  }

  const favoriteIds = sanitizeStringArray(listingRepo.getFavoriteIds(), 5);
  if (favoriteIds.length >= 2) {
    return { ids: favoriteIds, label: `收藏房源 ${favoriteIds.length} 套` };
  }

  const listings = getActiveListings(userId, session)
    .map((item) => normalizeText(item && item.listing_id))
    .filter(Boolean)
    .slice(0, 5);

  if (listings.length >= 2) {
    return { ids: listings, label: `活跃房源 ${listings.length} 套` };
  }

  return { ids: [], label: "请先收藏或加入至少 2 套房源" };
}

module.exports = {
  // 基础工具
  normalizeText,
  toNumber,
  sanitizeStringArray,
  isPlainObject,
  byUpdatedDesc,
  getUserAliases,

  // 数据获取
  getLatestSubmittedIntake,
  getActiveListings,
  buildDecisionLocalListings,
  getDecisionSeed,

  // 消息与上下文
  buildRecentMessages,
  sanitizeCompactContext,
  extractCompactContext,
  extractSessionSummary,

  // 请求上下文构建
  buildAIRequestContext,
  buildDecisionContext,

  // 常量导出
  RECENT_MESSAGE_LIMIT,
  PROFILE_ARRAY_FIELDS,
  REQUIREMENT_ARRAY_FIELDS
};
