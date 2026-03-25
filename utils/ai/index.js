const propertyConsultAdapter = require("./adapters/propertyConsult");

const AI_SCENES = {
  PROPERTY_CONSULT: "property_consult"
};

const ADAPTERS = {
  [AI_SCENES.PROPERTY_CONSULT]: propertyConsultAdapter
};

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function resolveAdapter(scene) {
  const adapter = ADAPTERS[normalizeText(scene, AI_SCENES.PROPERTY_CONSULT)];
  if (!adapter || typeof adapter.request !== "function") {
    throw new Error(`unknown ai scene: ${scene}`);
  }
  return adapter;
}

async function requestAI({
  scene = AI_SCENES.PROPERTY_CONSULT,
  query,
  userId = "",
  sessionId = "",
  source = "wechat",
  context = {}
} = {}) {
  const adapter = resolveAdapter(scene);
  const result = await adapter.request({
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
        scene: normalizeText(scene, AI_SCENES.PROPERTY_CONSULT)
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
  requestAI,
  requestAIConversation
};
