const listingRepo = require("./listingRepo");
const { listingSearchGateway } = require("../../utils/cloud");

module.exports = {
  ...listingRepo,
  listingRepo,
  queryHomeHot: listingSearchGateway.queryHomeHot,
  queryHomeGuess: listingSearchGateway.queryHomeGuess
};
