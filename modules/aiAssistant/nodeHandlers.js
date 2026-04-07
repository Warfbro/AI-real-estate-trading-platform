/**
 * modules/aiAssistant/nodeHandlers.js - 业务节点统一处理框架
 *
 * 职责：
 * 1) 统一 compare / risk / action / consult 节点接口
 * 2) 每个节点入参、出参结构一致
 * 3) 节点可组合、可编排
 *
 * 节点通用结构：
 * 入参: { candidates, context, options }
 * 出参: { success, data, ui_blocks, memory_patch, next_node }
 */

const { createRetrievalProvider } = require("./retrievalProvider");
const { createLLMProvider } = require("./llmProvider");

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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 节点类型枚举
 */
const NODE_TYPES = {
  COMPARE: "compare",
  RISK: "risk",
  ACTION: "action",
  CONSULT: "consult"
};

/**
 * UI Block 类型枚举
 */
const BLOCK_TYPES = {
  CARD_LIST: "card_list",
  COMPARISON_TABLE: "comparison_table",
  RISK_PANEL: "risk_panel",
  ACTION_CHECKLIST: "action_checklist",
  CONSULT_DIALOG: "consult_dialog",
  TEXT: "text"
};

/**
 * 创建 UI Block
 */
function createUIBlock(type, data = {}) {
  return {
    type,
    data,
    created_at: Date.now()
  };
}

/**
 * Compare 节点 - 候选对比
 */
function createCompareNode(deps = {}) {
  const retrieval = deps.retrieval || createRetrievalProvider();
  const llm = deps.llm || createLLMProvider();

  return {
    type: NODE_TYPES.COMPARE,

    /**
     * 执行对比
     */
    async execute({ candidates = [], context = {}, options = {} } = {}) {
      if (!Array.isArray(candidates) || candidates.length < 2) {
        return {
          success: false,
          error: { code: "INSUFFICIENT_CANDIDATES", message: "至少需要2套房源进行对比" },
          ui_blocks: []
        };
      }

      // 维度提取
      const dimensions = options.dimensions || ["price_total", "area_sqm", "layout", "district", "age"];

      // 构建对比数据
      const comparisonRows = dimensions.map((dim) => {
        const row = { dimension: dim, values: [] };
        candidates.forEach((item) => {
          row.values.push({
            listing_id: item.listing_id,
            value: item[dim] != null ? item[dim] : "—"
          });
        });
        return row;
      });

      // 调用 LLM 生成对比总结
      const explainResult = await llm.explainCandidates(candidates, {
        ...context,
        comparison_mode: true
      });

      const summary = explainResult.success
        ? normalizeText(explainResult.data.summary, "对比分析完成")
        : "对比分析完成";

      // 构建 UI Blocks
      const uiBlocks = [
        createUIBlock(BLOCK_TYPES.COMPARISON_TABLE, {
          candidates: candidates.map((c) => ({
            listing_id: c.listing_id,
            title: c.title || c.community_name,
            thumb: c.images && c.images[0]
          })),
          rows: comparisonRows
        }),
        createUIBlock(BLOCK_TYPES.TEXT, { content: summary })
      ];

      return {
        success: true,
        data: { comparison: comparisonRows, summary },
        ui_blocks: uiBlocks,
        memory_patch: explainResult.memory_patch || null,
        next_node: null
      };
    }
  };
}

/**
 * Risk 节点 - 风险评估
 */
function createRiskNode(deps = {}) {
  const llm = deps.llm || createLLMProvider();

  return {
    type: NODE_TYPES.RISK,

    /**
     * 执行风险评估
     */
    async execute({ candidates = [], context = {}, options = {} } = {}) {
      if (!Array.isArray(candidates) || !candidates.length) {
        return {
          success: false,
          error: { code: "NO_CANDIDATES", message: "没有房源可进行风险评估" },
          ui_blocks: []
        };
      }

      const riskItems = [];

      candidates.forEach((item) => {
        const risks = [];
        const listing_id = normalizeText(item.listing_id);

        // 价格风险
        const price = toNumber(item.price_total);
        const budget_max = toNumber(context.active_intake && context.active_intake.budget_max);
        if (price != null && budget_max != null && price > budget_max) {
          risks.push({
            type: "over_budget",
            level: "high",
            message: `超出预算 ${(price - budget_max).toFixed(0)} 万`
          });
        }

        // 房龄风险
        const age = toNumber(item.age || item.building_age);
        if (age != null && age > 20) {
          risks.push({
            type: "old_building",
            level: age > 30 ? "high" : "medium",
            message: `房龄 ${age} 年，可能存在维护成本`
          });
        }

        // 产权风险
        const propertyYears = toNumber(item.property_years || item.remaining_years);
        if (propertyYears != null && propertyYears < 30) {
          risks.push({
            type: "short_tenure",
            level: propertyYears < 20 ? "high" : "medium",
            message: `剩余产权 ${propertyYears} 年`
          });
        }

        // 区域风险（简单示例）
        if (context.risky_districts && context.risky_districts.includes(item.district)) {
          risks.push({
            type: "risky_area",
            level: "medium",
            message: `${item.district}区域近期有波动`
          });
        }

        riskItems.push({
          listing_id,
          title: normalizeText(item.title, item.community_name),
          risks,
          overall_level: risks.some((r) => r.level === "high")
            ? "high"
            : risks.some((r) => r.level === "medium")
              ? "medium"
              : "low"
        });
      });

      // 构建 UI Blocks
      const uiBlocks = [
        createUIBlock(BLOCK_TYPES.RISK_PANEL, { items: riskItems })
      ];

      return {
        success: true,
        data: { risk_assessment: riskItems },
        ui_blocks: uiBlocks,
        memory_patch: null,
        next_node: null
      };
    }
  };
}

/**
 * Action 节点 - 行动清单
 */
function createActionNode(deps = {}) {
  return {
    type: NODE_TYPES.ACTION,

    /**
     * 执行行动清单生成
     */
    async execute({ candidates = [], context = {}, options = {} } = {}) {
      const actions = [];

      // 默认行动项
      actions.push({
        id: "action_1",
        type: "verify_listing",
        title: "核实房源信息",
        description: "联系中介确认房源真实性和最新状态",
        priority: "high",
        status: "pending"
      });

      if (candidates.length > 0) {
        actions.push({
          id: "action_2",
          type: "schedule_viewing",
          title: "预约看房",
          description: `预约查看 ${candidates.length} 套候选房源`,
          priority: "high",
          status: "pending",
          related_listings: candidates.map((c) => c.listing_id)
        });
      }

      actions.push({
        id: "action_3",
        type: "prepare_documents",
        title: "准备材料",
        description: "准备身份证、收入证明、银行流水等购房材料",
        priority: "medium",
        status: "pending"
      });

      if (context.need_loan !== false) {
        actions.push({
          id: "action_4",
          type: "loan_preapproval",
          title: "贷款预审",
          description: "向银行咨询贷款额度和利率",
          priority: "medium",
          status: "pending"
        });
      }

      // 构建 UI Blocks
      const uiBlocks = [
        createUIBlock(BLOCK_TYPES.ACTION_CHECKLIST, { actions })
      ];

      return {
        success: true,
        data: { actions },
        ui_blocks: uiBlocks,
        memory_patch: null,
        next_node: null
      };
    }
  };
}

/**
 * Consult 节点 - 咨询对话
 */
function createConsultNode(deps = {}) {
  const llm = deps.llm || createLLMProvider();

  return {
    type: NODE_TYPES.CONSULT,

    /**
     * 执行咨询
     */
    async execute({ query = "", candidates = [], context = {}, options = {} } = {}) {
      // 使用 LLM 生成回复
      const result = await llm.generate({
        mode: "explain",
        query,
        candidates,
        context
      });

      if (!result.success) {
        return {
          success: false,
          error: result.error,
          ui_blocks: []
        };
      }

      const responseText = normalizeText(
        result.data.understanding || result.data.summary,
        "感谢您的咨询，请问还有什么可以帮您？"
      );

      // 构建 UI Blocks
      const uiBlocks = [
        createUIBlock(BLOCK_TYPES.CONSULT_DIALOG, {
          query,
          response: responseText,
          suggestions: result.data.next_steps || []
        })
      ];

      return {
        success: true,
        data: { response: responseText, parsed: result.data },
        ui_blocks: uiBlocks,
        memory_patch: result.memory_patch || null,
        next_node: null
      };
    }
  };
}

/**
 * 节点路由器 - 根据类型创建节点
 */
function createNodeRouter(deps = {}) {
  const nodes = {
    [NODE_TYPES.COMPARE]: createCompareNode(deps),
    [NODE_TYPES.RISK]: createRiskNode(deps),
    [NODE_TYPES.ACTION]: createActionNode(deps),
    [NODE_TYPES.CONSULT]: createConsultNode(deps)
  };

  return {
    /**
     * 获取节点
     */
    getNode(type) {
      return nodes[type] || null;
    },

    /**
     * 执行节点
     */
    async executeNode(type, params = {}) {
      const node = nodes[type];
      if (!node) {
        return {
          success: false,
          error: { code: "UNKNOWN_NODE", message: `未知节点类型: ${type}` },
          ui_blocks: []
        };
      }
      return node.execute(params);
    },

    /**
     * 批量执行节点
     */
    async executeNodes(nodeConfigs = []) {
      const results = [];
      for (const config of nodeConfigs) {
        const { type, params } = config;
        const result = await this.executeNode(type, params);
        results.push({ type, result });
        if (!result.success) {
          break;
        }
      }
      return results;
    }
  };
}

module.exports = {
  NODE_TYPES,
  BLOCK_TYPES,
  createUIBlock,
  createCompareNode,
  createRiskNode,
  createActionNode,
  createConsultNode,
  createNodeRouter
};
