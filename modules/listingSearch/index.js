const listingRepo = require("./listingRepo");
const { getHomeHotListings, getHomeGuessListings } = require("../../utils/cloud");

module.exports = {
  ...listingRepo,
  listingRepo,
  getHomeHotListings,
  getHomeGuessListings
};
