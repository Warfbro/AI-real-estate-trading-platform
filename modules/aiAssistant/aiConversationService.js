/**
 * modules/aiAssistant/aiConversationService.js - AI 对话服务层
 *
 * 职责：
 * 1) 调用 llmGenerate 进行对话
 * 2) 处理模型返回
 * 3) 更新 summary 和 compact context
 * 4) memory patch 校验与落盘
 *
 * 数据流：
 * 页面调用 -> aiConversationService -> 云端 AI -> 返回统一响应
 */

const { STORAGE_KEYS, get, set } = require("../../utils/storage");
const { AI_SCENES, requestAIConversation } = require("./aiGateway");
const {
  buildAIRequestContext,
  extractCompactContext,
  extractSessionSummary,
  isPlainObject,
  normalizeText,
  sanitizeStringArray,
  PROFILE_ARRAY_FIELDS,
  REQUIREMENT_ARRAY_FIELDS
} = require("./contextBuilder");
const { createMessageTextBlock, createClarifyQuestionBlock, createErrorBlock } = require("./uiBlockAdapter");

/**
 * AI 响应类型
 */
const AI_RESPONSE_TYPES = {
  RECOMMENDATION: "recommendation",
  CLARIFICATION: "clarification_needed",
  ERROR: "error"
};

/**
 * 从 AI 响应中提取已验证的 memory patch
 */
function extractValidatedMemoryPatch(result) {
  if (!isPlainObject(result)) return {};
  const data = isPlainObject(result.data) ? result.data : {};
  const patch = data.memory_patch;
  return isPlainObject(patch) ? patch : {};
}

/**
 * 从 AI 响应中提取被拒绝的 memory patch 字段
 */
function extractMemoryPatchRejected(result) {
  if (!isPlainObject(result) || !isPlainObject(result.data)) return [];
  return Array.isArray(result.data.memory_patch_rejected) ? result.data.memory_patch_rejected : [];
}

/**
 * 合并 patch 对象，支持数组字段合并
 */
function mergePatchObject(current, patch, arrayFields = []) {
  const base = isPlainObject(current) ? { ...current } : {};
  const incoming = isPlainObject(patch) ? patch : {};

  Object.keys(incoming).forEach((field) => {
    if (arrayFields.includes(field)) {
      const merged = sanitizeStringArray([].concat(base[field] || [], incoming[field] || []), 20);
      if (merged.length) {
        base[field] = merged;
      }
      return;
    }
    base[field] = incoming[field];
  });

  return base;
}

/**
 * 拆分 memory patch 为 profile 和 requirement 两部分
 */
function splitMemoryPatch(memoryPatch) {
  const patch = isPlainObject(memoryPatch) ? memoryPatch : {};
  const profilePatch = {};
  const requirementPatch = {};
  const profileFields = [
    "city",
    "district",
    "budget_min",
    "budget_max",
    "buy_purpose",
    "school_priority",
    "commute_priority",
    "elevator_required",
    "accept_old_house",
    "preferred_layout"
  ];
  const requirementFields = ["target_area", "current_stage", "candidate_house_ids", "notes"];

  profileFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      profilePatch[field] = patch[field];
    }
  });

  requirementFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      requirementPatch[field] = patch[field];
    }
  });

  return { profilePatch, requirementPatch };
}

/**
 * 应用 memory patch 到本地存储
 */
function applyMemoryPatch(memoryPatch) {
  const { profilePatch, requirementPatch } = splitMemoryPatch(memoryPatch);

  // 更新 AI_MEMORY_PROFILE
  if (Object.keys(profilePatch).length) {
    const currentProfile = get(STORAGE_KEYS.AI_MEMORY_PROFILE, {});
    const nextProfile = mergePatchObject(currentProfile, profilePatch, PROFILE_ARRAY_FIELDS);
    set(STORAGE_KEYS.AI_MEMORY_PROFILE, nextProfile);
  }

  // 更新 AI_ACTIVE_REQUIREMENT
  if (Object.keys(requirementPatch).length) {
    const currentRequirement = get(STORAGE_KEYS.AI_ACTIVE_REQUIREMENT, {});
    const nextRequirement = mergePatchObject(currentRequirement, requirementPatch, REQUIREMENT_ARRAY_FIELDS);
    set(STORAGE_KEYS.AI_ACTIVE_REQUIREMENT, nextRequirement);
  }

  return { profilePatch, requirementPatch };
}

/**
 * 格式化推荐响应为 UI blocks
 */
function formatRecommendationBlocks(data) {
  const safe = isPlainObject(data) ? data : {};
  const blocks = [];

  // 理解说明
  const understanding = normalizeText(safe.understanding);
  if (understanding) {
    blocks.push(createMessageTextBlock({ role: "ai", text: `理解：${understanding}` }));
  }

  // 摘要
  const summary = normalizeText(safe.summary);
  if (summary) {
    blocks.push(createMessageTextBlock({ role: "ai", text: `结果：${summary}` }));
  }

  // 推荐列表
  const recommendations = Array.isArray(safe.recommendations) ? safe.recommendations : [];
  if (recommendations.length) {
    const lines = ["推荐房源："];
    recommendations.slice(0, 5).forEach((item, index) => {
      const detail = item && typeof item === "object" ? item.listing_detail || {} : {};
      const title = normalizeText(detail.title || item.title || `房源${index + 1}`);
      const score = item.match_score != null ? `（匹配${item.match_score}%）` : "";
      const recommendation = normalizeText(item.recommendation);
      const concerns = Array.isArray(item.concerns) ? item.concerns.filter(Boolean) : [];
      const concernText = concerns.length ? `；关注：${concerns.join("、")}` : "";
      lines.push(`${index + 1}. ${title}${score}${recommendation ? `：${recommendation}` : ""}${concernText}`);
    });
    blocks.push(createMessageTextBlock({ role: "ai", text: lines.join("\n") }));
  }

  // 建议
  const advice = normalizeText(safe.advice);
  if (advice) {
    blocks.push(createMessageTextBlock({ role: "ai", text: `建议：${advice}` }));
  }

  // 下一步
  const nextSteps = Array.isArray(safe.next_steps) ? safe.next_steps.filter(Boolean) : [];
  if (nextSteps.length) {
    blocks.push(createMessageTextBlock({ role: "ai", text: `下一步：${nextSteps.join(" / ")}` }));
  }

  if (!blocks.length) {
    blocks.push(createMessageTextBlock({
      role: "ai",
      text: "已收到你的需求，但暂时没有可展示的推荐结果，请补充更多条件后重试。"
    }));
  }

  return blocks;
}

/**
 * 发送 AI 对话消息
 */
async function sendMessage({
  query,
  userId,
  sessionId,
  session = null,
  thread = null,
  selectedListingIds = [],
  compactContext = null,
  sessionSummary = ""
}) {
  const context = buildAIRequestContext({
    userId,
    sessionId,
    session,
    thread,
    selectedListingIds,
    compactContext,
    sessionSummary
  });

  try {
    const result = await requestAIConversation({
      query: normalizeText(query),
      userId,
      sessionId,
      context
    });

    const responseData = isPlainObject(result) ? result : {};
    const data = isPlainObject(responseData.data) ? responseData.data : responseData;
    const responseType = normalizeText(data.response_type || responseData.response_type);

    // 提取上下文更新
    const newCompactContext = extractCompactContext(result);
    const newSessionSummary = extractSessionSummary(result);
    const memoryPatch = extractValidatedMemoryPatch(result);
    const memoryPatchRejected = extractMemoryPatchRejected(result);

    // 应用 memory patch
    if (Object.keys(memoryPatch).length) {
      applyMemoryPatch(memoryPatch);
    }

    // 根据响应类型构建 blocks
    let blocks = [];
    if (responseType === AI_RESPONSE_TYPES.CLARIFICATION) {
      blocks.push(createClarifyQuestionBlock({
        message: normalizeText(data.message || data.understanding),
        questions: Array.isArray(data.questions) ? data.questions : []
      }));
    } else if (responseType === AI_RESPONSE_TYPES.ERROR) {
      blocks.push(createErrorBlock({
        code: normalizeText(data.code),
        message: normalizeText(data.message, "AI 服务暂时不可用")
      }));
    } else {
      blocks = formatRecommendationBlocks(data);
    }

    return {
      success: true,
      blocks,
      responseType,
      compactContext: newCompactContext,
      sessionSummary: newSessionSummary,
      memoryPatch,
      memoryPatchRejected,
      rawData: data
    };
  } catch (err) {
    return {
      success: false,
      blocks: [createErrorBlock({
        code: "AI_ERROR",
        message: normalizeText(err && (err.message || err.errMsg), "AI 服务暂时不可用")
      })],
      responseType: AI_RESPONSE_TYPES.ERROR,
      error: err
    };
  }
}

/**
 * 构建收藏房源自动查询语句
 */
function buildFavoriteAutoQuery(favoriteItems, maxLength = 1000) {
  const head = "请基于我刚选择的收藏房源，给出推荐排序、关键风险和下一步建议：";
  const lines = favoriteItems.map((item, index) => {
    const title = normalizeText(item.title_text || item.title, `收藏房源${index + 1}`);
    const desc = normalizeText(item.desc_text || item.description, "信息待补充");
    return `${index + 1}. ${title}（${desc}）`;
  });

  const query = `${head}\n${lines.join("\n")}`;
  return query.length > maxLength ? query.slice(0, maxLength) : query;
}

module.exports = {
  // 常量
  AI_RESPONSE_TYPES,

  // 核心方法
  sendMessage,
  buildFavoriteAutoQuery,

  // Memory Patch 方法
  extractValidatedMemoryPatch,
  extractMemoryPatchRejected,
  splitMemoryPatch,
  applyMemoryPatch,
  mergePatchObject,

  // 格式化方法
  formatRecommendationBlocks
};
