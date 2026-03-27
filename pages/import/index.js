const { requireLogin, getSession } = require("../../utils/auth");
const { EVENTS, trackEvent, writeActivityLog } = require("../../utils/track");
const { STORAGE_KEYS, get, set, append, uid } = require("../../utils/storage");
const {
  syncListingImportJob,
  syncListing,
  uploadImportImage
} = require("../../utils/cloud");
const { intakeRepo } = require("../../repos");

function nowIso() {
  return new Date().toISOString();
}

function findCity(text) {
  const cities = ["北京", "上海", "广州", "深圳", "杭州", "南京", "苏州", "成都", "武汉", "重庆"];
  return cities.find((city) => String(text || "").includes(city)) || "";
}

function extractByRegex(text, regex) {
  const match = String(text || "").match(regex);
  if (!match || !match[1]) {
    return null;
  }
  const num = Number(match[1]);
  return Number.isNaN(num) ? null : num;
}

function extractLayout(text) {
  const match = String(text || "").match(/([1-9]室[0-9]厅)/);
  return match ? match[1] : "";
}

function extractCommunity(text) {
  const match = String(text || "").match(/([^\s，。；,;]{2,20}(小区|花园|公寓|家园|新城))/);
  return match ? match[1] : "";
}

function makeTitle(sourceType, sourceValue, sourceUrl) {
  if (sourceType === "url" && sourceUrl) {
    try {
      const host = new URL(sourceUrl).hostname;
      return `导入房源-${host}`;
    } catch (err) {
      return "导入房源-链接";
    }
  }
  const text = String(sourceValue || "").trim();
  if (!text) {
    return "待完善房源";
  }
  return text.slice(0, 18);
}

function buildListing({
  sourceType,
  sourceValue,
  sourceUrl,
  rawFileUrl,
  intake,
  userId,
  jobId
}) {
  const raw = String(sourceValue || "");
  const priceTotal = extractByRegex(raw, /(\d+(?:\.\d+)?)\s*(万|w)/i);
  const areaSqm = extractByRegex(raw, /(\d+(?:\.\d+)?)\s*(㎡|平米|m2)/i);
  const city = findCity(raw) || (intake && intake.city) || "";
  const layout = extractLayout(raw);
  const community = extractCommunity(raw);

  const missingFields = [];
  if (!priceTotal) missingFields.push("price_total");
  if (!areaSqm) missingFields.push("area_sqm");
  if (!community) missingFields.push("community_name");

  const now = nowIso();
  return {
    listing_id: uid("listing"),
    user_id: userId,
    job_id: jobId,
    source_platform: sourceType === "url" ? "url_import" : "manual_import",
    source_url: sourceType === "url" ? sourceUrl : "",
    cover_image_url:
      sourceType === "image"
        ? String(rawFileUrl || sourceValue || "").trim()
        : "",
    title: makeTitle(sourceType, sourceValue, sourceUrl),
    city,
    district: "",
    community_name: community,
    price_total: priceTotal,
    area_sqm: areaSqm,
    layout_desc: layout,
    raw_text: raw,
    normalized_json: {
      city,
      community_name: community,
      price_total: priceTotal,
      area_sqm: areaSqm,
      layout_desc: layout
    },
    confidence_json: {
      city: city ? 0.9 : 0.2,
      price_total: priceTotal ? 0.85 : 0.1,
      area_sqm: areaSqm ? 0.85 : 0.1,
      community_name: community ? 0.75 : 0.1
    },
    missing_fields_json: missingFields,
    status: "active",
    created_at: now,
    updated_at: now
  };
}

Page({
  data: {
    source_type: "url",
    source_url: "",
    source_text: "",
    image_path: "",
    btn_class_url: "btn-type btn-type-active",
    btn_class_text: "btn-type",
    btn_class_image: "btn-type",
    show_url_form: true,
    show_text_form: false,
    show_image_form: false,
    has_image_path: false
  },

  onLoad() {
    this.syncTypeViewState();
  },

  onShow() {
    trackEvent(EVENTS.PAGE_IMPORT_VIEW);
  },

  handleTypeChange(e) {
    this.setData(
      {
        source_type: e.currentTarget.dataset.type
      },
      () => this.syncTypeViewState()
    );
  },

  handleInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({
      [field]: e.detail.value
    });
  },

  handleChooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        this.setData(
          {
            image_path: file ? file.tempFilePath : ""
          },
          () => this.syncTypeViewState()
        );
      },
      fail: () => {
        wx.showToast({
          title: "选择图片失败",
          icon: "none"
        });
      }
    });
  },

  syncTypeViewState() {
    const sourceType = this.data.source_type;
    const isUrl = sourceType === "url";
    const isText = sourceType === "text";
    const isImage = sourceType === "image";
    this.setData({
      btn_class_url: isUrl ? "btn-type btn-type-active" : "btn-type",
      btn_class_text: isText ? "btn-type btn-type-active" : "btn-type",
      btn_class_image: isImage ? "btn-type btn-type-active" : "btn-type",
      show_url_form: isUrl,
      show_text_form: isText,
      show_image_form: isImage,
      has_image_path: Boolean(this.data.image_path)
    });
  },

  async handleImport() {
    trackEvent(EVENTS.IMPORT_SUBMIT, {
      source_type: this.data.source_type
    });

    if (!requireLogin("/pages/import/index")) {
      return;
    }

    const session = getSession();
    const jobId = uid("import_job");
    const createdAt = nowIso();
    const sourceValue = this.getSourceValue();
    let rawFileUrl = "";

    if (!sourceValue.ok) {
      const failedJob = {
        job_id: jobId,
        user_id: session.login_code,
        source_type: this.data.source_type,
        source_value: sourceValue.value,
        raw_file_url: "",
        status: "failed",
        error_message: sourceValue.error,
        created_at: createdAt,
        updated_at: createdAt
      };
      append(STORAGE_KEYS.LISTING_IMPORT_JOBS, failedJob);
      try {
        await syncListingImportJob(failedJob);
      } catch (err) {
        console.warn("[cloud] listing_import_job sync failed", err);
      }
      trackEvent(EVENTS.IMPORT_FAIL, {
        source_type: this.data.source_type,
        error_code: "VALIDATION_ERROR"
      });
      wx.showToast({
        title: sourceValue.error,
        icon: "none"
      });
      return;
    }

    if (this.data.source_type === "image") {
      try {
        rawFileUrl = await uploadImportImage({
          userId: session.login_code,
          tempFilePath: sourceValue.value
        });
      } catch (err) {
        console.warn("[cloud] import image upload failed", err);
        writeActivityLog({
          actor_type: "system",
          actor_id: session.login_code,
          action_type: "cloud_sync_failed",
          object_type: "listing_import_image",
          object_id: jobId,
          detail_json: {
            message: err && err.message ? err.message : "upload failed"
          }
        });
      }
    }

    if (String(sourceValue.value).toLowerCase().includes("fail")) {
      const failedJob = {
        job_id: jobId,
        user_id: session.login_code,
        source_type: this.data.source_type,
        source_value: sourceValue.value,
        raw_file_url: rawFileUrl,
        status: "failed",
        error_message: "导入内容解析失败，请重试或手动补充。",
        created_at: createdAt,
        updated_at: createdAt
      };
      append(STORAGE_KEYS.LISTING_IMPORT_JOBS, failedJob);
      try {
        await syncListingImportJob(failedJob);
      } catch (err) {
        console.warn("[cloud] listing_import_job sync failed", err);
      }
      trackEvent(EVENTS.IMPORT_FAIL, {
        source_type: this.data.source_type,
        error_code: "PARSE_FAILED"
      });
      wx.showToast({
        title: "导入失败，可重试",
        icon: "none"
      });
      return;
    }

    const intakeResult = intakeRepo.getIntakes({ userId: session.login_code, status: "submitted" });
    const intakesRaw = intakeResult && intakeResult.status === "success" ? intakeResult.data : [];
    const intakes = intakesRaw.slice().sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1));
    const latestIntake = intakes.length ? intakes[0] : null;

    const importJob = {
      job_id: jobId,
      user_id: session.login_code,
      source_type: this.data.source_type,
      source_value: sourceValue.value,
      raw_file_url: rawFileUrl,
      status: "success",
      error_message: "",
      created_at: createdAt,
      updated_at: createdAt
    };
    append(STORAGE_KEYS.LISTING_IMPORT_JOBS, importJob);

    const listing = buildListing({
      sourceType: this.data.source_type,
      sourceValue: sourceValue.value,
      sourceUrl: this.data.source_url,
      rawFileUrl,
      intake: latestIntake,
      userId: session.login_code,
      jobId
    });

    append(STORAGE_KEYS.LISTINGS, listing);

    try {
      await syncListingImportJob(importJob);
    } catch (err) {
      console.warn("[cloud] listing_import_job sync failed", err);
      writeActivityLog({
        actor_type: "system",
        actor_id: session.login_code,
        action_type: "cloud_sync_failed",
        object_type: "listing_import_job",
        object_id: importJob.job_id,
        detail_json: {
          collection: "listing_import_jobs",
          message: err && err.message ? err.message : "sync failed"
        }
      });
    }

    try {
      await syncListing(listing);
    } catch (err) {
      console.warn("[cloud] listing sync failed", err);
      writeActivityLog({
        actor_type: "system",
        actor_id: session.login_code,
        action_type: "cloud_sync_failed",
        object_type: "listing",
        object_id: listing.listing_id,
        detail_json: {
          collection: "listings",
          message: err && err.message ? err.message : "sync failed"
        }
      });
    }

    writeActivityLog({
      actor_type: "user",
      actor_id: session.login_code,
      action_type: "listing_import_success",
      object_type: "listing",
      object_id: listing.listing_id,
      detail_json: {
        source_type: this.data.source_type
      }
    });

    trackEvent(EVENTS.IMPORT_SUCCESS, {
      source_type: this.data.source_type,
      platform: listing.source_platform
    });

    wx.showToast({
      title: "导入成功",
      icon: "success"
    });

    setTimeout(() => {
      wx.navigateTo({
        url: "/pages/ai/index"
      });
    }, 250);
  },

  getSourceValue() {
    const { source_type, source_url, source_text, image_path } = this.data;

    if (source_type === "url") {
      if (!source_url || !/^https?:\/\//i.test(source_url)) {
        return { ok: false, error: "请输入有效链接", value: source_url };
      }
      return { ok: true, value: source_url };
    }

    if (source_type === "text") {
      if (!source_text || source_text.trim().length < 10) {
        return { ok: false, error: "文本内容过短", value: source_text };
      }
      return { ok: true, value: source_text.trim() };
    }

    if (!image_path) {
      return { ok: false, error: "请先上传截图", value: "" };
    }
    return { ok: true, value: image_path };
  }
});
