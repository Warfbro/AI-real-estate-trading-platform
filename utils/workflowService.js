/**
 * utils/workflowService.js - 工作流服务层
 *
 * 职责：
 * 1) 调用 workflowDispatch 统一入口
 * 2) 处理 pairwise / critique / relax / refresh 等操作
 * 3) 接收并返回 current_stage / current_node / ui_blocks
 * 4) 管理工作流状态推进
 *
 * 数据流：
 * 页面调用 -> workflowService -> 云端 workflowDispatch -> 返回统一响应
 */

const { callDecisionEngine } = require("./cloud");
const { buildDecisionContext, buildDecisionLocalListings, getDecisionSeed } = require("./contextBuilder");
const { adaptWorkflowResponse, createErrorBlock } = require("./uiBlockAdapter");

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
  REFRESH: "refresh",
  PAIRWISE: "pairwise",
  CRITIQUE: "critique",
  RELAX: "relax",
  SKIP: "skip"
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

/**
 * 构建工作流请求
 */
function buildWorkflowRequest({
  action,
  userId,
  decisionSessionId = "",
  sessionId = "",
  payload = {},
  context = {},
  localListings = []
}) {
  return {
    action: normalizeText(action),
    user_id: normalizeText(userId),
    decision_session_id: normalizeText(decisionSessionId),
    session_id: normalizeText(sessionId),
    payload: isPlainObject(payload) ? payload : {},
    context: isPlainObject(context) ? context : {},
    listings: Array.isArray(localListings) ? localListings : []
  };
}

/**
 * 执行工作流操作
 */
async function executeWorkflowAction(request) {
  try {
    const result = await callDecisionEngine(request);
    return adaptWorkflowResponse(result);
  } catch (err) {
    return {
      blocks: [createErrorBlock({
        code: "WORKFLOW_ERROR",
        message: normalizeText(err && (err.message || err.errMsg), "工作流执行失败")
      })],
      meta: {
        success: false,
        status: "error",
        error: err
      }
    };
  }
}

/**
 * 启动决策会话
 */
async function startDecision({ userId, session = null, selectedListingIds = [] }) {
  const seed = getDecisionSeed(userId, session);
  if (seed.ids.length < 2) {
    return {
      blocks: [createErrorBlock({
        code: "INSUFFICIENT_LISTINGS",
        message: seed.label
      })],
      meta: {
        success: false,
        status: "blocked",
        current_stage: "clarifying"
      }
    };
  }

  const context = buildDecisionContext({
    userId,
    session,
    selectedListingIds: seed.ids,
    useHistoricalConstraints: false
  });

  const localListings = buildDecisionLocalListings(userId, seed.ids, session);

  const request = buildWorkflowRequest({
    action: WORKFLOW_ACTIONS.START,
    userId,
    payload: { selected_listing_ids: seed.ids },
    context,
    localListings
  });

  return executeWorkflowAction(request);
}

/**
 * 获取决策状态
 */
async function getDecisionState({ userId, decisionSessionId, session = null }) {
  if (!decisionSessionId) {
    return {
      blocks: [],
      meta: { success: false, status: "no_session" }
    };
  }

  const localListings = buildDecisionLocalListings(userId, [], session);

  const request = buildWorkflowRequest({
    action: "state",
    userId,
    decisionSessionId,
    localListings
  });

  return executeWorkflowAction(request);
}

/**
 * 提交二选一偏好
 */
async function submitPairwise({
  userId,
  decisionSessionId,
  session = null,
  winner,
  loser,
  reason = ""
}) {
  const localListings = buildDecisionLocalListings(userId, [], session);

  const request = buildWorkflowRequest({
    action: WORKFLOW_ACTIONS.PAIRWISE,
    userId,
    decisionSessionId,
    payload: {
      winner: normalizeText(winner),
      loser: normalizeText(loser),
      reason: normalizeText(reason)
    },
    localListings
  });

  return executeWorkflowAction(request);
}

/**
 * 提交条件修正
 */
async function submitCritique({
  userId,
  decisionSessionId,
  session = null,
  critique
}) {
  const localListings = buildDecisionLocalListings(userId, [], session);

  const request = buildWorkflowRequest({
    action: WORKFLOW_ACTIONS.CRITIQUE,
    userId,
    decisionSessionId,
    payload: {
      critique: normalizeText(critique)
    },
    localListings
  });

  return executeWorkflowAction(request);
}

/**
 * 获取放宽建议
 */
async function getRelaxation({ userId, decisionSessionId, session = null }) {
  const localListings = buildDecisionLocalListings(userId, [], session);

  const request = buildWorkflowRequest({
    action: WORKFLOW_ACTIONS.RELAX,
    userId,
    decisionSessionId,
    localListings
  });

  return executeWorkflowAction(request);
}

/**
 * 应用放宽建议
 */
async function applyRelaxation({
  userId,
  decisionSessionId,
  session = null,
  relaxationKey
}) {
  const localListings = buildDecisionLocalListings(userId, [], session);

  const request = buildWorkflowRequest({
    action: "apply_relax",
    userId,
    decisionSessionId,
    payload: {
      relaxation_key: normalizeText(relaxationKey)
    },
    localListings
  });

  return executeWorkflowAction(request);
}

/**
 * 刷新决策状态
 */
async function refreshDecision({ userId, decisionSessionId, session = null }) {
  const localListings = buildDecisionLocalListings(userId, [], session);

  const request = buildWorkflowRequest({
    action: WORKFLOW_ACTIONS.REFRESH,
    userId,
    decisionSessionId,
    localListings
  });

  return executeWorkflowAction(request);
}

/**
 * 跳过当前步骤
 */
async function skipCurrentStep({ userId, decisionSessionId, session = null }) {
  const localListings = buildDecisionLocalListings(userId, [], session);

  const request = buildWorkflowRequest({
    action: WORKFLOW_ACTIONS.SKIP,
    userId,
    decisionSessionId,
    localListings
  });

  return executeWorkflowAction(request);
}

module.exports = {
  // 常量
  WORKFLOW_EVENTS,
  WORKFLOW_ACTIONS,

  // 核心方法
  executeWorkflowAction,
  buildWorkflowRequest,

  // 决策操作
  startDecision,
  getDecisionState,
  submitPairwise,
  submitCritique,
  getRelaxation,
  applyRelaxation,
  refreshDecision,
  skipCurrentStep
};
