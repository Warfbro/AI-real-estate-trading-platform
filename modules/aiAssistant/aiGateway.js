const { aiAssistantGateway } = require("../../utils/cloud");

const AI_SCENES = {
  PROPERTY_CONSULT: "property_consult"
};

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

async function requestAI({
  scene = AI_SCENES.PROPERTY_CONSULT,
  query,
  userId = "",
  sessionId = "",
  source = "wechat",
  context = {}
} = {}) {
  const normalizedScene = normalizeText(scene, AI_SCENES.PROPERTY_CONSULT);
  if (normalizedScene !== AI_SCENES.PROPERTY_CONSULT) {
    throw new Error(`unknown ai scene: ${scene}`);
  }

  const result = await aiAssistantGateway.sendMessage({
    query,
    userId,
    sessionId,
    source,
    context
  });

  if (result && typeof result === "object") {
    return {
      ...result,
      meta: {
        ...(result.meta || {}),
        scene: normalizedScene
      }
    };
  }

  return result;
}

async function requestAIConversation(options = {}) {
  return requestAI({
    scene: AI_SCENES.PROPERTY_CONSULT,
    ...options
  });
}

module.exports = {
  AI_SCENES,
  ensureAIConversation: aiAssistantGateway.ensureConversation,
  requestAI,
  requestAIConversation
};
