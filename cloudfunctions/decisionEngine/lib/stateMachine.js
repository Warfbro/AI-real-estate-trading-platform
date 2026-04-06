/**
 * cloudfunctions/decisionEngine/lib/stateMachine.js - 状态机内核
 *
 * 职责：
 * 1) 接收 event
 * 2) 读取与更新 state
 * 3) 决定 current_stage / current_node
 * 4) 决定是否需要 interrupt
 *
 * 数据流：
 * event -> stateMachine.dispatch() -> 返回 { state, stage, node, interrupt }
 */

const { createInitialDecisionState, applyPairwise, applyCritique } = require("./preferenceUpdater");

/**
 * 工作流事件类型
 */
const WORKFLOW_EVENTS = {
  USER_MESSAGE: "USER_MESSAGE",
  UI_ACTION: "UI_ACTION",
  SYSTEM_ACTION: "SYSTEM_ACTION"
};

/**
 * 工作流动作类型
 */
const WORKFLOW_ACTIONS = {
  START: "start",
  STATE: "state",
  PAIRWISE: "pairwise",
  CRITIQUE: "critique",
  RELAX: "relax",
  APPLY_RELAX: "apply_relax",
  REFRESH: "refresh",
  SKIP: "skip"
};

/**
 * 工作流阶段
 */
const WORKFLOW_STAGES = {
  CLARIFYING: "clarifying",
  RANKING: "ranking",
  PAIRWISE: "pairwise",
  CRITIQUE: "critique",
  RELAXATION: "relaxation",
  COMPLETE: "complete"
};

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function sanitizeStringArray(value, limit = 20) {
  const source = Array.isArray(value) ? value : [value];
  const list = [];
  source.forEach((item) => {
    const text = normalizeText(item);
    if (text && !list.includes(text) && list.length < limit) {
      list.push(text);
    }
  });
  return list;
}

/**
 * 根据当前状态确定阶段
 */
function determineStage({ feasibleCount, hasPairwiseQuestion, hasRelaxationOptions }) {
  if (feasibleCount <= 0 && hasRelaxationOptions) {
    return WORKFLOW_STAGES.RELAXATION;
  }
  if (hasPairwiseQuestion) {
    return WORKFLOW_STAGES.PAIRWISE;
  }
  if (feasibleCount > 0) {
    return WORKFLOW_STAGES.RANKING;
  }
  return WORKFLOW_STAGES.CLARIFYING;
}

/**
 * 创建状态机实例
 */
function createStateMachine(options = {}) {
  const { session = null, context = {} } = options;
  let state = session && session.state_json
    ? session.state_json
    : createInitialDecisionState(context, context.selected_listing_ids || []);

  return {
    /**
     * 获取当前状态
     */
    getState() {
      return state;
    },

    /**
     * 分发事件
     */
    dispatch(action, payload = {}) {
      const actionType = normalizeText(action).toLowerCase();

      switch (actionType) {
        case WORKFLOW_ACTIONS.PAIRWISE: {
          const winnerListingId = normalizeText(payload.winner || payload.winner_listing_id);
          const loserListingId = normalizeText(payload.loser || payload.loser_listing_id);
          if (winnerListingId && loserListingId && winnerListingId !== loserListingId) {
            state = applyPairwise(state, {
              winnerListingId,
              loserListingId,
              winnerValues: payload.winnerValues || {},
              loserValues: payload.loserValues || {}
            });
          }
          break;
        }

        case WORKFLOW_ACTIONS.CRITIQUE: {
          const text = normalizeText(payload.text || payload.critique);
          if (text) {
            const result = applyCritique(state, text);
            state = result.state;
          }
          break;
        }

        case WORKFLOW_ACTIONS.APPLY_RELAX: {
          const relaxationKey = normalizeText(payload.relaxation_key);
          if (relaxationKey && state.hard_constraints) {
            // 简化处理：移除对应的硬约束
            const constraints = { ...state.hard_constraints };
            delete constraints[relaxationKey];
            state = {
              ...state,
              hard_constraints: constraints,
              relaxation_applied: [...(state.relaxation_applied || []), relaxationKey]
            };
          }
          break;
        }

        case WORKFLOW_ACTIONS.SKIP:
          // 跳过当前步骤，记录到状态
          state = {
            ...state,
            skipped_steps: [...(state.skipped_steps || []), new Date().toISOString()]
          };
          break;

        case WORKFLOW_ACTIONS.REFRESH:
        case WORKFLOW_ACTIONS.STATE:
        case WORKFLOW_ACTIONS.RELAX:
        case WORKFLOW_ACTIONS.START:
          // 这些动作不修改状态，只触发重新计算
          break;

        default:
          // 未知动作，不处理
          break;
      }

      return state;
    },

    /**
     * 计算当前阶段和节点
     */
    computeStageAndNode(computedResult) {
      const { feasibility, ranked, relaxationOptions } = computedResult;
      const stage = determineStage({
        feasibleCount: feasibility.feasibleCount,
        hasPairwiseQuestion: Boolean(ranked.nextPairwiseQuestion),
        hasRelaxationOptions: relaxationOptions.length > 0
      });

      // 节点映射
      const nodeMap = {
        [WORKFLOW_STAGES.CLARIFYING]: "CLARIFY_NODE",
        [WORKFLOW_STAGES.RANKING]: "RANK_NODE",
        [WORKFLOW_STAGES.PAIRWISE]: "PAIRWISE_NODE",
        [WORKFLOW_STAGES.CRITIQUE]: "CRITIQUE_NODE",
        [WORKFLOW_STAGES.RELAXATION]: "RELAX_NODE",
        [WORKFLOW_STAGES.COMPLETE]: "COMPLETE_NODE"
      };

      const interrupt = stage === WORKFLOW_STAGES.PAIRWISE || stage === WORKFLOW_STAGES.RELAXATION;

      return {
        stage,
        node: nodeMap[stage] || "UNKNOWN_NODE",
        interrupt
      };
    },

    /**
     * 更新状态中的阻塞信息
     */
    updateBlockers(blockers) {
      state = {
        ...state,
        blockers: Array.isArray(blockers) ? blockers.map((item) => item.code || item) : []
      };
      return state;
    }
  };
}

module.exports = {
  WORKFLOW_EVENTS,
  WORKFLOW_ACTIONS,
  WORKFLOW_STAGES,
  determineStage,
  createStateMachine
};
