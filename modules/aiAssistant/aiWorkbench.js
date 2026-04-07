/**
 * modules/aiAssistant/aiWorkbench.js - AI 工作台统一入口
 *
 * 职责：
 * 1) 整合检索层、生成层、工作流层
 * 2) 提供统一的会话管理
 * 3) 提供事件驱动的状态推进
 *
 * 这是前端与 AI 能力交互的唯一入口
 */

const { createRetrievalProvider } = require("./retrievalProvider");
const { createLLMProvider, LLM_MODES } = require("./llmProvider");
const { createNodeRouter, NODE_TYPES } = require("./nodeHandlers");
const { reliableCall, logObservability, getHealthStatus } = require("./reliability");
const workflowRepo = require("./workflowRepo");

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function generateId(prefix = "ws") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 工作台状态枚举
 */
const WORKBENCH_STATES = {
  IDLE: "idle",
  CLARIFYING: "clarifying",
  SEARCHING: "searching",
  RANKING: "ranking",
  COMPARING: "comparing",
  ASSESSING: "assessing",
  ACTING: "acting",
  COMPLETE: "complete"
};

/**
 * 创建 AI 工作台实例
 */
function createAIWorkbench(options = {}) {
  const retrieval = createRetrievalProvider();
  const llm = createLLMProvider();
  const nodeRouter = createNodeRouter({ retrieval, llm });

  let currentSession = null;
  let currentState = WORKBENCH_STATES.IDLE;
  let candidates = [];
  let context = {};

  /**
   * 初始化会话
   */
  async function initSession(userId, intakeId = null) {
    const sessionId = generateId("session");

    currentSession = {
      session_id: sessionId,
      user_id: userId,
      intake_id: intakeId,
      created_at: Date.now(),
      updated_at: Date.now()
    };

    currentState = WORKBENCH_STATES.IDLE;
    candidates = [];
    context = {};

    // 持久化
    workflowRepo.createSession({
      workflow_session_id: sessionId,
      user_id: userId,
      intake_id: intakeId,
      workflow_type: "decision"
    });

    logObservability({
      level: "info",
      operation: "workbench:init",
      message: `会话初始化: ${sessionId}`,
      session_id: sessionId
    });

    return currentSession;
  }

  /**
   * 恢复会话
   */
  async function resumeSession(sessionId) {
    const sessionResult = workflowRepo.getSession(sessionId);

    if (sessionResult.status !== "success" || !sessionResult.data) {
      return { success: false, error: { code: "SESSION_NOT_FOUND", message: "会话不存在" } };
    }

    currentSession = {
      ...sessionResult.data,
      session_id: sessionResult.data.workflow_session_id
    };

    // 恢复最近的检查点
    const checkpointsResult = workflowRepo.getSessionCheckpoints(sessionId);
    const checkpoints = checkpointsResult.data || [];
    if (checkpoints.length > 0) {
      const latest = checkpoints[checkpoints.length - 1];
      if (latest.state_snapshot) {
        currentState = latest.state_snapshot.state || WORKBENCH_STATES.IDLE;
        candidates = latest.state_snapshot.candidates || [];
        context = latest.state_snapshot.context || {};
      }
    }

    logObservability({
      level: "info",
      operation: "workbench:resume",
      message: `会话恢复: ${sessionId}`,
      session_id: sessionId,
      state: currentState
    });

    return { success: true, session: currentSession, state: currentState };
  }

  /**
   * 处理用户输入
   */
  async function handleUserInput(input, inputContext = {}) {
    if (!currentSession) {
      return { success: false, error: { code: "NO_SESSION", message: "请先初始化会话" } };
    }

    const sessionId = currentSession.session_id;
    const mergedContext = { ...context, ...inputContext };

    logObservability({
      level: "info",
      operation: "workbench:input",
      message: `处理用户输入`,
      session_id: sessionId,
      input: normalizeText(input).slice(0, 100)
    });

    // 记录事件
    workflowRepo.recordEvent({
      workflowSessionId: sessionId,
      eventType: "user_input",
      eventData: { input, context: inputContext },
      userId: currentSession.user_id || ""
    });

    try {
      // 1. 理解用户意图
      const intentResult = await reliableCall(
        "llm:intent",
        () => llm.parseIntent(input, mergedContext),
        { timeout: 8000 }
      );

      if (!intentResult.success) {
        return {
          success: false,
          error: intentResult.error,
          state: currentState,
          ui_blocks: []
        };
      }

      const intent = intentResult.data.data || {};
      const intentType = normalizeText(intent.intent_type, "search");

      // 2. 根据意图类型路由处理
      let result;

      switch (intentType) {
        case "search":
        case "recommend":
          result = await handleSearchIntent(input, intent, mergedContext);
          break;

        case "compare":
          result = await handleCompareIntent(intent, mergedContext);
          break;

        case "risk":
        case "assess":
          result = await handleRiskIntent(intent, mergedContext);
          break;

        case "action":
        case "next_step":
          result = await handleActionIntent(intent, mergedContext);
          break;

        case "clarify":
        case "question":
          result = await handleClarifyIntent(input, intent, mergedContext);
          break;

        default:
          result = await handleConsultIntent(input, intent, mergedContext);
      }

      // 3. 更新上下文
      if (result.memory_patch) {
        context = { ...context, ...result.memory_patch };
      }

      // 4. 创建检查点
      workflowRepo.createCheckpoint({
        workflowSessionId: sessionId,
        reason: `intent:${intentType}`,
        stage: currentState,
        stateSnapshot: {
          state: currentState,
          candidates,
          context
        }
      });

      return {
        success: true,
        state: currentState,
        candidates,
        ...result
      };
    } catch (err) {
      logObservability({
        level: "error",
        operation: "workbench:input",
        message: normalizeText(err && err.message, "处理失败"),
        session_id: sessionId,
        error: err
      });

      return {
        success: false,
        error: { code: "PROCESS_ERROR", message: normalizeText(err && err.message, "处理失败") },
        state: currentState,
        ui_blocks: []
      };
    }
  }

  /**
   * 处理搜索意图
   */
  async function handleSearchIntent(input, intent, ctx) {
    currentState = WORKBENCH_STATES.SEARCHING;

    // 构建过滤条件
    const filters = {
      city: ctx.active_intake && ctx.active_intake.city,
      district: intent.constraints && intent.constraints.district,
      budget_min: ctx.active_intake && ctx.active_intake.budget_min,
      budget_max: ctx.active_intake && ctx.active_intake.budget_max,
      area_min: intent.constraints && intent.constraints.area_min,
      area_max: intent.constraints && intent.constraints.area_max,
      layout: intent.constraints && intent.constraints.layout,
      keyword: input
    };

    // 执行检索
    const searchResult = await reliableCall(
      "retrieval:search",
      () => retrieval.search({ query: input, filters, options: { limit: 20 } }),
      { timeout: 5000 }
    );

    if (!searchResult.success) {
      return {
        ui_blocks: [{ type: "text", data: { content: "搜索服务暂时不可用，请稍后重试" } }],
        memory_patch: null
      };
    }

    candidates = searchResult.data.candidates || [];

    // 重排
    const rerankResult = retrieval.rerank(candidates, ctx);
    if (rerankResult.reranked) {
      candidates = rerankResult.candidates;
    }

    currentState = candidates.length > 0 ? WORKBENCH_STATES.RANKING : WORKBENCH_STATES.CLARIFYING;

    // 生成解释
    const explainResult = await llm.explainCandidates(candidates.slice(0, 5), ctx);

    const uiBlocks = [
      {
        type: "card_list",
        data: {
          items: candidates.slice(0, 10).map((c) => ({
            listing_id: c.listing_id,
            title: c.title || c.community_name,
            price: c.price_total,
            area: c.area_sqm,
            layout: c.layout,
            thumb: c.images && c.images[0]
          }))
        }
      }
    ];

    if (explainResult.success && explainResult.data.summary) {
      uiBlocks.push({
        type: "text",
        data: { content: explainResult.data.summary }
      });
    }

    return {
      ui_blocks: uiBlocks,
      memory_patch: explainResult.memory_patch
    };
  }

  /**
   * 处理对比意图
   */
  async function handleCompareIntent(intent, ctx) {
    currentState = WORKBENCH_STATES.COMPARING;

    const compareTarget = candidates.slice(0, 3);
    const result = await nodeRouter.executeNode(NODE_TYPES.COMPARE, {
      candidates: compareTarget,
      context: ctx
    });

    return {
      ui_blocks: result.ui_blocks || [],
      memory_patch: result.memory_patch
    };
  }

  /**
   * 处理风险评估意图
   */
  async function handleRiskIntent(intent, ctx) {
    currentState = WORKBENCH_STATES.ASSESSING;

    const result = await nodeRouter.executeNode(NODE_TYPES.RISK, {
      candidates,
      context: ctx
    });

    return {
      ui_blocks: result.ui_blocks || [],
      memory_patch: result.memory_patch
    };
  }

  /**
   * 处理行动意图
   */
  async function handleActionIntent(intent, ctx) {
    currentState = WORKBENCH_STATES.ACTING;

    const result = await nodeRouter.executeNode(NODE_TYPES.ACTION, {
      candidates,
      context: ctx
    });

    return {
      ui_blocks: result.ui_blocks || [],
      memory_patch: result.memory_patch
    };
  }

  /**
   * 处理澄清意图
   */
  async function handleClarifyIntent(input, intent, ctx) {
    currentState = WORKBENCH_STATES.CLARIFYING;

    const clarifyResult = await llm.generateClarification(input, ctx);

    const uiBlocks = [];
    if (clarifyResult.success) {
      uiBlocks.push({
        type: "text",
        data: { content: clarifyResult.data.message }
      });

      if (clarifyResult.data.questions && clarifyResult.data.questions.length) {
        uiBlocks.push({
          type: "question_list",
          data: { questions: clarifyResult.data.questions }
        });
      }
    }

    return {
      ui_blocks: uiBlocks,
      memory_patch: clarifyResult.memory_patch
    };
  }

  /**
   * 处理咨询意图
   */
  async function handleConsultIntent(input, intent, ctx) {
    const result = await nodeRouter.executeNode(NODE_TYPES.CONSULT, {
      query: input,
      candidates,
      context: ctx
    });

    return {
      ui_blocks: result.ui_blocks || [],
      memory_patch: result.memory_patch
    };
  }

  /**
   * 直接执行节点
   */
  async function executeNode(nodeType, params = {}) {
    return nodeRouter.executeNode(nodeType, {
      ...params,
      candidates: params.candidates || candidates,
      context: { ...context, ...params.context }
    });
  }

  /**
   * 获取当前状态
   */
  function getState() {
    return {
      session: currentSession,
      state: currentState,
      candidates,
      context,
      health: getHealthStatus()
    };
  }

  /**
   * 重置工作台
   */
  function reset() {
    currentSession = null;
    currentState = WORKBENCH_STATES.IDLE;
    candidates = [];
    context = {};
  }

  return {
    initSession,
    resumeSession,
    handleUserInput,
    executeNode,
    getState,
    reset,
    STATES: WORKBENCH_STATES,
    NODE_TYPES
  };
}

/**
 * 单例工作台实例
 */
let workbenchInstance = null;

function getAIWorkbench() {
  if (!workbenchInstance) {
    workbenchInstance = createAIWorkbench();
  }
  return workbenchInstance;
}

module.exports = {
  WORKBENCH_STATES,
  createAIWorkbench,
  getAIWorkbench
};
