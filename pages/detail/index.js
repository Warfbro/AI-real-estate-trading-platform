const { isLoggedIn, requireLogin, getSession } = require("../../modules/identity/index.js");
const { EVENTS, trackEvent, writeActivityLog } = require("../../utils/track");
const { STORAGE_KEYS, get, set } = require("../../utils/storage");

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function pickFirstText(...values) {
  for (let i = 0; i < values.length; i += 1) {
    const text = normalizeText(values[i]);
    if (text) {
      return text;
    }
  }
  return "";
}

function dedupeMedia(items) {
  const seen = new Set();
  const next = [];
  (items || []).forEach((item) => {
    if (!item || !item.url) {
      return;
    }
    const key = `${item.type}:${item.url}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    next.push(item);
  });
  return next;
}

function inferMediaType(url, hintedType = "") {
  const source = String(url || "").toLowerCase();
  if (hintedType === "video") {
    return "video";
  }
  if (/\.(mp4|mov|m4v|webm)(\?|$)/i.test(source)) {
    return "video";
  }
  return "image";
}

function buildMediaList(listing) {
  const normalized = listing && typeof listing.normalized_json === "object" ? listing.normalized_json : {};
  const media = [];

  const pushMedia = (url, hintedType = "") => {
    const safeUrl = normalizeText(url);
    if (!safeUrl) {
      return;
    }
    media.push({
      type: inferMediaType(safeUrl, hintedType),
      url: safeUrl
    });
  };

  pushMedia(listing && listing.video_url, "video");
  pushMedia(normalized.video_url, "video");
  pushMedia(normalized.video_file_url, "video");

  pushMedia(listing && listing.raw_file_url);
  pushMedia(listing && listing.cover_image_url);
  pushMedia(normalized.cover_image_url);
  pushMedia(normalized.image_url);
  pushMedia(normalized.photo_url);
  pushMedia(normalized.raw_file_url);

  if (Array.isArray(normalized.media_urls)) {
    normalized.media_urls.forEach((url) => pushMedia(url));
  }
  if (Array.isArray(normalized.video_urls)) {
    normalized.video_urls.forEach((url) => pushMedia(url, "video"));
  }

  return dedupeMedia(media);
}

function buildPositionText(listing) {
  const normalized = listing && typeof listing.normalized_json === "object" ? listing.normalized_json : {};
  const city = normalizeText(listing && listing.city);
  const district = pickFirstText(listing && listing.district, normalized.district, normalized.region);
  const community = pickFirstText(listing && listing.community_name, normalized.community_name);
  const address = pickFirstText(listing && listing.address, normalized.address, normalized.position, normalized.location);

  const parts = [city, district, community].filter(Boolean);
  if (parts.length) {
    return parts.join(" ");
  }
  return address;
}

Page({
  data: {
    listing_id: "",
    source: "search",
    listing: null,
    has_listing: false,
    display_title: "待完善房源",
    display_price: "待补充",
    display_area: "待补充",
    display_layout: "待补充",
    display_floor: "待补充",
    display_orientation: "待补充",
    display_position: "待补充",
    raw_text_display: "-",
    media_list: [],
    has_media: false
  },

  onLoad(options) {
    this.setData({
      listing_id: options.listing_id || "",
      source: options.source || "search"
    });
  },

  onShow() {
    const listingId = this.data.listing_id;
    if (!listingId) {
      wx.showToast({
        title: "缺少房源 ID",
        icon: "none"
      });
      return;
    }

    if (!isLoggedIn()) {
      requireLogin(`/pages/detail/index?listing_id=${listingId}`);
      return;
    }

    trackEvent(EVENTS.PAGE_DETAIL_VIEW, { listing_id: listingId, source: this.data.source || "search" });
    writeActivityLog({
      action_type: "detail_view",
      object_type: "listing",
      object_id: listingId,
      detail_json: {
        source: this.data.source || "search"
      }
    });
    this.loadData();
  },

  loadData() {
    const session = getSession();
    const listings = get(STORAGE_KEYS.LISTINGS, []).filter(
      (item) => item.user_id === session.login_code
    );
    const listing = listings.find((item) => item.listing_id === this.data.listing_id) || null;

    if (!listing) {
      this.setData({
        listing: null,
        has_listing: false
      });
      return;
    }

    const normalized = listing && typeof listing.normalized_json === "object" ? listing.normalized_json : {};
    const mediaList = buildMediaList(listing);
    const layoutText = pickFirstText(listing.layout_desc, normalized.layout_desc);
    const floorText = pickFirstText(listing.floor_info, normalized.floor_info, normalized.floor, normalized.floor_desc);
    const orientationText = pickFirstText(listing.orientation, normalized.orientation, normalized.direction);
    const positionText = buildPositionText(listing);

    this.setData({
      listing,
      has_listing: true,
      display_title: normalizeText(listing.title, "待完善房源"),
      display_price:
        listing.price_total === null || listing.price_total === undefined
          ? "待补充"
          : `${listing.price_total}万`,
      display_area:
        listing.area_sqm === null || listing.area_sqm === undefined
          ? "待补充"
          : `${listing.area_sqm}㎡`,
      display_layout: layoutText || "待补充",
      display_floor: floorText || "待补充",
      display_orientation: orientationText || "待补充",
      display_position: positionText || "待补充",
      raw_text_display: normalizeText(listing.raw_text, "-"),
      media_list: mediaList,
      has_media: mediaList.length > 0
    });
  }
});
