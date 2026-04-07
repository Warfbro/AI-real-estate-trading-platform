const { isLoggedIn, getSession } = require("../../modules/identity/index.js");
const { EVENTS, trackEvent, writeActivityLog } = require("../../utils/track");
const { STORAGE_KEYS, get, set } = require("../../utils/storage");
const {
  AI_SCENES,
  requestAIConversation,
  startDecisionSession,
  getDecisionState,
  submitDecisionPairwise,
  submitDecisionCritique,
  getDecisionRelaxation,
  chatRepo
} = require("../../modules/aiAssistant/index.js");
const {
  syncBuyerIntake,
  syncUserProfile,
  syncChatSession,
  syncChatMessage
} = require("../../utils/cloud");
const { listingRepo } = require("../../modules/listingSearch/index.js");
const { intakeRepo } = require("../../modules/userState/index.js");

const NAV_REVEAL_DELAY_MS = 160;
const MAX_QUERY_LENGTH = 1000;
const MAX_FAVORITE_PICK_COUNT = 5;
const MAX_CHAT_THREADS = 20;
const MAX_MESSAGES_PER_THREAD = 80;
const RECENT_MESSAGE_LIMIT = 5;
const PROFILE_ARRAY_FIELDS = ["district"];
const REQUIREMENT_ARRAY_FIELDS = ["target_area", "candidate_house_ids"];
const DECISION_STAGE_TEXT_MAP = {
  clarifying: "澄清条件",
  ranking: "候选排序",
  pairwise: "二选一偏好",
  critique: "条件修正",
  relaxation: "放宽建议"
};

function nowISOTime() {
  return new Date().toISOString();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function toNumber(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "string" && !value.trim()) {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function formatThreadTime(value) {
  const text = normalizeText(value);
  if (!text) {
    return "";
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hours}:${minutes}`;
}

function sanitizeCompactContext(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    const summary = normalizeText(value);
    return summary ? { history_summary: summary } : null;
  }
  if (Array.isArray(value)) {
    return value.length ? { history_turns: value.slice(0, 50) } : null;
  }
  if (isPlainObject(value)) {
    return value;
  }
  return null;
}

function extractCompactContext(result) {
  if (!isPlainObject(result)) {
    return null;
  }

  const data = isPlainObject(result.data) ? result.data : {};
  const candidates = [
    data.compact_context,
    data.next_context,
    data.context_snapshot,
    data.compact_history,
    data.condensed_history,
    result.compact_context,
    result.next_context,
    result.context_snapshot,
    result.compact_history,
    result.condensed_history
  ];

  for (let i = 0; i < candidates.length; i += 1) {
    const compact = sanitizeCompactContext(candidates[i]);
    if (compact) {
      return compact;
    }
  }
  return null;
}

function sanitizeStringArray(value, limit = 10) {
  const source = Array.isArray(value) ? value : [value];
  const list = [];

  for (let i = 0; i < source.length; i += 1) {
    const text = normalizeText(source[i]);
    if (text && !list.includes(text)) {
      list.push(text);
    }
    if (list.length >= limit) {
      break;
    }
  }

  return list;
}

function extractSessionSummary(result) {
  if (!isPlainObject(result)) {
    return "";
  }

  const data = isPlainObject(result.data) ? result.data : {};
  const compactContext = extractCompactContext(result) || extractCompactContext(data);
  const candidates = [
    data.session_summary,
    data.history_summary,
    result.session_summary,
    result.history_summary,
    compactContext && compactContext.history_summary
  ];

  for (let i = 0; i < candidates.length; i += 1) {
    const summary = normalizeText(candidates[i]);
    if (summary) {
      return summary;
    }
  }

  return "";
}

function extractValidatedMemoryPatch(result) {
  if (!isPlainObject(result)) {
    return {};
  }

  const data = isPlainObject(result.data) ? result.data : {};
  const patch = data.memory_patch;
  return isPlainObject(patch) ? patch : {};
}

function extractMemoryPatchRejected(result) {
  if (!isPlainObject(result) || !isPlainObject(result.data)) {
    return [];
  }
  return Array.isArray(result.data.memory_patch_rejected) ? result.data.memory_patch_rejected : [];
}

function buildRecentMessages(messages, limit = RECENT_MESSAGE_LIMIT) {
  const list = Array.isArray(messages) ? messages : [];
  return list
    .map((item) => sanitizeMessage(item))
    .filter(Boolean)
    .slice(-limit)
    .map((item) => ({
      role: item.role,
      content: item.text,
      created_at: item.created_at
    }));
}

function mergePatchObject(current, patch, arrayFields = []) {
  const base = isPlainObject(current) ? { ...current } : {};
  const incoming = isPlainObject(patch) ? patch : {};

  Object.keys(incoming).forEach((field) => {
    if (arrayFields.includes(field)) {
      const merged = sanitizeStringArray([].concat(base[field] || [], incoming[field] || []), 20);
      if (merged.length) {
        base[field] = merged;
      }
      return;
    }
    base[field] = incoming[field];
  });

  return base;
}

function splitMemoryPatch(memoryPatch) {
  const patch = isPlainObject(memoryPatch) ? memoryPatch : {};
  const profilePatch = {};
  const requirementPatch = {};
  const profileFields = [
    "city",
    "district",
    "budget_min",
    "budget_max",
    "buy_purpose",
    "school_priority",
    "commute_priority",
    "elevator_required",
    "accept_old_house",
    "preferred_layout"
  ];
  const requirementFields = ["target_area", "current_stage", "candidate_house_ids", "notes"];

  profileFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      profilePatch[field] = patch[field];
    }
  });

  requirementFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      requirementPatch[field] = patch[field];
    }
  });

  return {
    profilePatch,
    requirementPatch
  };
}

function byUpdatedDesc(a, b) {
  const aTime = a.updated_at || a.created_at || "";
  const bTime = b.updated_at || b.created_at || "";
  return aTime > bTime ? -1 : 1;
}

function getLatestSubmittedIntake(userId) {
  const userAliases = getUserAliases(userId);
  if (!userAliases.length) {
    return null;
  }

  const intakeResult = intakeRepo.getIntakes({ status: null });
  const allIntakes = intakeResult && intakeResult.status === "success" ? intakeResult.data : [];
  const list = allIntakes
    .filter(
      (item) =>
        item &&
        item.status === "submitted" &&
        userAliases.includes(normalizeText(item.user_id))
    )
    .sort(byUpdatedDesc);

  return list.length ? list[0] : null;
}

function getActiveListings(userId) {
  const userAliases = getUserAliases(userId);
  if (!userAliases.length) {
    return [];
  }

  const listingResult = listingRepo.getListings({ includeInactive: false });
  const allListings = listingResult && listingResult.status === "success" ? listingResult.data : [];

  return allListings
    .filter(
      (item) =>
        item &&
        item.status === "active" &&
        userAliases.includes(normalizeText(item.user_id))
    )
    .sort(byUpdatedDesc);
}

function getUserAliases(userId) {
  const session = getSession();
  return sanitizeStringArray(
    [
      userId,
      session && session.user_id,
      session && session.login_code,
      session && session.openid
    ],
    10
  );
}

function buildDecisionLocalListings(userId, selectedListingIds = []) {
  const selectedIds = sanitizeStringArray(selectedListingIds, 20);
  const listings = getActiveListings(userId);
  if (!selectedIds.length) {
    return listings.slice(0, 30);
  }

  const selectedSet = new Set(selectedIds);
  const prioritized = [];
  const fallback = [];

  listings.forEach((item) => {
    const listingId = normalizeText(item && item.listing_id);
    if (!listingId) {
      return;
    }
    if (selectedSet.has(listingId)) {
      prioritized.push(item);
      return;
    }
    fallback.push(item);
  });

  return prioritized.concat(fallback).slice(0, 30);
}

function getActiveListingCount(userId) {
  return getActiveListings(userId).length;
}

function createSessionId() {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createMessage(role, text) {
  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    role,
    text: String(text || ""),
    created_at: nowISOTime()
  };
}

function createDefaultMessages() {
  return [
    createMessage("ai", "您好，我是您的房产决策助手。你可以直接告诉我预算、城市、户型和关注点。")
  ];
}

function sanitizeMessage(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const text = normalizeText(item.text);
  if (!text) {
    return null;
  }

  const role = normalizeText(item.role, "ai");
  return {
    id: normalizeText(item.id, `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    role: role === "user" || role === "system" ? role : "ai",
    text,
    created_at: normalizeText(item.created_at, nowISOTime())
  };
}

function buildThreadTitle(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const firstUserMessage = list.find((item) => item && item.role === "user" && normalizeText(item.text));
  const text = normalizeText(firstUserMessage && firstUserMessage.text);
  if (!text) {
    return "New Chat";
  }
  return text.length > 24 ? `${text.slice(0, 24)}...` : text;
}

function buildThreadPreview(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const text = normalizeText(list[i] && list[i].text);
    if (text) {
      return text.length > 36 ? `${text.slice(0, 36)}...` : text;
    }
  }
  return "No messages yet";
}

function sanitizeThread(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const sessionId = normalizeText(item.session_id);
  if (!sessionId) {
    return null;
  }

  const rawMessages = Array.isArray(item.messages) ? item.messages : [];
  const messages = rawMessages
    .map((msg) => sanitizeMessage(msg))
    .filter(Boolean)
    .slice(-MAX_MESSAGES_PER_THREAD);

  const normalizedMessages = messages.length ? messages : createDefaultMessages();
  const createdAt = normalizeText(item.created_at, nowISOTime());
  const updatedAt = normalizeText(item.updated_at, createdAt);
  const compactContext = sanitizeCompactContext(item.compact_context);

  return {
    session_id: sessionId,
    source: normalizeText(item.source, "home"),
    decision_session_id: normalizeText(item.decision_session_id),
    title: normalizeText(item.title, buildThreadTitle(normalizedMessages)),
    preview: normalizeText(item.preview, buildThreadPreview(normalizedMessages)),
    summary: normalizeText(item.summary),
    created_at: createdAt,
    updated_at: updatedAt,
    compact_context: compactContext,
    messages: normalizedMessages
  };
}

function createThread({ sessionId, source = "home" }) {
  const messages = createDefaultMessages();
  const now = nowISOTime();
  return {
    session_id: sessionId,
    source: normalizeText(source, "home"),
    decision_session_id: "",
    title: buildThreadTitle(messages),
    preview: buildThreadPreview(messages),
    summary: "",
    created_at: now,
    updated_at: now,
    compact_context: null,
    messages
  };
}

function formatRecommendationResponse(data) {
  const safe = data && typeof data === "object" ? data : {};
  const lines = [];

  const understanding = normalizeText(safe.understanding);
  if (understanding) {
    lines.push(`理解：${understanding}`);
  }

  const summary = normalizeText(safe.summary);
  if (summary) {
    lines.push(`结果：${summary}`);
  }

  const recommendations = Array.isArray(safe.recommendations) ? safe.recommendations : [];
  if (recommendations.length) {
    lines.push("推荐房源：");
    recommendations.slice(0, 5).forEach((item, index) => {
      const detail = item && typeof item === "object" ? item.listing_detail || {} : {};
      const title = normalizeText(detail.title || item.title || `房源${index + 1}`);
      const score = toNumber(item.match_score);
      const scoreText = score == null ? "" : `（匹配${score}%）`;
      const recommendation = normalizeText(item.recommendation);
      const concerns = Array.isArray(item.concerns) ? item.concerns.filter(Boolean) : [];
      const concernText = concerns.length ? `；关注：${concerns.join("、")}` : "";
      lines.push(`${index + 1}. ${title}${scoreText}${recommendation ? `：${recommendation}` : ""}${concernText}`);
    });
  }

  const advice = normalizeText(safe.advice);
  if (advice) {
    lines.push(`建议：${advice}`);
  }

  const nextSteps = Array.isArray(safe.next_steps) ? safe.next_steps.filter(Boolean) : [];
  if (nextSteps.length) {
    lines.push(`下一步：${nextSteps.join(" / ")}`);
  }

  return lines.length
    ? lines.join("\n")
    : "已收到你的需求，但暂时没有可展示的推荐结果，请补充更多条件后重试。";
}

function formatClarificationResponse(data) {
  const safe = data && typeof data === "object" ? data : {};
  const lines = [];

  const message = normalizeText(
    safe.message || safe.understanding,
    "为了给你更精准的推荐，还需要补充一些信息。"
  );
  lines.push(message);

  const questions = Array.isArray(safe.questions) ? safe.questions.filter(Boolean) : [];
  if (questions.length) {
    lines.push("请补充：");
    questions.forEach((item, index) => {
      lines.push(`${index + 1}. ${item}`);
    });
  }

  return lines.join("\n");
}

function formatErrorResponse(error) {
  const safe = error && typeof error === "object" ? error : {};
  const message = normalizeText(safe.message, "AI 服务暂时不可用，请稍后重试。");
  const code = normalizeText(safe.code);
  return code ? `${message}\n错误码：${code}` : message;
}

function formatFavoriteDesc(listing) {
  const price = listing.price_total == null ? "总价待补充" : `${listing.price_total}万`;
  const area = listing.area_sqm == null ? "面积待补充" : `${listing.area_sqm}㎡`;
  const district = normalizeText(listing.district || listing.city, "区域待补充");
  return `${price} | ${area} | ${district}`;
}

function buildFavoriteAutoQuery(favoriteItems) {
  const head = "请基于我刚选择的收藏房源，给出推荐排序、关键风险和下一步建议：";
  const lines = favoriteItems.map((item, index) => {
    const title = normalizeText(item.title_text, `收藏房源${index + 1}`);
    const desc = normalizeText(item.desc_text, "信息待补充");
    return `${index + 1}. ${title}（${desc}）`;
  });

  const query = `${head}\n${lines.join("\n")}`;
  return query.length > MAX_QUERY_LENGTH ? query.slice(0, MAX_QUERY_LENGTH) : query;
}

function formatDecisionListingDesc(item) {
  const safe = item && typeof item === "object" ? item : {};
  const priceText = safe.price_total == null ? "总价待补充" : `${safe.price_total}万`;
  const areaText = safe.area_sqm == null ? "面积待补充" : `${safe.area_sqm}㎡`;
  const districtText = normalizeText(safe.district || safe.city, "区域待补充");
  return `${priceText} | ${areaText} | ${districtText}`;
}

function buildDecisionBucketCards(buckets) {
  const safe = buckets && typeof buckets === "object" ? buckets : {};
  const cards = [
    { key: "stable", title: "稳妥型", items: Array.isArray(safe.stable) ? safe.stable : [] },
    { key: "balanced", title: "均衡型", items: Array.isArray(safe.balanced) ? safe.balanced : [] },
    { key: "value", title: "性价比型", items: Array.isArray(safe.value) ? safe.value : [] }
  ];

  return cards
    .map((card) => ({
      key: card.key,
      title: card.title,
      items: card.items.map((item) => ({
        ...item,
        desc_text: formatDecisionListingDesc(item)
      }))
    }))
    .filter((card) => card.items.length > 0);
}

function summarizeDecisionBlockers(blockers) {
  const list = Array.isArray(blockers) ? blockers : [];
  if (!list.length) {
    return "";
  }
  const first = list[0];
  return normalizeText(first && first.message);
}

function getDecisionErrorText(result, fallback) {
  const error = result && result.error && typeof result.error === "object" ? result.error : {};
  return normalizeText(error.details, normalizeText(error.message, fallback));
}

Page({
  data: {
    showAnim: false,
    showNavBar: false,
    statusBarHeight: 20,
    navBarHeight: 44,
    totalNavHeight: 64,
    chatTopOffset: 80,
    chatMinHeight: 420,
    drawerTopOffset: 64,
    capWidth: 90,
    canBack: true,
    fallback_tab_route: "/pages/home/index",

    showMorePanel: false,
    showFavoritePicker: false,
    favorite_options: [],
    has_favorite_options: false,
    favorite_selected_count_text: "0",
    favorite_confirm_disabled: true,
    favorite_empty_text: "暂无可选收藏",

    scrollTo: "",
    show_history_drawer: false,
    drawerHeight: 500,
    offset: -500,
    isDragging: false,
    drawerState: "closed",
    dragDir: "",

    source: "home",
    chat_threads: [],
    has_chat_threads: false,
    active_session_id: "",

    decision_loading: false,
    decision_session_id: "",
    decision_stage_text: "",
    decision_seed_text: "",
    decision_seed_ready: false,
    decision_blocker_text: "",
    decision_bucket_cards: [],
    has_decision_buckets: false,
    pairwise_question: null,
    has_pairwise_question: false,
    decision_show_critique_editor: false,
    decision_show_relaxation: false,
    critique_input: "",
    relaxation_options: [],
    has_relaxation_options: false,

    messages: [],
    chatInput: "",
    sending: false
  },

  applyHistoryDrawerLayout(showHistoryDrawer = false, extraData = {}, callback) {
    const base = this._layoutBase || {};
    const totalNavHeight = base.totalNavHeight || 64;
    const navBarHeight = base.navBarHeight || 44;
    const statusBarHeight = base.statusBarHeight || 20;
    const capWidth = base.capWidth || 90;
    const windowHeight = base.windowHeight || totalNavHeight + 640;
    const bottomSafeInset = base.bottomSafeInset || 0;
    const maxViewport = Math.max(windowHeight - totalNavHeight, 320);
    const drawerPeekHeight = showHistoryDrawer ? Math.max(Math.round(navBarHeight * 0.58), 28) : 0;
    const drawerOverlapHeight = showHistoryDrawer ? Math.max(Math.round(drawerPeekHeight * 0.35), 10) : 0;
    const drawerHeight = Math.max(Math.round(maxViewport * 0.62), 320);
    const chatTopOffset = showHistoryDrawer
      ? totalNavHeight + drawerPeekHeight - drawerOverlapHeight
      : totalNavHeight + 4;
    const inputAreaReserve = 110 + bottomSafeInset;
    const chatMinHeight = Math.max(windowHeight - chatTopOffset - inputAreaReserve, 240);
    const nextData = {
      statusBarHeight,
      navBarHeight,
      totalNavHeight,
      capWidth,
      chatTopOffset,
      chatMinHeight,
      drawerTopOffset: showHistoryDrawer
        ? Math.max(totalNavHeight - drawerOverlapHeight, 0)
        : totalNavHeight,
      drawerHeight,
      show_history_drawer: showHistoryDrawer,
      ...extraData
    };

    if (!showHistoryDrawer) {
      nextData.offset = -drawerHeight;
      nextData.drawerState = "closed";
      nextData.dragDir = "";
      nextData.isDragging = false;
    } else if (!Object.prototype.hasOwnProperty.call(extraData, "offset")) {
      nextData.offset = this.data.drawerState === "open" ? 0 : -drawerHeight;
    }

    this.setData(nextData, callback);
  },

  onLoad(options) {
    const opts = options && typeof options === "object" ? options : {};
    const source = normalizeText(opts.source, "home");
    let entryTab = normalizeText(opts.entry_tab);
    if (entryTab) {
      try {
        entryTab = decodeURIComponent(entryTab);
      } catch (err) {
        entryTab = normalizeText(opts.entry_tab);
      }
    }
    const fallbackTabRoute =
      entryTab === "/pages/my/index" || entryTab === "/pages/home/index"
        ? entryTab
        : "/pages/home/index";

    const sysInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    let navH = 44;
    let diff = 0;
    let capW = 90;

    if (wx.getMenuButtonBoundingClientRect) {
      const rect = wx.getMenuButtonBoundingClientRect();
      navH = rect.height;
      diff = rect.top - sysInfo.statusBarHeight;
      capW = sysInfo.windowWidth - rect.left;
    }

    const navBarHeight = navH + diff * 2;
    const totalNavHeight = sysInfo.statusBarHeight + navBarHeight;
    this._layoutBase = {
      statusBarHeight: sysInfo.statusBarHeight,
      navBarHeight,
      totalNavHeight,
      capWidth: capW,
      windowHeight: sysInfo.windowHeight,
      bottomSafeInset: Math.max(
        sysInfo.windowHeight - ((sysInfo.safeArea && sysInfo.safeArea.bottom) || sysInfo.windowHeight),
        0
      )
    };

    this._chatThreads = [];
    this._compactContext = null;
    this._sessionSummary = "";
    this._decisionSessionIdCache = "";

    this.applyHistoryDrawerLayout(
      false,
      {
        canBack: getCurrentPages().length > 1 || Boolean(fallbackTabRoute),
        fallback_tab_route: fallbackTabRoute,
        source,
        messages: []
      },
      () => {
        this.restoreChatThreads();
        this.scrollToBottom();
      }
    );
  },

  onShow() {
    if (this._navRevealTimer) {
      clearTimeout(this._navRevealTimer);
      this._navRevealTimer = null;
    }

    if (this.data.showNavBar) {
      this.setData({ showNavBar: false });
    }

    this._navRevealTimer = setTimeout(() => {
      this.setData({ showNavBar: true });
      this._navRevealTimer = null;
    }, NAV_REVEAL_DELAY_MS);

    trackEvent(EVENTS.PAGE_AI_VIEW, {
      source: this.data.source || "home"
    });

    this.refreshDecisionSeedState();
  },

  onHide() {
    this.upsertCurrentThread({ touchUpdatedAt: false });
    if (this._navRevealTimer) {
      clearTimeout(this._navRevealTimer);
      this._navRevealTimer = null;
    }
  },

  onUnload() {
    this.upsertCurrentThread({ touchUpdatedAt: false });
    if (this._navRevealTimer) {
      clearTimeout(this._navRevealTimer);
      this._navRevealTimer = null;
    }
  },

  buildThreadItems() {
    const activeSessionId = normalizeText(this._aiSessionId);
    const list = Array.isArray(this._chatThreads) ? this._chatThreads : [];
    return list.map((thread) => {
      const title = normalizeText(thread.title);
      const preview = normalizeText(thread.preview);
      return {
        session_id: thread.session_id,
        active: thread.session_id === activeSessionId,
        time_text: formatThreadTime(thread.updated_at || thread.created_at),
        desc_text: title || preview || "New Chat",
        preview_text: preview
      };
    });
  },

  persistChatThreads() {
    const normalized = (Array.isArray(this._chatThreads) ? this._chatThreads : [])
      .map((thread) => sanitizeThread(thread))
      .filter(Boolean)
      .sort(byUpdatedDesc)
      .slice(0, MAX_CHAT_THREADS);

    this._chatThreads = normalized;

    // 通过 chatRepo 持久化所有线程
    normalized.forEach((thread) => {
      if (thread && thread.session_id) {
        chatRepo.upsertThread(thread.session_id, thread);
      }
    });

    // 设置活跃会话 ID
    if (this._aiSessionId) {
      chatRepo.setActiveSessionId(this._aiSessionId);
    }

    const threadItems = this.buildThreadItems();
    this.applyHistoryDrawerLayout(threadItems.length > 1, {
      chat_threads: threadItems,
      has_chat_threads: threadItems.length > 0,
      active_session_id: normalizeText(this._aiSessionId)
    });
  },

  resetDecisionView() {
    this._decisionSessionIdCache = "";
    this.setData({
      decision_loading: false,
      decision_session_id: "",
      decision_stage_text: "",
      decision_seed_text: "",
      decision_seed_ready: false,
      decision_blocker_text: "",
      decision_bucket_cards: [],
      has_decision_buckets: false,
      pairwise_question: null,
      has_pairwise_question: false,
      decision_show_critique_editor: false,
      decision_show_relaxation: false,
      critique_input: "",
      relaxation_options: [],
      has_relaxation_options: false
    });
  },

  applyDecisionData(data = {}) {
    const sessionId = normalizeText(data.decision_session_id);
    this._decisionSessionIdCache = sessionId;
    const currentStage = normalizeText(data.current_stage);
    const bucketCards = buildDecisionBucketCards(data.candidate_buckets);
    const pairwiseQuestion =
      data.next_pairwise_question && typeof data.next_pairwise_question === "object"
        ? {
            prompt: normalizeText(data.next_pairwise_question.prompt, "这两套房里，你现在更倾向哪一套？"),
            left: data.next_pairwise_question.left || null,
            right: data.next_pairwise_question.right || null
          }
        : null;
    const relaxationOptions = Array.isArray(data.relaxation_options) ? data.relaxation_options : [];
    const blockerText = summarizeDecisionBlockers(data.blockers);
    const showPairwise = currentStage === "pairwise" && Boolean(pairwiseQuestion && pairwiseQuestion.left && pairwiseQuestion.right);
    const showRelaxation = currentStage === "relaxation" && relaxationOptions.length > 0;
    const showBlockerText = currentStage === "relaxation" || currentStage === "clarifying";

    this.setData({
      decision_session_id: sessionId,
      decision_stage_text: normalizeText(DECISION_STAGE_TEXT_MAP[currentStage], currentStage || "结构化决策"),
      decision_blocker_text: showBlockerText ? blockerText : "",
      decision_bucket_cards: bucketCards,
      has_decision_buckets: bucketCards.length > 0,
      pairwise_question: showPairwise ? pairwiseQuestion : null,
      has_pairwise_question: showPairwise,
      decision_show_critique_editor: false,
      decision_show_relaxation: false,
      relaxation_options: relaxationOptions,
      has_relaxation_options: showRelaxation
    });
  },

  refreshDecisionSeedState(userId = "") {
    const seed = this.getDecisionSeed(normalizeText(userId, this.getCurrentUserId()));
    this.setData({
      decision_seed_text: seed.label,
      decision_seed_ready: seed.ids.length >= 2
    });
    return seed;
  },

  getDecisionSeed(userId) {
    const compareIds = sanitizeStringArray(listingRepo.getCompareIds(), 5);
    if (compareIds.length >= 2) {
      return {
        ids: compareIds,
        label: `已选房源 ${compareIds.length} 套`
      };
    }

    const favoriteIds = sanitizeStringArray(listingRepo.getFavoriteIds(), 5);
    if (favoriteIds.length >= 2) {
      return {
        ids: favoriteIds,
        label: `收藏房源 ${favoriteIds.length} 套`
      };
    }

    const listings = getActiveListings(userId)
      .map((item) => normalizeText(item && item.listing_id))
      .filter(Boolean)
      .slice(0, 5);

    if (listings.length >= 2) {
      return {
        ids: listings,
        label: `活跃房源 ${listings.length} 套`
      };
    }

    return {
      ids: [],
      label: "请先收藏或加入至少 2 套房源"
    };
  },

  buildDecisionContext(userId, selectedListingIds = []) {
    const intake = getLatestSubmittedIntake(userId);
    const memoryProfile = get(STORAGE_KEYS.AI_MEMORY_PROFILE, {});
    const activeRequirement = get(STORAGE_KEYS.AI_ACTIVE_REQUIREMENT, {});
    const context = {
      selected_listing_ids: sanitizeStringArray(selectedListingIds, 5),
      use_historical_constraints: false
    };

    if (intake) {
      context.active_intake = {
        intake_id: intake.intake_id,
        city: normalizeText(intake.city),
        budget_min: toNumber(intake.budget_min),
        budget_max: toNumber(intake.budget_max),
        area_min: toNumber(intake.area_min),
        layout_pref: normalizeText(intake.layout_pref)
      };
    }

    if (isPlainObject(memoryProfile) && Object.keys(memoryProfile).length) {
      context.memory_profile = memoryProfile;
    }

    if (isPlainObject(activeRequirement) && Object.keys(activeRequirement).length) {
      context.active_requirement = activeRequirement;
    }

    return context;
  },

  async loadDecisionStateForCurrentThread() {
    const thread = this.getCurrentThread();
    const userId = this.getCurrentUserId();
    const decisionSessionId = normalizeText(
      (thread && thread.decision_session_id) || this.data.decision_session_id
    );

    if (!decisionSessionId) {
      this.resetDecisionView();
      this.refreshDecisionSeedState(userId);
      return;
    }

    this.setData({ decision_loading: true });

    try {
      const result = await getDecisionState({
        decisionSessionId,
        userId,
        localListings: buildDecisionLocalListings(userId)
      });

      if (!result || !result.success) {
        this.resetDecisionView();
        this.refreshDecisionSeedState(userId);
        return;
      }

      this.applyDecisionData(result.data || {});
      this.upsertCurrentThread({ touchUpdatedAt: false });
    } catch (err) {
      this.resetDecisionView();
      this.refreshDecisionSeedState(userId);
    } finally {
      this.setData({ decision_loading: false });
    }
  },

  getCurrentUserId() {
    const session = getSession();
    return normalizeText(session && (session.user_id || session.login_code));
  },

  getCurrentThread() {
    const sessionId = normalizeText(this._aiSessionId);
    if (!sessionId) {
      return null;
    }
    return (this._chatThreads || []).find((item) => item && item.session_id === sessionId) || null;
  },

  syncCurrentThreadRecord(threadOverride = null) {
    const userId = this.getCurrentUserId();
    if (!userId) {
      return;
    }

    const thread = sanitizeThread(threadOverride || this.getCurrentThread());
    if (!thread) {
      return;
    }

    syncChatSession({
      session_id: thread.session_id,
      user_id: userId,
      source: thread.source || this.data.source || "home",
      title: thread.title,
      summary: normalizeText(thread.summary),
      preview: thread.preview,
      status: "active",
      message_count: Array.isArray(thread.messages) ? thread.messages.length : 0,
      recent_message_ids: (thread.messages || []).slice(-RECENT_MESSAGE_LIMIT).map((item) => item.id),
      last_message_at: thread.updated_at || thread.created_at,
      created_at: thread.created_at,
      updated_at: thread.updated_at
    }).catch((err) => {
      console.warn("[cloud] chat_session sync failed", err);
    });
  },

  syncMessageRecord(message, { rawModelOutput = "" } = {}) {
    const userId = this.getCurrentUserId();
    const sessionId = normalizeText(this._aiSessionId);
    const normalizedMessage = sanitizeMessage(message);

    if (!userId || !sessionId || !normalizedMessage) {
      return;
    }

    syncChatMessage({
      message_id: normalizedMessage.id,
      session_id: sessionId,
      user_id: userId,
      role: normalizedMessage.role,
      content: normalizedMessage.text,
      raw_model_output: normalizeText(rawModelOutput),
      created_at: normalizedMessage.created_at
    }).catch((err) => {
      console.warn("[cloud] chat_message sync failed", err);
    });
  },

  syncStructuredMemory(profileState, requirementState) {
    const userId = this.getCurrentUserId();
    if (!userId) {
      return;
    }

    const safeProfile = isPlainObject(profileState) ? profileState : {};
    const safeRequirement = isPlainObject(requirementState) ? requirementState : {};
    const now = nowISOTime();

    syncUserProfile({
      profile_id: `profile_${userId}`,
      user_id: userId,
      city_default: normalizeText(safeProfile.city),
      notes: normalizeText(safeRequirement.notes),
      ai_memory_profile_json: safeProfile,
      updated_at: now
    }).catch((err) => {
      console.warn("[cloud] user_profile sync failed", err);
    });

    const allIntakes = get(STORAGE_KEYS.BUYER_INTAKES, []);
    const latestIntake = getLatestSubmittedIntake(userId);

    if (latestIntake) {
      const structured = isPlainObject(latestIntake.structured_json)
        ? { ...latestIntake.structured_json }
        : {};
      const nextIntake = {
        ...latestIntake,
        city: normalizeText(safeProfile.city, latestIntake.city || ""),
        budget_min:
          safeProfile.budget_min != null ? safeProfile.budget_min : latestIntake.budget_min,
        budget_max:
          safeProfile.budget_max != null ? safeProfile.budget_max : latestIntake.budget_max,
        layout_pref: normalizeText(safeProfile.preferred_layout, latestIntake.layout_pref || ""),
        region_pref:
          Array.isArray(safeRequirement.target_area) && safeRequirement.target_area.length
            ? safeRequirement.target_area
            : latestIntake.region_pref,
        structured_json: {
          ...structured,
          ai_memory_profile: safeProfile,
          ai_requirement_memory: safeRequirement
        },
        updated_at: now
      };

      const nextIntakes = (Array.isArray(allIntakes) ? allIntakes : []).map((item) =>
        item && item.intake_id === nextIntake.intake_id ? nextIntake : item
      );
      set(STORAGE_KEYS.BUYER_INTAKES, nextIntakes);

      syncBuyerIntake(nextIntake).catch((err) => {
        console.warn("[cloud] buyer_intake memory sync failed", err);
      });
      return;
    }

    const draft = get(STORAGE_KEYS.DRAFT_INTAKE, {});
    set(STORAGE_KEYS.DRAFT_INTAKE, {
      ...draft,
      city: normalizeText(safeProfile.city, draft.city || ""),
      budget_min:
        safeProfile.budget_min != null
          ? String(safeProfile.budget_min)
          : normalizeText(draft.budget_min),
      budget_max:
        safeProfile.budget_max != null
          ? String(safeProfile.budget_max)
          : normalizeText(draft.budget_max),
      usage_type: normalizeText(draft.usage_type),
      max_concern: normalizeText(draft.max_concern),
      ai_memory_profile: safeProfile,
      ai_requirement_memory: safeRequirement
    });
  },

  applyValidatedMemoryPatch(memoryPatch, rejectedFields = []) {
    const patch = isPlainObject(memoryPatch) ? memoryPatch : {};
    const { profilePatch, requirementPatch } = splitMemoryPatch(patch);
    const hasProfilePatch = Object.keys(profilePatch).length > 0;
    const hasRequirementPatch = Object.keys(requirementPatch).length > 0;

    const currentProfile = get(STORAGE_KEYS.AI_MEMORY_PROFILE, {});
    const currentRequirement = get(STORAGE_KEYS.AI_ACTIVE_REQUIREMENT, {});
    const nextProfile = hasProfilePatch
      ? mergePatchObject(currentProfile, profilePatch, PROFILE_ARRAY_FIELDS)
      : currentProfile;
    const nextRequirement = hasRequirementPatch
      ? mergePatchObject(currentRequirement, requirementPatch, REQUIREMENT_ARRAY_FIELDS)
      : currentRequirement;

    if (hasProfilePatch) {
      nextProfile.updated_at = nowISOTime();
      set(STORAGE_KEYS.AI_MEMORY_PROFILE, nextProfile);
    }

    if (hasRequirementPatch) {
      nextRequirement.updated_at = nowISOTime();
      set(STORAGE_KEYS.AI_ACTIVE_REQUIREMENT, nextRequirement);
    }

    if (hasProfilePatch || hasRequirementPatch) {
      this.syncStructuredMemory(nextProfile, nextRequirement);
      writeActivityLog({
        actor_type: "system",
        actor_id: this.getCurrentUserId(),
        action_type: "ai_memory_patch_applied",
        object_type: "ai_memory",
        object_id: normalizeText(this._aiSessionId),
        detail_json: {
          fields: Object.keys(patch),
          profile_fields: Object.keys(profilePatch),
          requirement_fields: Object.keys(requirementPatch)
        }
      });
    }

    if (Array.isArray(rejectedFields) && rejectedFields.length) {
      writeActivityLog({
        actor_type: "system",
        actor_id: this.getCurrentUserId(),
        action_type: "ai_memory_patch_rejected",
        object_type: "ai_memory",
        object_id: normalizeText(this._aiSessionId),
        detail_json: {
          rejected_fields: rejectedFields
        }
      });
    }
  },

  upsertCurrentThread({ touchUpdatedAt = true } = {}) {
    const sessionId = normalizeText(this._aiSessionId);
    if (!sessionId) {
      return;
    }

    const messages = (this.data.messages || [])
      .map((item) => sanitizeMessage(item))
      .filter(Boolean)
      .slice(-MAX_MESSAGES_PER_THREAD);
    const normalizedMessages = messages.length ? messages : createDefaultMessages();
    const now = nowISOTime();

    const list = Array.isArray(this._chatThreads) ? this._chatThreads.slice() : [];
    const index = list.findIndex((item) => normalizeText(item && item.session_id) === sessionId);
    const existing = index >= 0 ? sanitizeThread(list[index]) : null;
    const base = existing || createThread({ sessionId, source: this.data.source || "home" });

    const next = {
      ...base,
      session_id: sessionId,
      source: normalizeText(this.data.source, base.source || "home"),
      decision_session_id: normalizeText(
        this._decisionSessionIdCache || this.data.decision_session_id,
        base.decision_session_id || ""
      ),
      title: buildThreadTitle(normalizedMessages),
      preview: buildThreadPreview(normalizedMessages),
      summary: normalizeText(this._sessionSummary, base.summary || ""),
      compact_context: sanitizeCompactContext(this._compactContext),
      messages: normalizedMessages,
      created_at: normalizeText(base.created_at, now),
      updated_at: touchUpdatedAt ? now : normalizeText(base.updated_at, now)
    };

    if (index >= 0) {
      list.splice(index, 1, next);
    } else {
      list.unshift(next);
    }

    this._chatThreads = list;
    this.persistChatThreads();
    this.syncCurrentThreadRecord(next);
  },

  restoreChatThreads() {
    // 通过 chatRepo 获取所有线程
    const storedThreadsResult = chatRepo.getThreads();
    const storedThreads =
      storedThreadsResult && storedThreadsResult.status === "success"
        ? storedThreadsResult.data
        : [];
    const normalizedThreads = (Array.isArray(storedThreads) ? storedThreads : [])
      .map((item) => sanitizeThread(item))
      .filter(Boolean)
      .sort(byUpdatedDesc)
      .slice(0, MAX_CHAT_THREADS);

    // 获取活跃会话 ID
    const activeSessionId = normalizeText(chatRepo.getActiveSessionId() || "");
    const currentSource = this.data.source || "home";

    let activeThread = normalizedThreads.find((item) => item.session_id === activeSessionId);
    if (!activeThread) {
      activeThread =
        normalizedThreads.find((item) => normalizeText(item.source) === currentSource) ||
        normalizedThreads[0] ||
        null;
    }

    if (!activeThread) {
      activeThread = createThread({
        sessionId: createSessionId(),
        source: currentSource
      });
      normalizedThreads.unshift(activeThread);
    }

    this._chatThreads = normalizedThreads;
    this._aiSessionId = activeThread.session_id;
    this._compactContext = sanitizeCompactContext(activeThread.compact_context);
    this._sessionSummary = normalizeText(activeThread.summary);

    // 通过 chatRepo 获取当前线程的消息
    const threadMessagesResult = chatRepo.getThreadMessages(this._aiSessionId);
    const threadMessages =
      threadMessagesResult && threadMessagesResult.status === "success"
        ? threadMessagesResult.data
        : [];
    const messages = threadMessages.length > 0 ? threadMessages : createDefaultMessages();

    this.setData(
      {
        messages: messages,
        decision_session_id: normalizeText(activeThread.decision_session_id)
      },
      () => {
        this.refreshDecisionSeedState(this.getCurrentUserId());
        this.scrollToBottom();
        this.loadDecisionStateForCurrentThread();
      }
    );

    this.persistChatThreads();
  },

  handleSwitchThread(e) {
    const sessionId = normalizeText(e.currentTarget.dataset.sessionId);
    if (!sessionId) {
      return;
    }
    if (sessionId === normalizeText(this._aiSessionId)) {
      this.setData({
        offset: -this.data.drawerHeight,
        drawerState: "closed"
      });
      return;
    }

    const target = (this._chatThreads || []).find((item) => item && item.session_id === sessionId);
    if (!target) {
      return;
    }

    this._aiSessionId = target.session_id;
    this._compactContext = sanitizeCompactContext(target.compact_context);
    this._sessionSummary = normalizeText(target.summary);

    this.setData(
      {
        messages: Array.isArray(target.messages) ? target.messages : createDefaultMessages(),
        decision_session_id: normalizeText(target.decision_session_id),
        showMorePanel: false,
        showFavoritePicker: false,
        offset: -this.data.drawerHeight,
        drawerState: "closed"
      },
      () => {
        this.refreshDecisionSeedState(this.getCurrentUserId());
        this.scrollToBottom();
        this.upsertCurrentThread({ touchUpdatedAt: false });
        this.loadDecisionStateForCurrentThread();
      }
    );
  },

  scrollToBottom() {
    const messages = this.data.messages || [];
    if (!messages.length) {
      return;
    }
    this.setData({
      scrollTo: messages[messages.length - 1].id
    });
  },

  appendMessage(role, text, options = {}) {
    const message = createMessage(role, text);
    const messages = (this.data.messages || []).concat(message);
    
    // 通过 chatRepo 保存消息
    if (this._aiSessionId) {
      chatRepo.appendMessage(this._aiSessionId, message);
    }
    
    this.setData({ messages }, () => {
      this.scrollToBottom();
      this.upsertCurrentThread();
    });
    this.syncMessageRecord(message, options);
    return message;
  },

  buildAIContext(userId, contextPatch = {}) {
    const intake = getLatestSubmittedIntake(userId);
    const selectedIds = listingRepo.getCompareIds();
    const selectedCount = Array.isArray(selectedIds) ? selectedIds.length : 0;
    const listingCount = getActiveListingCount(userId);
    const currentThread = this.getCurrentThread();
    const sessionSummary = normalizeText(this._sessionSummary || (currentThread && currentThread.summary));
    const recentMessages = buildRecentMessages(currentThread && currentThread.messages, RECENT_MESSAGE_LIMIT);
    const memoryProfile = get(STORAGE_KEYS.AI_MEMORY_PROFILE, {});
    const activeRequirement = get(STORAGE_KEYS.AI_ACTIVE_REQUIREMENT, {});

    const context = {
      source_page: this.data.source || "home",
      selected_listing_ids: selectedIds,
      selected_count: selectedCount,
      imported_listing_count: listingCount
    };

    if (intake) {
      context.previous_understanding = {
        intake_id: intake.intake_id,
        city: normalizeText(intake.city),
        budget_min: toNumber(intake.budget_min),
        budget_max: toNumber(intake.budget_max),
        usage_type: normalizeText(intake.usage_type),
        max_concern: normalizeText(intake.max_concern)
      };
    }

    if (sessionSummary) {
      context.session_summary = sessionSummary;
    }

    if (recentMessages.length) {
      context.recent_messages = recentMessages;
    }

    if (isPlainObject(memoryProfile) && Object.keys(memoryProfile).length) {
      context.memory_profile = memoryProfile;
    }

    if (isPlainObject(activeRequirement) && Object.keys(activeRequirement).length) {
      context.active_requirement = activeRequirement;
    }

    const compactContext = sanitizeCompactContext(this._compactContext);
    if (compactContext) {
      context.compact_context = compactContext;
    }

    if (contextPatch && typeof contextPatch === "object" && !Array.isArray(contextPatch)) {
      return {
        ...context,
        ...contextPatch
      };
    }

    return context;
  },

  async submitAIQuery({ query, contextPatch = {}, submitType = "manual_input", clearInput = true }) {
    if (this.data.sending) {
      return;
    }

    const normalizedQuery = normalizeText(query);
    if (!normalizedQuery) {
      wx.showToast({
        title: "请输入需求描述",
        icon: "none"
      });
      return;
    }

    if (normalizedQuery.length > MAX_QUERY_LENGTH) {
      wx.showToast({
        title: `最多输入${MAX_QUERY_LENGTH}字`,
        icon: "none"
      });
      return;
    }

    const session = getSession();
    const userId = normalizeText(session && (session.user_id || session.login_code));
    const sessionId = normalizeText(this._aiSessionId, createSessionId());
    this._aiSessionId = sessionId;
    const requestContext = this.buildAIContext(userId, contextPatch);
    const existingMessages = this.data.messages || [];

    if (
      existingMessages.length === 1 &&
      existingMessages[0] &&
      existingMessages[0].role === "ai"
    ) {
      this.syncMessageRecord(existingMessages[0]);
    }

    this.appendMessage("user", normalizedQuery);
    this.setData({
      sending: true,
      showMorePanel: false,
      ...(clearInput ? { chatInput: "" } : {})
    });

    writeActivityLog({
      actor_type: "user",
      actor_id: userId,
      action_type: "ai_recommend_submit",
      object_type: "ai_query",
      detail_json: {
        scene: AI_SCENES.PROPERTY_CONSULT,
        submit_type: submitType,
        source: this.data.source || "home",
        query_length: normalizedQuery.length
      }
    });

    try {
      const result = await requestAIConversation({
        query: normalizedQuery,
        userId,
        sessionId,
        source: "wechat",
        context: requestContext
      });

      if (!result || typeof result !== "object") {
        this.appendMessage("ai", "AI 服务返回格式异常，请稍后重试。");
        return;
      }

      if (!result.success) {
        this.appendMessage("ai", formatErrorResponse(result.error));
        writeActivityLog({
          actor_type: "system",
          actor_id: userId,
          action_type: "ai_recommend_fail",
          object_type: "ai_query",
          detail_json: {
            scene: AI_SCENES.PROPERTY_CONSULT,
            submit_type: submitType,
            error_code: normalizeText(result.error && result.error.code),
            error_message: normalizeText(result.error && result.error.message)
          }
        });
        return;
      }

      if (result.type === "clarification_needed") {
        this.appendMessage("ai", formatClarificationResponse(result.data), {
          rawModelOutput: JSON.stringify(result.data || {})
        });
      } else {
        this.appendMessage("ai", formatRecommendationResponse(result.data), {
          rawModelOutput: JSON.stringify(result.data || {})
        });
      }

      const compactContext = extractCompactContext(result);
      if (compactContext) {
        this._compactContext = compactContext;
      }

      const sessionSummary = extractSessionSummary(result);
      if (sessionSummary) {
        this._sessionSummary = sessionSummary;
      }

      const memoryPatch = extractValidatedMemoryPatch(result);
      const rejectedFields = extractMemoryPatchRejected(result);
      this.applyValidatedMemoryPatch(memoryPatch, rejectedFields);
      this.upsertCurrentThread({ touchUpdatedAt: false });

      writeActivityLog({
        actor_type: "system",
        actor_id: userId,
        action_type: "ai_recommend_success",
        object_type: "ai_query",
        detail_json: {
          scene: AI_SCENES.PROPERTY_CONSULT,
          submit_type: submitType,
          response_type: normalizeText(result.type),
          trace_id: normalizeText(result.meta && result.meta.trace_id)
        }
      });
    } catch (err) {
      this.appendMessage("ai", "AI 服务请求失败，请稍后重试。");
      writeActivityLog({
        actor_type: "system",
        actor_id: userId,
        action_type: "ai_recommend_exception",
        object_type: "ai_query",
        detail_json: {
          scene: AI_SCENES.PROPERTY_CONSULT,
          submit_type: submitType,
          error_message: normalizeText(err && (err.message || err.errMsg))
        }
      });
    } finally {
      this.setData({ sending: false });
    }
  },

  handleSend() {
    this.submitAIQuery({
      query: this.data.chatInput,
      submitType: "manual_input",
      clearInput: true
    });
  },

  async handleStartDecision() {
    if (this.data.decision_loading) {
      return;
    }

    const userId = this.getCurrentUserId();
    if (!userId) {
      wx.showToast({
        title: "登录后可使用结构化决策",
        icon: "none"
      });
      return;
    }

    const seed = this.refreshDecisionSeedState(userId);

    const seedReady = seed.ids.length >= 2;
    this.setData({
      decision_seed_ready: seedReady
    });

    if (!seedReady) {
      wx.showToast({
        title: seed.label,
        icon: "none"
      });
      return;
    }

    const chatSessionId = normalizeText(this._aiSessionId, createSessionId());
    this._aiSessionId = chatSessionId;
    this.setData({ decision_loading: true });

    try {
      const result = await startDecisionSession({
        userId,
        chatSessionId,
        selectedListingIds: seed.ids,
        context: this.buildDecisionContext(userId, seed.ids),
        localListings: buildDecisionLocalListings(userId, seed.ids)
      });

      if (!result || !result.success) {
        wx.showToast({
          title: getDecisionErrorText(result, "结构化决策启动失败"),
          icon: "none"
        });
        return;
      }

      this.applyDecisionData(result.data || {});
      this.setData({
        decision_seed_text: seed.label,
        decision_seed_ready: true
      });
      this.upsertCurrentThread({ touchUpdatedAt: false });

      trackEvent(EVENTS.AI_DECISION_START, {
        selected_count: seed.ids.length,
        source: this.data.source || "home"
      });
      writeActivityLog({
        actor_type: "user",
        actor_id: userId,
        action_type: "ai_decision_start",
        object_type: "page_ai",
        detail_json: {
          selected_listing_ids: seed.ids,
          source: this.data.source || "home"
        }
      });
    } catch (err) {
      wx.showToast({
        title: "结构化决策启动失败",
        icon: "none"
      });
    } finally {
      this.setData({ decision_loading: false });
    }
  },

  async handleSubmitPairwise(e) {
    if (this.data.decision_loading) {
      return;
    }

    const winnerListingId = normalizeText(e.currentTarget.dataset.winnerId);
    const loserListingId = normalizeText(e.currentTarget.dataset.loserId);
    const decisionSessionId = normalizeText(this.data.decision_session_id);
    const userId = this.getCurrentUserId();

    if (!winnerListingId || !loserListingId || !decisionSessionId) {
      return;
    }

    this.setData({ decision_loading: true });
    try {
      const result = await submitDecisionPairwise({
        decisionSessionId,
        winnerListingId,
        loserListingId,
        userId,
        localListings: buildDecisionLocalListings(userId)
      });

      if (!result || !result.success) {
        wx.showToast({
          title: getDecisionErrorText(result, "偏好更新失败"),
          icon: "none"
        });
        return;
      }

      this.applyDecisionData(result.data || {});
      this.upsertCurrentThread({ touchUpdatedAt: false });
      const nextPairwise = result.data && result.data.next_pairwise_question;
      const hasNextPairwise = Boolean(nextPairwise && nextPairwise.left && nextPairwise.right);
      wx.showToast({
        title: hasNextPairwise ? "已更新偏好" : "本轮偏好已完成",
        icon: "none"
      });
      trackEvent(EVENTS.AI_DECISION_PAIRWISE_SUBMIT, {
        winner_listing_id: winnerListingId,
        loser_listing_id: loserListingId
      });
    } catch (err) {
      wx.showToast({
        title: "偏好更新失败",
        icon: "none"
      });
    } finally {
      this.setData({ decision_loading: false });
    }
  },

  onDecisionCritiqueInput(e) {
    this.setData({
      critique_input: e.detail.value || ""
    });
  },

  handleToggleDecisionCritique() {
    const nextShow = !this.data.decision_show_critique_editor;
    this.setData({
      decision_show_critique_editor: nextShow,
      decision_show_relaxation: false,
      critique_input: nextShow ? this.data.critique_input : ""
    });
  },

  async handleSubmitCritique() {
    if (this.data.decision_loading) {
      return;
    }

    const decisionSessionId = normalizeText(this.data.decision_session_id);
    const critiqueText = normalizeText(this.data.critique_input);
    const userId = this.getCurrentUserId();

    if (!decisionSessionId || !critiqueText) {
      wx.showToast({
        title: "请输入你的修正意见",
        icon: "none"
      });
      return;
    }

    this.setData({ decision_loading: true });
    try {
      const result = await submitDecisionCritique({
        decisionSessionId,
        text: critiqueText,
        userId,
        localListings: buildDecisionLocalListings(userId)
      });

      if (!result || !result.success) {
        wx.showToast({
          title: getDecisionErrorText(result, "修正意见提交失败"),
          icon: "none"
        });
        return;
      }

      this.applyDecisionData(result.data || {});
      this.setData({
        critique_input: "",
        decision_show_critique_editor: false
      });
      this.upsertCurrentThread({ touchUpdatedAt: false });
      trackEvent(EVENTS.AI_DECISION_CRITIQUE_SUBMIT, {
        text_length: critiqueText.length
      });
    } catch (err) {
      wx.showToast({
        title: "修正意见提交失败",
        icon: "none"
      });
    } finally {
      this.setData({ decision_loading: false });
    }
  },

  async handleRefreshRelaxation() {
    if (this.data.has_relaxation_options) {
      this.setData({
        decision_show_relaxation: !this.data.decision_show_relaxation,
        decision_show_critique_editor: false
      });
      return;
    }

    if (this.data.decision_loading) {
      return;
    }

    const decisionSessionId = normalizeText(this.data.decision_session_id);
    const userId = this.getCurrentUserId();
    if (!decisionSessionId) {
      return;
    }

    this.setData({ decision_loading: true });
    try {
      const result = await getDecisionRelaxation({
        decisionSessionId,
        userId,
        localListings: buildDecisionLocalListings(userId)
      });
      if (!result || !result.success) {
        wx.showToast({
          title: getDecisionErrorText(result, "放宽建议刷新失败"),
          icon: "none"
        });
        return;
      }
      this.applyDecisionData(result.data || {});
      this.upsertCurrentThread({ touchUpdatedAt: false });
    } catch (err) {
      wx.showToast({
        title: "放宽建议刷新失败",
        icon: "none"
      });
    } finally {
      this.setData({ decision_loading: false });
    }
  },

  onInput(e) {
    this.setData({
      chatInput: e.detail.value || ""
    });
  },

  loadFavoriteOptions(userId) {
    const listings = getActiveListings(userId);

    const favoriteIdsRaw = listingRepo.getFavoriteIds();
    const favoriteIds = Array.isArray(favoriteIdsRaw)
      ? Array.from(new Set(favoriteIdsRaw.map((item) => normalizeText(item)).filter(Boolean)))
      : [];

    let candidates = [];
    if (favoriteIds.length) {
      candidates = favoriteIds
        .map((id) => listings.find((item) => normalizeText(item.listing_id) === id))
        .filter(Boolean);
    }

    if (!candidates.length) {
      candidates = listings.slice(0, 30);
    }

    return candidates.map((item) => ({
      listing_id: normalizeText(item.listing_id),
      title_text: normalizeText(item.title, "待完善房源"),
      desc_text: formatFavoriteDesc(item),
      selected: false,
      city: normalizeText(item.city),
      district: normalizeText(item.district),
      community_name: normalizeText(item.community_name),
      price_total: item.price_total == null ? null : item.price_total,
      area_sqm: item.area_sqm == null ? null : item.area_sqm,
      layout_desc: normalizeText(item.layout_desc),
      tags_json: Array.isArray(item.tags_json) ? item.tags_json : []
    }));
  },

  handleOpenFavoritePicker() {
    if (!isLoggedIn()) {
      wx.showToast({
        title: "登录后可选择收藏",
        icon: "none"
      });
      return;
    }

    const session = getSession();
    const userId = normalizeText(session && (session.user_id || session.login_code));
    const options = this.loadFavoriteOptions(userId);

    this.setData({
      showMorePanel: false,
      showFavoritePicker: true,
      favorite_options: options,
      has_favorite_options: options.length > 0,
      favorite_selected_count_text: "0",
      favorite_confirm_disabled: true,
      favorite_empty_text: "暂无可选收藏房源"
    });

    writeActivityLog({
      actor_type: "user",
      actor_id: userId,
      action_type: "ai_favorite_picker_open",
      object_type: "page_ai",
      detail_json: {
        candidate_count: options.length
      }
    });
  },

  handleToggleFavoriteItem(e) {
    const listingId = normalizeText(e.currentTarget.dataset.listingId);
    const options = (this.data.favorite_options || []).slice();
    const idx = options.findIndex((item) => item.listing_id === listingId);
    if (idx < 0) {
      return;
    }

    const currentSelectedCount = options.filter((item) => item.selected).length;
    if (!options[idx].selected && currentSelectedCount >= MAX_FAVORITE_PICK_COUNT) {
      wx.showToast({
        title: `最多选择${MAX_FAVORITE_PICK_COUNT}套`,
        icon: "none"
      });
      return;
    }

    options[idx] = {
      ...options[idx],
      selected: !options[idx].selected
    };

    const selectedCount = options.filter((item) => item.selected).length;

    this.setData({
      favorite_options: options,
      favorite_selected_count_text: String(selectedCount),
      favorite_confirm_disabled: selectedCount <= 0
    });
  },

  handleCancelFavoritePicker() {
    this.setData({
      showFavoritePicker: false
    });
  },

  async handleConfirmFavoritePicker() {
    if (this.data.favorite_confirm_disabled || this.data.sending) {
      return;
    }

    const options = this.data.favorite_options || [];
    const selected = options.filter((item) => item.selected);
    if (!selected.length) {
      wx.showToast({
        title: "请先选择收藏房源",
        icon: "none"
      });
      return;
    }

    const session = getSession();
    const userId = normalizeText(session && (session.user_id || session.login_code));

    writeActivityLog({
      actor_type: "user",
      actor_id: userId,
      action_type: "ai_favorite_confirm_send",
      object_type: "page_ai",
      detail_json: {
        selected_count: selected.length,
        selected_listing_ids: selected.map((item) => item.listing_id)
      }
    });

    this.setData({
      showFavoritePicker: false
    });

    const query = buildFavoriteAutoQuery(selected);
    const contextPatch = {
      favorite_listing_ids: selected.map((item) => item.listing_id),
      favorite_listings: selected.map((item) => ({
        listing_id: item.listing_id,
        title: item.title_text,
        city: item.city,
        district: item.district,
        community_name: item.community_name,
        price_total: item.price_total,
        area_sqm: item.area_sqm,
        layout_desc: item.layout_desc,
        tags_json: item.tags_json
      }))
    };

    await this.submitAIQuery({
      query,
      contextPatch,
      submitType: "favorite_picker",
      clearInput: false
    });
  },

  handleBack() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack();
    } else {
      wx.switchTab({ url: this.data.fallback_tab_route || "/pages/home/index" });
    }
  },

  toggleMorePanel() {
    this.setData({
      showMorePanel: !this.data.showMorePanel
    });
  },

  noop() {},

  onTouchStart(e) {
    if (!e.touches.length) return;
    this.startY = e.touches[0].clientY;
    this.startOffset = this.data.offset;
    this.setData({
      isDragging: true,
      dragDir: this.data.drawerState === "closed" ? "down" : "up"
    });
  },

  onTouchMove(e) {
    if (!e.touches.length) return;
    const currentY = e.touches[0].clientY;
    const deltaY = currentY - this.startY;
    let newOffset = this.startOffset + deltaY;
    const drawerHeight = this.data.drawerHeight;

    if (newOffset > 0) {
      newOffset = newOffset * 0.2;
    } else if (newOffset < -drawerHeight) {
      const overflow = -drawerHeight - newOffset;
      newOffset = -drawerHeight - overflow * 0.2;
    }

    let dir = "";
    if (deltaY > 5) {
      dir = "down";
    } else if (deltaY < -5) {
      dir = "up";
    }

    if (dir && dir !== this.data.dragDir) {
      this.setData({ dragDir: dir, offset: newOffset });
    } else {
      this.setData({ offset: newOffset });
    }
  },

  onTouchEnd(e) {
    if (!e.changedTouches.length) return;

    const currentY = e.changedTouches[0].clientY;
    const deltaY = currentY - this.startY;
    const drawerHeight = this.data.drawerHeight;

    let finalOffset = this.data.offset;
    let newState = this.data.drawerState;

    if (this.data.drawerState === "closed") {
      if (deltaY > 60) {
        finalOffset = 0;
        newState = "open";
      } else {
        finalOffset = -drawerHeight;
        newState = "closed";
      }
    } else if (deltaY < -60) {
      finalOffset = -drawerHeight;
      newState = "closed";
    } else {
      finalOffset = 0;
      newState = "open";
    }

    this.setData({
      isDragging: false,
      offset: finalOffset,
      drawerState: newState,
      dragDir: ""
    });
  },

  handleNewChat() {
    const sessionId = createSessionId();
    const source = this.data.source || "home";
    const newThread = createThread({ sessionId, source });

    this._aiSessionId = sessionId;
    this._compactContext = null;
    this._sessionSummary = "";
    this._chatThreads = [newThread].concat(
      (this._chatThreads || []).filter((item) => item && item.session_id !== sessionId)
    );

    this.setData(
      {
        messages: newThread.messages,
        decision_session_id: "",
        chatInput: "",
        showMorePanel: false,
        showFavoritePicker: false,
        offset: -this.data.drawerHeight,
        drawerState: "closed"
      },
      () => {
        this.resetDecisionView();
        this.refreshDecisionSeedState(this.getCurrentUserId());
        this.scrollToBottom();
        this.upsertCurrentThread();
        if (newThread.messages && newThread.messages[0]) {
          this.syncMessageRecord(newThread.messages[0]);
        }
      }
    );

    wx.showToast({
      title: "已开启新会话",
      icon: "none"
    });
  }
});
