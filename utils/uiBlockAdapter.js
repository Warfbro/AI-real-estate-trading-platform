/**
 * utils/uiBlockAdapter.js - UI Block 适配器
 *
 * 职责：
 * 1) 把后端 ui_blocks 转为前端统一 block 数据
 * 2) 给 block 补默认字段
 * 3) 统一 block action 协议
 *
 * 数据流：
 * 后端响应 -> uiBlockAdapter.adapt() -> 前端可渲染 blocks
 */

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

/**
 * Block 类型枚举
 */
const BLOCK_TYPES = {
  MESSAGE_TEXT: "message_text",
  LISTING_CARD: "listing_card",
  COMPARE_CARD: "compare_card",
  RISK_CARD: "risk_card",
  ACTION_CARD: "action_card",
  CLARIFY_QUESTION: "clarify_question",
  PAIRWISE_QUESTION: "pairwise_question",
  BUCKET_CARDS: "bucket_cards",
  ERROR: "error",
  LOADING: "loading"
};

/**
 * 创建文本消息 block
 */
function createMessageTextBlock({ role = "ai", text = "", created_at = "" }) {
  return {
    type: BLOCK_TYPES.MESSAGE_TEXT,
    role: normalizeText(role, "ai"),
    text: normalizeText(text),
    created_at: normalizeText(created_at, new Date().toISOString())
  };
}

/**
 * 创建房源卡片 block
 */
function createListingCardBlock(listing) {
  const safe = isPlainObject(listing) ? listing : {};
  const listingId = normalizeText(safe.listing_id);
  const title = normalizeText(safe.title || safe.title_text, `房源${listingId ? ` ${listingId}` : ""}`);
  const price = toNumber(safe.price_total);
  const area = toNumber(safe.area_sqm || safe.area);
  const district = normalizeText(safe.district || safe.city);
  const coverImage = normalizeText(safe.cover_image_url || safe.image_url);

  return {
    type: BLOCK_TYPES.LISTING_CARD,
    listing_id: listingId,
    title,
    price_text: price == null ? "总价待补充" : `${price}万`,
    area_text: area == null ? "面积待补充" : `${area}㎡`,
    district_text: district || "区域待补充",
    cover_image_url: coverImage,
    tags: Array.isArray(safe.tags) ? safe.tags.filter(Boolean) : [],
    actions: [
      { key: "view_detail", label: "查看详情" },
      { key: "add_compare", label: "加入对比" }
    ]
  };
}

/**
 * 创建比较卡片 block
 */
function createCompareCardBlock(compareResult) {
  const safe = isPlainObject(compareResult) ? compareResult : {};
  return {
    type: BLOCK_TYPES.COMPARE_CARD,
    listings: Array.isArray(safe.listings) ? safe.listings : [],
    dimensions: Array.isArray(safe.dimensions) ? safe.dimensions : [],
    summary: normalizeText(safe.summary),
    recommendation: normalizeText(safe.recommendation),
    actions: [
      { key: "view_full", label: "查看完整对比" },
      { key: "export", label: "导出报告" }
    ]
  };
}

/**
 * 创建风险卡片 block
 */
function createRiskCardBlock(riskResult) {
  const safe = isPlainObject(riskResult) ? riskResult : {};
  return {
    type: BLOCK_TYPES.RISK_CARD,
    listing_id: normalizeText(safe.listing_id),
    risk_level: normalizeText(safe.risk_level, "medium"),
    risk_score: toNumber(safe.risk_score),
    risk_items: Array.isArray(safe.risk_items) ? safe.risk_items : [],
    summary: normalizeText(safe.summary),
    suggestions: Array.isArray(safe.suggestions) ? safe.suggestions : [],
    actions: [
      { key: "view_detail", label: "查看详细风险" },
      { key: "consult", label: "咨询专家" }
    ]
  };
}

/**
 * 创建行动建议卡片 block
 */
function createActionCardBlock(actionResult) {
  const safe = isPlainObject(actionResult) ? actionResult : {};
  return {
    type: BLOCK_TYPES.ACTION_CARD,
    action_type: normalizeText(safe.action_type, "next_step"),
    title: normalizeText(safe.title, "下一步建议"),
    description: normalizeText(safe.description),
    steps: Array.isArray(safe.steps) ? safe.steps : [],
    priority: normalizeText(safe.priority, "normal"),
    deadline_hint: normalizeText(safe.deadline_hint),
    actions: [
      { key: "start", label: "开始执行" },
      { key: "schedule", label: "预约时间" },
      { key: "skip", label: "跳过" }
    ]
  };
}

/**
 * 创建澄清问题 block
 */
function createClarifyQuestionBlock({ message = "", questions = [] }) {
  return {
    type: BLOCK_TYPES.CLARIFY_QUESTION,
    message: normalizeText(message, "为了给你更精准的推荐，还需要补充一些信息。"),
    questions: Array.isArray(questions) ? questions.filter(Boolean) : [],
    actions: [
      { key: "answer", label: "回答" },
      { key: "skip", label: "跳过" }
    ]
  };
}

/**
 * 创建二选一问题 block
 */
function createPairwiseQuestionBlock({ prompt = "", left = null, right = null }) {
  return {
    type: BLOCK_TYPES.PAIRWISE_QUESTION,
    prompt: normalizeText(prompt, "这两套房里，你现在更倾向哪一套？"),
    left: isPlainObject(left) ? left : null,
    right: isPlainObject(right) ? right : null,
    actions: [
      { key: "choose_left", label: "选左边" },
      { key: "choose_right", label: "选右边" },
      { key: "both_ok", label: "都可以" },
      { key: "neither", label: "都不满意" }
    ]
  };
}

/**
 * 创建三档候选 block
 */
function createBucketCardsBlock(buckets) {
  const safe = isPlainObject(buckets) ? buckets : {};
  const cards = [
    { key: "stable", title: "稳妥型", items: Array.isArray(safe.stable) ? safe.stable : [] },
    { key: "balanced", title: "均衡型", items: Array.isArray(safe.balanced) ? safe.balanced : [] },
    { key: "value", title: "性价比型", items: Array.isArray(safe.value) ? safe.value : [] }
  ].filter((card) => card.items.length > 0);

  return {
    type: BLOCK_TYPES.BUCKET_CARDS,
    cards,
    has_cards: cards.length > 0,
    actions: [
      { key: "view_all", label: "查看全部" },
      { key: "compare", label: "对比选中" }
    ]
  };
}

/**
 * 创建错误 block
 */
function createErrorBlock({ code = "", message = "", retry_hint = "" }) {
  return {
    type: BLOCK_TYPES.ERROR,
    code: normalizeText(code),
    message: normalizeText(message, "AI 服务暂时不可用，请稍后重试。"),
    retry_hint: normalizeText(retry_hint, "点击重试"),
    actions: [
      { key: "retry", label: "重试" },
      { key: "dismiss", label: "关闭" }
    ]
  };
}

/**
 * 创建加载中 block
 */
function createLoadingBlock({ hint = "" }) {
  return {
    type: BLOCK_TYPES.LOADING,
    hint: normalizeText(hint, "AI 正在思考中...")
  };
}

/**
 * 适配后端 ui_blocks 数组
 */
function adaptUIBlocks(uiBlocks) {
  if (!Array.isArray(uiBlocks)) return [];

  return uiBlocks
    .map((block) => {
      if (!isPlainObject(block)) return null;
      const blockType = normalizeText(block.type);

      switch (blockType) {
        case "message":
        case "message_text":
        case "text":
          return createMessageTextBlock(block);

        case "listing":
        case "listing_card":
        case "property":
          return createListingCardBlock(block);

        case "compare":
        case "compare_card":
        case "comparison":
          return createCompareCardBlock(block);

        case "risk":
        case "risk_card":
        case "risk_analysis":
          return createRiskCardBlock(block);

        case "action":
        case "action_card":
        case "next_step":
          return createActionCardBlock(block);

        case "clarify":
        case "clarify_question":
        case "clarification":
          return createClarifyQuestionBlock(block);

        case "pairwise":
        case "pairwise_question":
          return createPairwiseQuestionBlock(block);

        case "buckets":
        case "bucket_cards":
        case "candidates":
          return createBucketCardsBlock(block);

        case "error":
          return createErrorBlock(block);

        case "loading":
          return createLoadingBlock(block);

        default:
          // 未知类型，尝试作为文本处理
          if (block.text || block.content || block.message) {
            return createMessageTextBlock({
              role: block.role || "ai",
              text: block.text || block.content || block.message
            });
          }
          return null;
      }
    })
    .filter(Boolean);
}

/**
 * 从工作流响应适配 UI blocks
 */
function adaptWorkflowResponse(response) {
  if (!isPlainObject(response)) {
    return { blocks: [], meta: {} };
  }

  const data = isPlainObject(response.data) ? response.data : response;
  const blocks = [];
  const meta = {
    success: Boolean(response.success !== false),
    status: normalizeText(response.status || data.status),
    current_stage: normalizeText(data.current_stage),
    current_node: normalizeText(data.current_node),
    interrupt: Boolean(data.interrupt),
    wait_for_input: Boolean(data.wait_for_input)
  };

  // 优先使用后端提供的 ui_blocks
  if (Array.isArray(data.ui_blocks)) {
    blocks.push(...adaptUIBlocks(data.ui_blocks));
  }

  // 适配候选桶
  if (data.candidate_buckets) {
    blocks.push(createBucketCardsBlock(data.candidate_buckets));
  }

  // 适配二选一
  if (data.next_pairwise_question && meta.current_stage === "pairwise") {
    blocks.push(createPairwiseQuestionBlock(data.next_pairwise_question));
  }

  // 适配错误
  if (response.error || data.error) {
    const error = response.error || data.error;
    blocks.push(createErrorBlock({
      code: error.code,
      message: error.message || error.details
    }));
  }

  return { blocks, meta };
}

module.exports = {
  // 类型常量
  BLOCK_TYPES,

  // Block 创建函数
  createMessageTextBlock,
  createListingCardBlock,
  createCompareCardBlock,
  createRiskCardBlock,
  createActionCardBlock,
  createClarifyQuestionBlock,
  createPairwiseQuestionBlock,
  createBucketCardsBlock,
  createErrorBlock,
  createLoadingBlock,

  // 适配函数
  adaptUIBlocks,
  adaptWorkflowResponse
};
