const profileRepo = require("./profileRepo");
const intakeRepo = require("./intakeRepo");
const favoritesStore = require("./favoritesStore");

module.exports = {
  profileRepo,
  intakeRepo,
  favoritesStore,
  getFavoriteIds: favoritesStore.getFavoriteIds,
  isFavorited: favoritesStore.isFavorited,
  toggleFavorite: favoritesStore.toggleFavorite,
  clearFavorites: favoritesStore.clearFavorites
};
