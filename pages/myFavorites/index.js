const { isLoggedIn, requireLogin, getSession } = require("../../modules/identity");
const { EVENTS, trackEvent, writeActivityLog } = require("../../utils/track");
const { listingRepo } = require("../../modules/listingSearch");

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function formatFavoriteItem(item) {
  const layout = normalizeText(item.layout_desc, "户型待补充");
  const areaText = item.area_sqm == null ? "面积待补充" : `${item.area_sqm}㎡`;
  const location = `${normalizeText(item.city, "城市待补充")} ${normalizeText(item.district, "区域待补充")}`;
  const priceText = item.price_total == null ? "价格待补充" : `${item.price_total}万`;

  return {
    listing_id: normalizeText(item.listing_id),
    title_text: normalizeText(item.title, "待完善房源"),
    meta_text: `${layout} · ${areaText} · ${location}`,
    price_text: priceText
  };
}

Page({
  data: {
    favorite_list: [],
    has_favorites: false,
    favorite_editing: false
  },

  onShow() {
    if (!isLoggedIn()) {
      requireLogin("/pages/myFavorites/index");
      return;
    }

    trackEvent(EVENTS.PAGE_MY_VIEW, { page: "my_favorites" });
    this.loadFavoriteList();
  },

  loadFavoriteList() {
    const session = getSession();
    const userId = normalizeText(session && (session.login_code || session.user_id));

    const favoriteIdsRaw = listingRepo.getFavoriteIds();
    const favoriteIds = Array.isArray(favoriteIdsRaw)
      ? Array.from(new Set(favoriteIdsRaw.map((item) => normalizeText(item)).filter(Boolean)))
      : [];

    const listingResult = listingRepo.getListings({ userId, includeInactive: false });
    const allListingsRaw =
      listingResult && listingResult.status === "success" ? listingResult.data : [];
    const allListings = allListingsRaw.filter((item) => {
      if (!item || item.status !== "active") return false;
      return normalizeText(item.user_id) === userId;
    });

    const listingMap = {};
    allListings.forEach((item) => {
      listingMap[normalizeText(item.listing_id)] = item;
    });

    const favoriteList = favoriteIds
      .map((listingId) => listingMap[listingId])
      .filter(Boolean)
      .map((item) => formatFavoriteItem(item));

    this.setData({
      favorite_list: favoriteList,
      has_favorites: favoriteList.length > 0
    });
  },

  handleToggleFavoriteEdit() {
    this.setData({
      favorite_editing: !this.data.favorite_editing
    });
  },

  handleOpenFavoriteDetail(event) {
    if (this.data.favorite_editing) {
      return;
    }

    const listingId = normalizeText(event.currentTarget.dataset.listingId);
    if (!listingId) {
      return;
    }

    wx.navigateTo({
      url: `/pages/detail/index?listing_id=${listingId}&source=my_favorites`
    });
  },

  handleRemoveFavorite(event) {
    const listingId = normalizeText(event.currentTarget.dataset.listingId);
    if (!listingId) {
      return;
    }

    const result = listingRepo.toggleFavorite(listingId);
    if (!result || result.status === "error") {
      wx.showToast({
        title: "取消收藏失败",
        icon: "none"
      });
      return;
    }

    this.loadFavoriteList();

    trackEvent(EVENTS.LISTING_FAVORITE, {
      source: "my_favorites",
      listing_id: listingId,
      favorited: false
    });
    writeActivityLog({
      action_type: "listing_favorite_toggle",
      object_type: "listing",
      object_id: listingId,
      detail_json: {
        source: "my_favorites",
        favorited: false
      }
    });
  }
});
