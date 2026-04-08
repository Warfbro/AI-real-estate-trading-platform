const { aiAssistantGateway } = require("../../utils/cloud");

function normalizeIds(value) {
  const source = Array.isArray(value) ? value : [value];
  return source
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function sanitizeContext(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return {};
  }
  return context;
}

function startDecisionSession({
  userId = "",
  chatSessionId = "",
  selectedListingIds = [],
  context = {},
  localListings = []
} = {}) {
  return aiAssistantGateway.dispatchDecision({
    action: "start",
    userId,
    chatSessionId,
    selectedListingIds: normalizeIds(selectedListingIds),
    context: sanitizeContext(context),
    localListings: Array.isArray(localListings) ? localListings : []
  });
}

function getDecisionState({ decisionSessionId = "", userId = "", localListings = [] } = {}) {
  return aiAssistantGateway.dispatchDecision({
    action: "state",
    decisionSessionId,
    userId,
    localListings: Array.isArray(localListings) ? localListings : []
  });
}

function submitDecisionPairwise({
  decisionSessionId = "",
  winnerListingId = "",
  loserListingId = "",
  userId = "",
  localListings = []
} = {}) {
  return aiAssistantGateway.dispatchDecision({
    action: "pairwise",
    decisionSessionId,
    winnerListingId,
    loserListingId,
    userId,
    localListings: Array.isArray(localListings) ? localListings : []
  });
}

function submitDecisionCritique({
  decisionSessionId = "",
  text = "",
  userId = "",
  localListings = []
} = {}) {
  return aiAssistantGateway.dispatchDecision({
    action: "critique",
    decisionSessionId,
    text,
    userId,
    localListings: Array.isArray(localListings) ? localListings : []
  });
}

function getDecisionRelaxation({ decisionSessionId = "", userId = "", localListings = [] } = {}) {
  return aiAssistantGateway.dispatchDecision({
    action: "relax",
    decisionSessionId,
    userId,
    localListings: Array.isArray(localListings) ? localListings : []
  });
}

module.exports = {
  startDecisionSession,
  getDecisionState,
  submitDecisionPairwise,
  submitDecisionCritique,
  getDecisionRelaxation
};
