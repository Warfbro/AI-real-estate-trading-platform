const { queryPropertyRecommend } = require("../../../utils/cloud");

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function request({
  query,
  userId = "",
  sessionId = "",
  source = "wechat",
  context = {}
} = {}) {
  return queryPropertyRecommend({
    query,
    userId,
    sessionId,
    source,
    context: normalizeObject(context)
  });
}

module.exports = {
  scene: "property_consult",
  request
};
