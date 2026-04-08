const profileRepo = require("./profileRepo");
const intakeRepo = require("./intakeRepo");
const favoritesStore = require("./favoritesStore");
const { userStateGateway } = require("../../utils/cloud");

module.exports = {
  profileRepo,
  intakeRepo,
  favoritesStore,
  syncBuyerIntake: userStateGateway.syncBuyerIntake,
  syncUserProfile: userStateGateway.syncUserProfile,
  getFavoriteIds: favoritesStore.getFavoriteIds,
  isFavorited: favoritesStore.isFavorited,
  toggleFavorite: favoritesStore.toggleFavorite,
  clearFavorites: favoritesStore.clearFavorites
};
