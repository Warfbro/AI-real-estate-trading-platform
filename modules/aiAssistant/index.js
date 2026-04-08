const chatRepo = require("./chatRepo");
const aiGateway = require("./aiGateway");
const decisionGateway = require("./decisionGateway");

module.exports = {
  chatRepo,
  aiGateway,
  decisionGateway,
  ...aiGateway,
  ...decisionGateway
};
