const managedAgentProvider = require("./managedAgent");
const openaiCompatibleProvider = require("./openaiCompatible");

const PROVIDER_MODE_ENV_KEYS = ["AI_PROVIDER_MODE", "CLOUD_AI_PROVIDER_MODE"];
const DEFAULT_PROVIDER_MODE = openaiCompatibleProvider.mode;

const PROVIDERS = {
  managed_agent: managedAgentProvider,
  managed: managedAgentProvider,
  property_recommend_webhook: managedAgentProvider,
  openai_compatible: openaiCompatibleProvider,
  openai: openaiCompatibleProvider,
  bailian: openaiCompatibleProvider,
  dashscope: openaiCompatibleProvider,
  qwen: openaiCompatibleProvider
};

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function getEnvValue(keys) {
  for (let i = 0; i < keys.length; i += 1) {
    const value = normalizeText(process.env[keys[i]]);
    if (value) {
      return value;
    }
  }
  return "";
}

function getConfiguredProviderMode() {
  return normalizeText(getEnvValue(PROVIDER_MODE_ENV_KEYS), DEFAULT_PROVIDER_MODE);
}

function resolveProvider(mode) {
  const normalizedMode = normalizeText(mode, getConfiguredProviderMode()).toLowerCase();
  return PROVIDERS[normalizedMode] || openaiCompatibleProvider;
}

module.exports = {
  DEFAULT_PROVIDER_MODE,
  PROVIDER_MODE_ENV_KEYS,
  resolveProvider
};
