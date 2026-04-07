/**
 * modules/aiAssistant/llmProvider.js - 生成层 Provider 抽象
 *
 * 职责：
 * 1) 需求理解 (intent)
 * 2) 澄清问题 (clarify)
 * 3) 解释候选 (explain)
 * 4) 总结输出 (summarize)
 *
 * 生成层不再直接作为候选真相源，基于检索层返回的候选与证据来解释
 *
 * 数据流：
 * 检索结果 + 用户输入 -> llmProvider.generate() -> 理解/澄清/解释/总结
 */

const { queryPropertyRecommend } = require("../../utils/cloud");

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 生成模式枚举
 */
const LLM_MODES = {
  INTENT: "intent",
  CLARIFY: "clarify",
  EXPLAIN: "explain",
  SUMMARIZE: "summarize"
};

/**
 * 构建 intent 模式的 prompt
 */
function buildIntentPrompt(query, context = {}) {
  const parts = [];
  parts.push("分析用户输入，提取购房意图和约束条件。");
  parts.push(`用户输入：${query}`);

  if (context.memory_profile) {
    parts.push(`历史画像：${JSON.stringify(context.memory_profile)}`);
  }

  if (context.active_requirement) {
    parts.push(`当前需求：${JSON.stringify(context.active_requirement)}`);
  }

  return parts.join("\n");
}

/**
 * 构建 clarify 模式的 prompt
 */
function buildClarifyPrompt(query, context = {}) {
  const parts = [];
  parts.push("用户的需求信息不完整，生成澄清问题帮助用户补充。");
  parts.push(`用户输入：${query}`);

  if (context.missing_fields && context.missing_fields.length) {
    parts.push(`缺失字段：${context.missing_fields.join("、")}`);
  }

  if (context.blockers && context.blockers.length) {
    parts.push(`阻塞原因：${context.blockers.map((b) => b.message || b).join("；")}`);
  }

  return parts.join("\n");
}

/**
 * 构建 explain 模式的 prompt
 */
function buildExplainPrompt(candidates, context = {}) {
  const parts = [];
  parts.push("基于检索到的候选房源，解释为什么推荐这些房源。");

  if (context.active_intake) {
    parts.push(`用户需求：城市=${context.active_intake.city || "未指定"}，预算=${context.active_intake.budget_min || "?"}~${context.active_intake.budget_max || "?"}万`);
  }

  if (Array.isArray(candidates) && candidates.length) {
    parts.push(`候选房源（${candidates.length}套）：`);
    candidates.slice(0, 5).forEach((item, index) => {
      const title = normalizeText(item.title, `房源${index + 1}`);
      const price = item.price_total != null ? `${item.price_total}万` : "价格待定";
      const area = item.area_sqm != null ? `${item.area_sqm}㎡` : "面积待定";
      parts.push(`${index + 1}. ${title} - ${price} - ${area}`);
    });
  }

  if (context.evidence && context.evidence.length) {
    parts.push(`检索证据：${context.evidence.map((e) => e.message || JSON.stringify(e)).join("；")}`);
  }

  return parts.join("\n");
}

/**
 * 构建 summarize 模式的 prompt
 */
function buildSummarizePrompt(context = {}) {
  const parts = [];
  parts.push("总结本次对话的关键信息和决策进展。");

  if (context.session_summary) {
    parts.push(`已有摘要：${context.session_summary}`);
  }

  if (context.recent_messages && context.recent_messages.length) {
    parts.push("最近对话：");
    context.recent_messages.forEach((msg) => {
      parts.push(`- ${msg.role}: ${normalizeText(msg.content).slice(0, 100)}`);
    });
  }

  if (context.decision_stage) {
    parts.push(`当前决策阶段：${context.decision_stage}`);
  }

  return parts.join("\n");
}

/**
 * 解析 LLM 返回的 intent
 */
function parseIntentResponse(response) {
  const data = isPlainObject(response) ? response : {};
  return {
    intent_type: normalizeText(data.intent_type || data.type, "search"),
    constraints: isPlainObject(data.constraints) ? data.constraints : {},
    preferences: isPlainObject(data.preferences) ? data.preferences : {},
    keywords: Array.isArray(data.keywords) ? data.keywords : [],
    confidence: data.confidence || 0.5
  };
}

/**
 * 解析 LLM 返回的 clarify
 */
function parseClarifyResponse(response) {
  const data = isPlainObject(response) ? response : {};
  return {
    message: normalizeText(data.message || data.understanding, "需要补充更多信息"),
    questions: Array.isArray(data.questions) ? data.questions.filter(Boolean) : [],
    missing_fields: Array.isArray(data.missing_fields) ? data.missing_fields : []
  };
}

/**
 * 解析 LLM 返回的 explain
 */
function parseExplainResponse(response) {
  const data = isPlainObject(response) ? response : {};
  return {
    understanding: normalizeText(data.understanding),
    recommendations: Array.isArray(data.recommendations) ? data.recommendations : [],
    summary: normalizeText(data.summary),
    advice: normalizeText(data.advice),
    next_steps: Array.isArray(data.next_steps) ? data.next_steps : []
  };
}

/**
 * 解析 LLM 返回的 summarize
 */
function parseSummarizeResponse(response) {
  const data = isPlainObject(response) ? response : {};
  return {
    session_summary: normalizeText(data.session_summary || data.summary),
    key_points: Array.isArray(data.key_points) ? data.key_points : [],
    decision_progress: normalizeText(data.decision_progress),
    next_action: normalizeText(data.next_action)
  };
}

/**
 * 创建 LLM Provider 实例
 */
function createLLMProvider(options = {}) {
  return {
    /**
     * 执行生成
     */
    async generate({ mode = LLM_MODES.INTENT, query = "", candidates = [], context = {} } = {}) {
      let prompt = "";
      let parser = parseIntentResponse;

      switch (mode) {
        case LLM_MODES.INTENT:
          prompt = buildIntentPrompt(query, context);
          parser = parseIntentResponse;
          break;

        case LLM_MODES.CLARIFY:
          prompt = buildClarifyPrompt(query, context);
          parser = parseClarifyResponse;
          break;

        case LLM_MODES.EXPLAIN:
          prompt = buildExplainPrompt(candidates, context);
          parser = parseExplainResponse;
          break;

        case LLM_MODES.SUMMARIZE:
          prompt = buildSummarizePrompt(context);
          parser = parseSummarizeResponse;
          break;

        default:
          prompt = query;
          parser = parseIntentResponse;
      }

      try {
        // 调用现有的 queryPropertyRecommend，后续可替换为独立 LLM 云函数
        const result = await queryPropertyRecommend({
          query: prompt,
          userId: context.user_id || "",
          sessionId: context.session_id || "",
          context: {
            ...context,
            mode,
            candidates: mode === LLM_MODES.EXPLAIN ? candidates : undefined
          }
        });

        const rawData = isPlainObject(result) ? result : {};
        const data = isPlainObject(rawData.data) ? rawData.data : rawData;
        const parsed = parser(data);

        return {
          success: true,
          mode,
          data: parsed,
          raw: data,
          memory_patch: data.memory_patch || null,
          compact_context: data.compact_context || null
        };
      } catch (err) {
        return {
          success: false,
          mode,
          error: {
            code: "LLM_ERROR",
            message: normalizeText(err && (err.message || err.errMsg), "LLM 服务不可用")
          }
        };
      }
    },

    /**
     * 理解用户意图
     */
    async parseIntent(query, context = {}) {
      return this.generate({ mode: LLM_MODES.INTENT, query, context });
    },

    /**
     * 生成澄清问题
     */
    async generateClarification(query, context = {}) {
      return this.generate({ mode: LLM_MODES.CLARIFY, query, context });
    },

    /**
     * 解释推荐候选
     */
    async explainCandidates(candidates, context = {}) {
      return this.generate({ mode: LLM_MODES.EXPLAIN, candidates, context });
    },

    /**
     * 总结对话
     */
    async summarizeSession(context = {}) {
      return this.generate({ mode: LLM_MODES.SUMMARIZE, context });
    }
  };
}

module.exports = {
  LLM_MODES,
  buildIntentPrompt,
  buildClarifyPrompt,
  buildExplainPrompt,
  buildSummarizePrompt,
  parseIntentResponse,
  parseClarifyResponse,
  parseExplainResponse,
  parseSummarizeResponse,
  createLLMProvider
};
