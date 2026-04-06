/**
 * cloudfunctions/decisionEngine/lib/viewModel.js - 视图模型层
 *
 * 职责：
 * 1) 把 workflow state 转成前端能直接渲染的 ui_blocks
 * 2) 统一输出格式
 *
 * 数据流：
 * state + computed -> viewModel.build() -> ui_blocks
 */

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

/**
 * UI Block 类型
 */
const BLOCK_TYPES = {
  MESSAGE_TEXT: "message_text",
  LISTING_CARD: "listing_card",
  BUCKET_CARDS: "bucket_cards",
  PAIRWISE_QUESTION: "pairwise_question",
  CLARIFY_QUESTION: "clarify_question",
  RELAXATION_OPTIONS: "relaxation_options",
  ERROR: "error"
};

/**
 * 创建文本消息 block
 */
function createMessageBlock(text, role = "ai") {
  return {
    type: BLOCK_TYPES.MESSAGE_TEXT,
    role,
    text: normalizeText(text)
  };
}

/**
 * 创建房源卡片 block
 */
function createListingCardBlock(listing) {
  const safe = listing && typeof listing === "object" ? listing : {};
  const price = toNumber(safe.price_total);
  const area = toNumber(safe.area_sqm || safe.area);

  return {
    type: BLOCK_TYPES.LISTING_CARD,
    listing_id: normalizeText(safe.listing_id),
    title: normalizeText(safe.title, "房源"),
    price_text: price == null ? "总价待补充" : `${price}万`,
    area_text: area == null ? "面积待补充" : `${area}㎡`,
    district_text: normalizeText(safe.district || safe.city, "区域待补充"),
    cover_image_url: normalizeText(safe.cover_image_url || safe.image_url),
    tags: Array.isArray(safe.tags) ? safe.tags.filter(Boolean) : []
  };
}

/**
 * 创建三档候选 block
 */
function createBucketCardsBlock(buckets) {
  const safe = buckets && typeof buckets === "object" ? buckets : {};
  const cards = [
    { key: "stable", title: "稳妥型", items: Array.isArray(safe.stable) ? safe.stable : [] },
    { key: "balanced", title: "均衡型", items: Array.isArray(safe.balanced) ? safe.balanced : [] },
    { key: "value", title: "性价比型", items: Array.isArray(safe.value) ? safe.value : [] }
  ].filter((card) => card.items.length > 0);

  return {
    type: BLOCK_TYPES.BUCKET_CARDS,
    cards: cards.map((card) => ({
      ...card,
      items: card.items.map((item) => createListingCardBlock(item))
    })),
    has_cards: cards.length > 0
  };
}

/**
 * 创建二选一问题 block
 */
function createPairwiseQuestionBlock(question) {
  if (!question) return null;

  return {
    type: BLOCK_TYPES.PAIRWISE_QUESTION,
    prompt: normalizeText(question.prompt, "这两套房里，你现在更倾向哪一套？"),
    left: question.left ? createListingCardBlock(question.left) : null,
    right: question.right ? createListingCardBlock(question.right) : null
  };
}

/**
 * 创建放宽建议 block
 */
function createRelaxationOptionsBlock(options, blockerText = "") {
  return {
    type: BLOCK_TYPES.RELAXATION_OPTIONS,
    blocker_text: normalizeText(blockerText),
    options: Array.isArray(options) ? options.map((opt) => ({
      key: normalizeText(opt.key || opt.code),
      label: normalizeText(opt.label || opt.message),
      description: normalizeText(opt.description || opt.impact)
    })) : []
  };
}

/**
 * 创建澄清问题 block
 */
function createClarifyBlock(blockers) {
  const messages = Array.isArray(blockers)
    ? blockers.map((b) => normalizeText(b.message || b)).filter(Boolean)
    : [];

  return {
    type: BLOCK_TYPES.CLARIFY_QUESTION,
    message: messages.length ? messages.join("；") : "需要补充更多条件",
    questions: messages
  };
}

/**
 * 创建错误 block
 */
function createErrorBlock(code, message) {
  return {
    type: BLOCK_TYPES.ERROR,
    code: normalizeText(code),
    message: normalizeText(message, "服务暂时不可用")
  };
}

/**
 * 构建完整的视图数据
 */
function buildView({
  session,
  ranked,
  feasibility,
  relaxationOptions,
  currentStage,
  currentNode = "",
  interrupt = false
}) {
  const uiBlocks = [];

  // 根据阶段构建不同的 UI blocks
  if (currentStage === "pairwise" && ranked.nextPairwiseQuestion) {
    const pairwiseBlock = createPairwiseQuestionBlock(ranked.nextPairwiseQuestion);
    if (pairwiseBlock) {
      uiBlocks.push(pairwiseBlock);
    }
  }

  if (currentStage === "relaxation" || currentStage === "clarifying") {
    if (feasibility.blockers && feasibility.blockers.length) {
      const blockerText = feasibility.blockers.map((b) => b.message).join("；");
      if (relaxationOptions.length) {
        uiBlocks.push(createRelaxationOptionsBlock(relaxationOptions, blockerText));
      } else {
        uiBlocks.push(createClarifyBlock(feasibility.blockers));
      }
    }
  }

  // 始终添加候选桶（如果有）
  if (ranked.buckets && Object.keys(ranked.buckets).some((k) => ranked.buckets[k].length)) {
    uiBlocks.push(createBucketCardsBlock(ranked.buckets));
  }

  return {
    decision_session_id: session.decision_session_id,
    current_stage: currentStage,
    current_node: currentNode,
    interrupt,
    selected_listing_ids: session.selected_listing_ids || [],
    candidate_listing_ids: session.candidate_listing_ids || [],
    candidate_buckets: ranked.buckets,
    top_listing_ids: ranked.topListingIds,
    next_pairwise_question: ranked.nextPairwiseQuestion,
    blockers: feasibility.blockers,
    relaxation_options: relaxationOptions,
    ui_blocks: uiBlocks
  };
}

/**
 * 构建成功响应
 */
function buildSuccessResponse(data, traceId, action) {
  return {
    success: true,
    data,
    error: null,
    meta: {
      trace_id: traceId,
      action
    }
  };
}

/**
 * 构建错误响应
 */
function buildErrorResponse({ code, message, traceId, details = null, action = "" }) {
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
      action
    }
  };
}

module.exports = {
  BLOCK_TYPES,
  createMessageBlock,
  createListingCardBlock,
  createBucketCardsBlock,
  createPairwiseQuestionBlock,
  createRelaxationOptionsBlock,
  createClarifyBlock,
  createErrorBlock,
  buildView,
  buildSuccessResponse,
  buildErrorResponse
};
