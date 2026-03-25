const AI_PAGE_ROUTE = "/pages/ai/index";

const preloadState = {
  aiPreloaded: false
};

function canPreloadPage() {
  return typeof wx !== "undefined" && wx && typeof wx.preloadPage === "function";
}

function preloadAIPage() {
  if (!canPreloadPage() || preloadState.aiPreloaded) {
    return false;
  }
  try {
    wx.preloadPage({
      url: AI_PAGE_ROUTE
    });
    preloadState.aiPreloaded = true;
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = {
  preloadAIPage
};

