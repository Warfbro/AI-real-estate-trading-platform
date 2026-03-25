/**
 * 微信开发者工具控制台手工冒烟辅助脚本
 *
 * 用法（复制整段到开发者工具 Console 执行）：
 *   1) SMOKE_HELPER.seedBase();
 *   2) SMOKE_HELPER.switchRole("admin"); // 或 SMOKE_HELPER.toAdmin()
 *   3) SMOKE_HELPER.seedHighRisk(); // 一键造高风险上下文
 *   4) SMOKE_HELPER.runQuickDemo(); // 一键完成演示准备（推荐）
 *   2) SMOKE_HELPER.printSummary();
 *   3) 按《process/手工冒烟说明.txt》执行页面操作
 *   4) 操作后执行：
 *      - SMOKE_HELPER.verifyReportFail();
 *      - SMOKE_HELPER.verifyReportRetrySuccess();
 *      - SMOKE_HELPER.verifyHighRiskSeed();
 *      - SMOKE_HELPER.verifyManualReviewLead();
 *      - SMOKE_HELPER.verifyManualReviewNoteTrace();
 */

(function initSmokeHelper(global) {
  if (typeof wx === "undefined") {
    console.error("SMOKE_HELPER 初始化失败：当前环境无 wx 对象");
    return;
  }

  var KEY = {
    AUTH_SESSION: "auth_session",
    LAST_ROUTE: "last_route",
    RECENT_CONTINUE_ROUTE: "recent_continue_route",
    DRAFT_INTAKE: "draft_intake",
    DRAFT_IMPORT: "draft_import",
    COMPARE_LISTING_IDS: "compare_listing_ids",
    COMPARISON_REPORTS: "comparison_reports",
    RISK_CHECKS: "risk_checks",
    NEXT_ACTIONS: "next_actions",
    APPOINTMENTS: "appointments",
    ADVISOR_LEADS: "advisor_leads",
    BUYER_INTAKES: "buyer_intakes",
    LISTING_IMPORT_JOBS: "listing_import_jobs",
    LISTINGS: "listings",
    EVENT_LOGS: "event_logs",
    ACTIVITY_LOGS: "activity_logs"
  };
  var LOCAL_SEED_IMAGE_URL = "/img/image.png";

  function nowIso(offsetMs) {
    return new Date(Date.now() + (offsetMs || 0)).toISOString();
  }

  function set(key, value) {
    wx.setStorageSync(key, value);
  }

  function get(key, fallback) {
    var value = wx.getStorageSync(key);
    if (value === "" || value === undefined || value === null) {
      return fallback;
    }
    return value;
  }

  function clearAll() {
    Object.keys(KEY).forEach(function (k) {
      set(KEY[k], null);
    });
    console.info("[SMOKE_HELPER] cleared all known keys");
  }

  function ensureSession() {
    var current = get(KEY.AUTH_SESSION, null) || {};
    return {
      provider: current.provider || "wechat",
      login_code: current.login_code || "devtools_smoke_user_001",
      role: current.role || "user",
      logged_in_at: current.logged_in_at || nowIso(0)
    };
  }

  function switchRole(role) {
    var nextRole = String(role || "").trim();
    if (!nextRole) {
      console.error("[SMOKE_HELPER] switchRole failed: role is empty");
      return false;
    }
    if (["user", "advisor", "admin"].indexOf(nextRole) < 0) {
      console.error("[SMOKE_HELPER] switchRole failed: invalid role", nextRole);
      return false;
    }
    var session = ensureSession();
    session.role = nextRole;
    session.logged_in_at = nowIso(0);
    set(KEY.AUTH_SESSION, session);
    console.info("[SMOKE_HELPER] role switched", {
      login_code: session.login_code,
      role: session.role
    });
    return true;
  }

  function toAdmin() {
    return switchRole("admin");
  }

  function toUser() {
    return switchRole("user");
  }

  function buildBaseData() {
    var userId = "devtools_smoke_user_001";
    return {
      auth_session: {
        provider: "wechat",
        login_code: userId,
        role: "user",
        logged_in_at: nowIso(1)
      },
      buyer_intakes: [
        {
          intake_id: "intake_devtools_001",
          user_id: userId,
          raw_text: "预算500万以内，上海自住，通勤方便",
          city: "Shanghai",
          budget_min: 300,
          budget_max: 500,
          usage_type: "自住",
          status: "submitted",
          created_at: nowIso(2),
          updated_at: nowIso(2)
        }
      ],
      listings: [
        {
          listing_id: "listing_devtools_001",
          user_id: userId,
          title: "示例房源A",
          cover_image_url: LOCAL_SEED_IMAGE_URL,
          city: "Shanghai",
          community_name: "Demo Garden A",
          price_total: 420,
          area_sqm: 89,
          layout_desc: "2室1厅",
          missing_fields_json: [],
          status: "active",
          created_at: nowIso(3),
          updated_at: nowIso(3)
        },
        {
          listing_id: "listing_devtools_002",
          user_id: userId,
          title: "示例房源B",
          cover_image_url: LOCAL_SEED_IMAGE_URL,
          city: "Shanghai",
          community_name: "Demo Garden B",
          price_total: 560,
          area_sqm: 96,
          layout_desc: "3室1厅",
          missing_fields_json: ["elevator_flag"],
          status: "active",
          created_at: nowIso(4),
          updated_at: nowIso(4)
        }
      ],
      comparison_reports: [
        {
          comparison_id: "comparison_devtools_001",
          user_id: userId,
          intake_id: "intake_devtools_001",
          listing_ids_json: ["listing_devtools_001", "listing_devtools_002"],
          comparison_result_json: {
            top_pick: "listing_devtools_001"
          },
          report_text: "示例比较报告",
          status: "generated",
          created_at: nowIso(5),
          updated_at: nowIso(5)
        }
      ],
      risk_checks: [
        {
          risk_check_id: "risk_devtools_001",
          user_id: userId,
          intake_id: "intake_devtools_001",
          listing_ids_json: ["listing_devtools_001", "listing_devtools_002"],
          risk_level: "high",
          risk_tags_json: [
            {
              code: "RISK_COST_PRESSURE",
              title: "成本压力偏高",
              level: "high"
            }
          ],
          risk_rules_hit_json: {
            manual_review_required: true
          },
          risk_summary_text: "命中高风险，建议人工复核",
          manual_review_required: true,
          created_at: nowIso(6),
          updated_at: nowIso(6)
        }
      ],
      next_actions: [],
      appointments: [],
      advisor_leads: [],
      listing_import_jobs: [],
      event_logs: [],
      activity_logs: [],
      compare_listing_ids: ["listing_devtools_001", "listing_devtools_002"],
      recent_continue_route:
        "/pages/action/index?source=risk&intake_id=intake_devtools_001&comparison_id=comparison_devtools_001&risk_check_id=risk_devtools_001&listing_ids=listing_devtools_001%2Clisting_devtools_002&action_type=send_report"
    };
  }

  function seedBase() {
    clearAll();
    var data = buildBaseData();
    set(KEY.AUTH_SESSION, data.auth_session);
    set(KEY.BUYER_INTAKES, data.buyer_intakes);
    set(KEY.LISTINGS, data.listings);
    set(KEY.COMPARISON_REPORTS, data.comparison_reports);
    set(KEY.RISK_CHECKS, data.risk_checks);
    set(KEY.NEXT_ACTIONS, data.next_actions);
    set(KEY.APPOINTMENTS, data.appointments);
    set(KEY.ADVISOR_LEADS, data.advisor_leads);
    set(KEY.LISTING_IMPORT_JOBS, data.listing_import_jobs);
    set(KEY.EVENT_LOGS, data.event_logs);
    set(KEY.ACTIVITY_LOGS, data.activity_logs);
    set(KEY.COMPARE_LISTING_IDS, data.compare_listing_ids);
    set(KEY.RECENT_CONTINUE_ROUTE, data.recent_continue_route);
    set(KEY.LAST_ROUTE, "/pages/action/index");
    console.info("[SMOKE_HELPER] seed completed");
    printSummary();
  }

  function navigateSafe(url) {
    var targetUrl = String(url || "").trim();
    if (!targetUrl) {
      return {
        attempted: false,
        target_url: "",
        method: "",
        status: "skipped",
        reason_code: "empty_target_url",
        error_message: ""
      };
    }
    var result = {
      attempted: true,
      target_url: targetUrl,
      method: "navigateTo",
      status: "attempted",
      reason_code: "",
      error_message: ""
    };
    try {
      wx.navigateTo({
        url: targetUrl,
        fail: function (err) {
          result.method = "redirectTo";
          result.status = "fallback_redirect";
          result.reason_code = "navigate_to_failed";
          result.error_message = (err && err.errMsg) || "";
          wx.redirectTo({
            url: targetUrl,
            fail: function (redirectErr) {
              result.status = "failed";
              result.reason_code = "redirect_failed";
              result.error_message =
                (redirectErr && redirectErr.errMsg) ||
                result.error_message ||
                "navigate failed";
              console.warn("[SMOKE_HELPER] navigate failed", targetUrl);
            }
          });
        }
      });
    } catch (err) {
      result.status = "failed";
      result.reason_code = "navigate_exception";
      result.error_message = (err && err.message) || String(err || "");
      console.warn("[SMOKE_HELPER] navigate exception", targetUrl, result.error_message);
    }
    return result;
  }

  function seedHighRisk() {
    var session = ensureSession();
    var userId = session.login_code || "devtools_smoke_user_001";
    var token = String(Date.now());
    var intakeId = "intake_high_risk_" + token;
    var listingAId = "listing_high_risk_a_" + token;
    var listingBId = "listing_high_risk_b_" + token;
    var comparisonId = "comparison_high_risk_" + token;
    var riskCheckId = "risk_high_risk_" + token;

    var intakes = get(KEY.BUYER_INTAKES, []);
    var listings = get(KEY.LISTINGS, []);
    var comparisons = get(KEY.COMPARISON_REPORTS, []);
    var risks = get(KEY.RISK_CHECKS, []);
    var logs = get(KEY.ACTIVITY_LOGS, []);

    intakes.push({
      intake_id: intakeId,
      user_id: userId,
      raw_text: "预算300万内，通勤优先，接受旧小区但风险要可控",
      city: "Shanghai",
      budget_min: 180,
      budget_max: 300,
      usage_type: "自住",
      status: "submitted",
      created_at: nowIso(101),
      updated_at: nowIso(101)
    });

    listings.push({
      listing_id: listingAId,
      user_id: userId,
      title: "高风险样本A",
      cover_image_url: LOCAL_SEED_IMAGE_URL,
      city: "Shanghai",
      community_name: "Risk Garden A",
      price_total: 430,
      area_sqm: 88,
      layout_desc: "2室1厅",
      missing_fields_json: ["elevator_flag", "year_built"],
      status: "active",
      created_at: nowIso(102),
      updated_at: nowIso(102)
    });
    listings.push({
      listing_id: listingBId,
      user_id: userId,
      title: "高风险样本B",
      cover_image_url: LOCAL_SEED_IMAGE_URL,
      city: "Hangzhou",
      community_name: "Risk Garden B",
      price_total: 410,
      area_sqm: 86,
      layout_desc: "2室1厅",
      missing_fields_json: [],
      status: "active",
      created_at: nowIso(103),
      updated_at: nowIso(103)
    });

    comparisons.push({
      comparison_id: comparisonId,
      user_id: userId,
      intake_id: intakeId,
      listing_ids_json: [listingAId, listingBId],
      comparison_result_json: {
        top_pick: listingAId
      },
      report_text: "高风险测试比较报告",
      status: "generated",
      created_at: nowIso(104),
      updated_at: nowIso(104)
    });

    risks.push({
      risk_check_id: riskCheckId,
      user_id: userId,
      intake_id: intakeId,
      listing_ids_json: [listingAId, listingBId],
      risk_level: "high",
      risk_tags_json: [
        {
          code: "RISK_MISSING_INFO",
          title: "关键信息缺失",
          level: "high"
        },
        {
          code: "RISK_INFO_CONFLICT",
          title: "信息冲突待确认",
          level: "high"
        },
        {
          code: "RISK_COST_PRESSURE",
          title: "成本压力偏高",
          level: "high"
        },
        {
          code: "RISK_MANUAL_REVIEW",
          title: "建议人工复核",
          level: "high"
        }
      ],
      risk_rules_hit_json: {
        missing_info: true,
        info_conflict: true,
        cost_pressure: true,
        manual_review_required: true
      },
      risk_summary_text: "命中高风险规则，建议人工复核",
      manual_review_required: true,
      created_at: nowIso(105),
      updated_at: nowIso(105)
    });

    logs.push({
      log_id: "log_high_risk_seed_" + token,
      actor_type: "user",
      actor_id: userId,
      action_type: "risk_generate",
      object_type: "risk_check",
      object_id: riskCheckId,
      detail_json: {
        source: "smoke_helper_seed_high_risk",
        intake_id: intakeId,
        comparison_id: comparisonId
      },
      created_at: nowIso(106)
    });

    set(KEY.BUYER_INTAKES, intakes);
    set(KEY.LISTINGS, listings);
    set(KEY.COMPARISON_REPORTS, comparisons);
    set(KEY.RISK_CHECKS, risks);
    set(KEY.ACTIVITY_LOGS, logs);
    set(KEY.COMPARE_LISTING_IDS, [listingAId, listingBId]);
    set(
      KEY.RECENT_CONTINUE_ROUTE,
      "/pages/action/index?source=risk&intake_id=" +
        intakeId +
        "&comparison_id=" +
        comparisonId +
        "&risk_check_id=" +
        riskCheckId +
        "&listing_ids=" +
        encodeURIComponent(listingAId + "," + listingBId) +
        "&action_type=manual_review"
    );
    set(
      KEY.LAST_ROUTE,
      "/pages/risk/index?source=comparison&intake_id=" +
        intakeId +
        "&comparison_id=" +
        comparisonId +
        "&listing_ids=" +
        encodeURIComponent(listingAId + "," + listingBId)
    );

    console.info("[SMOKE_HELPER] high risk scenario seeded", {
      intake_id: intakeId,
      comparison_id: comparisonId,
      risk_check_id: riskCheckId,
      listing_ids: [listingAId, listingBId]
    });
    return {
      intake_id: intakeId,
      comparison_id: comparisonId,
      risk_check_id: riskCheckId,
      listing_ids: [listingAId, listingBId]
    };
  }

  function runQuickDemo(options) {
    var opts = options || {};
    var targetRole = String(opts.role || "admin").trim() || "admin";
    var targetUrl = String(opts.target_url || "/pages/adminLeads/index").trim() || "/pages/adminLeads/index";
    var shouldNavigate = opts.navigate !== false;
    var shouldVerify = opts.verify !== false;
    var beginAt = Date.now();
    var beginIso = new Date(beginAt).toISOString();
    var sessionBefore = ensureSession();
    var seeded = null;
    var switched = false;
    var verified = !shouldVerify;
    var summary = null;
    var navigateResult = {
      attempted: false,
      target_url: targetUrl,
      method: "",
      status: shouldNavigate ? "pending" : "skipped",
      reason_code: shouldNavigate ? "" : "navigate_disabled",
      error_message: ""
    };
    var stepResults = {
      seed_base: {
        ok: false,
        status: "pending"
      },
      seed_high_risk: {
        ok: false,
        status: "pending"
      },
      switch_role: {
        ok: false,
        status: "pending",
        target_role: targetRole
      },
      verify_high_risk: {
        ok: !shouldVerify,
        status: shouldVerify ? "pending" : "skipped",
        required: shouldVerify
      },
      print_summary: {
        ok: false,
        status: "pending"
      },
      navigate: {
        ok: !shouldNavigate,
        status: shouldNavigate ? "pending" : "skipped",
        required: shouldNavigate,
        target_url: targetUrl
      }
    };

    function finish(ok, reasonCode, errorMessage) {
      var endAt = Date.now();
      var sessionAfter = ensureSession();
      var result = {
        ok: Boolean(ok),
        reason_code: String(reasonCode || "unknown_error"),
        error_message: String(errorMessage || ""),
        switched: switched,
        verified: verified,
        role: targetRole,
        role_before: sessionBefore.role || "",
        role_after: sessionAfter.role || "",
        target_url: targetUrl,
        navigate_result: navigateResult,
        seeded: seeded,
        summary: summary,
        step_results: stepResults,
        started_at: beginIso,
        finished_at: new Date(endAt).toISOString(),
        duration_ms: endAt - beginAt
      };
      console.info("[SMOKE_HELPER] runQuickDemo", result);
      return result;
    }

    try {
      seedBase();
      stepResults.seed_base.ok = true;
      stepResults.seed_base.status = "done";
    } catch (err) {
      stepResults.seed_base.ok = false;
      stepResults.seed_base.status = "failed";
      stepResults.seed_base.error_message = (err && err.message) || String(err || "");
      return finish(false, "seed_base_failed", stepResults.seed_base.error_message);
    }

    try {
      seeded = seedHighRisk();
      stepResults.seed_high_risk.ok = Boolean(seeded && seeded.risk_check_id);
      stepResults.seed_high_risk.status = stepResults.seed_high_risk.ok ? "done" : "failed";
      if (!stepResults.seed_high_risk.ok) {
        stepResults.seed_high_risk.error_message = "seedHighRisk returned empty context";
        return finish(false, "seed_high_risk_failed", stepResults.seed_high_risk.error_message);
      }
    } catch (err) {
      stepResults.seed_high_risk.ok = false;
      stepResults.seed_high_risk.status = "failed";
      stepResults.seed_high_risk.error_message = (err && err.message) || String(err || "");
      return finish(false, "seed_high_risk_failed", stepResults.seed_high_risk.error_message);
    }

    switched = switchRole(targetRole);
    stepResults.switch_role.ok = Boolean(switched);
    stepResults.switch_role.status = switched ? "done" : "failed";
    if (!switched) {
      stepResults.switch_role.error_message = "switchRole returned false";
      return finish(false, "switch_role_failed", stepResults.switch_role.error_message);
    }

    if (shouldVerify) {
      verified = verifyHighRiskSeed();
      stepResults.verify_high_risk.ok = Boolean(verified);
      stepResults.verify_high_risk.status = verified ? "done" : "failed";
      if (!verified) {
        stepResults.verify_high_risk.error_message = "verifyHighRiskSeed returned false";
        return finish(false, "verify_high_risk_failed", stepResults.verify_high_risk.error_message);
      }
    }

    summary = printSummary();
    stepResults.print_summary.ok = Boolean(summary);
    stepResults.print_summary.status = summary ? "done" : "failed";

    if (shouldNavigate) {
      navigateResult = navigateSafe(targetUrl);
      stepResults.navigate.ok = navigateResult.status !== "failed";
      stepResults.navigate.status = navigateResult.status || "attempted";
      stepResults.navigate.method = navigateResult.method || "";
      stepResults.navigate.reason_code = navigateResult.reason_code || "";
      if (!stepResults.navigate.ok) {
        stepResults.navigate.error_message = navigateResult.error_message || "navigate failed";
        return finish(false, "navigate_failed", stepResults.navigate.error_message);
      }
    }

    return finish(true, "ok", "");
  }

  function printSummary() {
    var intakes = get(KEY.BUYER_INTAKES, []);
    var listings = get(KEY.LISTINGS, []);
    var reports = get(KEY.COMPARISON_REPORTS, []);
    var risks = get(KEY.RISK_CHECKS, []);
    var actions = get(KEY.NEXT_ACTIONS, []);
    var leads = get(KEY.ADVISOR_LEADS, []);
    var logs = get(KEY.ACTIVITY_LOGS, []);
    var summary = {
      buyer_intakes: intakes.length,
      listings: listings.length,
      comparison_reports: reports.length,
      risk_checks: risks.length,
      next_actions: actions.length,
      advisor_leads: leads.length,
      activity_logs: logs.length,
      continue_route: get(KEY.RECENT_CONTINUE_ROUTE, "")
    };
    console.info("[SMOKE_HELPER] summary", summary);
    return summary;
  }

  function getLatestByType(list, actionType) {
    var filtered = (list || []).filter(function (item) {
      return item && item.action_type === actionType;
    });
    if (!filtered.length) return null;
    filtered.sort(function (a, b) {
      return (a.updated_at || a.created_at || "") > (b.updated_at || b.created_at || "") ? -1 : 1;
    });
    return filtered[0];
  }

  function verifyReportFail() {
    var actions = get(KEY.NEXT_ACTIONS, []);
    var latest = getLatestByType(actions, "send_report");
    if (!latest) {
      console.error("[SMOKE_HELPER] verifyReportFail failed: no send_report action");
      return false;
    }
    var passed =
      latest.status === "failed" &&
      latest.result_json &&
      latest.result_json.error_code;
    if (!passed) {
      console.error("[SMOKE_HELPER] verifyReportFail failed", latest);
      return false;
    }
    console.info("[SMOKE_HELPER] verifyReportFail passed", {
      action_id: latest.action_id,
      status: latest.status,
      error_code: latest.result_json.error_code
    });
    return true;
  }

  function verifyHighRiskSeed() {
    var session = ensureSession();
    var userId = session.login_code || "";
    var risks = get(KEY.RISK_CHECKS, []).filter(function (item) {
      return item && item.user_id === userId;
    });
    if (!risks.length) {
      console.error("[SMOKE_HELPER] verifyHighRiskSeed failed: no risk_check for user");
      return false;
    }
    risks.sort(function (a, b) {
      return (a.updated_at || a.created_at || "") > (b.updated_at || b.created_at || "") ? -1 : 1;
    });
    var latest = risks[0];
    var pass =
      latest.risk_level === "high" &&
      Boolean(latest.manual_review_required) &&
      latest.risk_rules_hit_json &&
      Boolean(latest.risk_rules_hit_json.manual_review_required);
    if (!pass) {
      console.error("[SMOKE_HELPER] verifyHighRiskSeed failed", latest);
      return false;
    }
    console.info("[SMOKE_HELPER] verifyHighRiskSeed passed", {
      risk_check_id: latest.risk_check_id,
      risk_level: latest.risk_level,
      manual_review_required: latest.manual_review_required
    });
    return true;
  }

  function verifyReportRetrySuccess() {
    var actions = get(KEY.NEXT_ACTIONS, []);
    var sendReports = actions.filter(function (item) {
      return item.action_type === "send_report";
    });
    if (sendReports.length < 2) {
      console.error("[SMOKE_HELPER] verifyReportRetrySuccess failed: send_report actions < 2");
      return false;
    }
    sendReports.sort(function (a, b) {
      return (a.updated_at || a.created_at || "") > (b.updated_at || b.created_at || "") ? -1 : 1;
    });
    var latest = sendReports[0];
    var previous = sendReports[1];
    var report = get(KEY.COMPARISON_REPORTS, []).find(function (item) {
      return item.comparison_id === latest.comparison_id;
    });
    var logs = get(KEY.ACTIVITY_LOGS, []);
    var hasReportTrace = logs.some(function (log) {
      return (
        log.object_type === "comparison_report" &&
        log.object_id === latest.comparison_id &&
        (log.action_type === "report_send_failed" || log.action_type === "report_send_done")
      );
    });

    var passed =
      latest.status === "done" &&
      latest.payload_json &&
      Number(latest.payload_json.attempt_no || 0) >= 2 &&
      latest.payload_json.retry_of_action_id === previous.action_id &&
      report &&
      report.status === "sent" &&
      hasReportTrace;

    if (!passed) {
      console.error("[SMOKE_HELPER] verifyReportRetrySuccess failed", {
        latest: latest,
        previous: previous,
        report: report,
        hasReportTrace: hasReportTrace
      });
      return false;
    }

    console.info("[SMOKE_HELPER] verifyReportRetrySuccess passed", {
      action_id: latest.action_id,
      attempt_no: latest.payload_json.attempt_no,
      retry_of_action_id: latest.payload_json.retry_of_action_id,
      comparison_status: report.status
    });
    return true;
  }

  function verifyManualReviewLead() {
    var leads = get(KEY.ADVISOR_LEADS, []);
    var manualLeads = leads.filter(function (item) {
      return item.lead_type === "manual_review";
    });
    if (!manualLeads.length) {
      console.error("[SMOKE_HELPER] verifyManualReviewLead failed: no manual_review lead");
      return false;
    }
    manualLeads.sort(function (a, b) {
      return (a.updated_at || a.created_at || "") > (b.updated_at || b.created_at || "") ? -1 : 1;
    });
    var manualLead = manualLeads[0];
    if (!manualLead) {
      console.error("[SMOKE_HELPER] verifyManualReviewLead failed: no manual_review lead");
      return false;
    }
    var summary = manualLead.summary_json || {};
    var passed = Boolean(summary.source_page) && Boolean(summary.risk_level);
    if (!passed) {
      console.error("[SMOKE_HELPER] verifyManualReviewLead failed", manualLead);
      return false;
    }
    console.info("[SMOKE_HELPER] verifyManualReviewLead passed", {
      lead_id: manualLead.lead_id,
      source_page: summary.source_page,
      risk_level: summary.risk_level
    });
    return true;
  }

  function verifyManualReviewNoteTrace() {
    var leads = get(KEY.ADVISOR_LEADS, []);
    var manualLeads = leads.filter(function (item) {
      return item.lead_type === "manual_review";
    });
    if (!manualLeads.length) {
      console.error("[SMOKE_HELPER] verifyManualReviewNoteTrace failed: no manual_review lead");
      return false;
    }
    manualLeads.sort(function (a, b) {
      return (a.updated_at || a.created_at || "") > (b.updated_at || b.created_at || "") ? -1 : 1;
    });
    var latest = manualLeads[0];
    var summary = latest.summary_json || {};
    var note = String(summary.manual_review_note || "").trim();
    if (!note) {
      console.error("[SMOKE_HELPER] verifyManualReviewNoteTrace failed: manual_review_note empty", latest);
      return false;
    }

    var logs = get(KEY.ACTIVITY_LOGS, []);
    var hasNoteTrace = logs.some(function (item) {
      if (item.object_type !== "advisor_lead" || item.object_id !== latest.lead_id) {
        return false;
      }
      if (item.action_type === "manual_review_note_update") {
        return true;
      }
      if (item.action_type === "lead_status_update" && item.detail_json && item.detail_json.note_preview) {
        return true;
      }
      return false;
    });

    if (!hasNoteTrace) {
      console.error("[SMOKE_HELPER] verifyManualReviewNoteTrace failed: no note trace log", {
        lead_id: latest.lead_id
      });
      return false;
    }

    console.info("[SMOKE_HELPER] verifyManualReviewNoteTrace passed", {
      lead_id: latest.lead_id,
      note_preview: note.slice(0, 60),
      note_updated_at: summary.manual_review_note_updated_at || "-"
    });
    return true;
  }

  global.SMOKE_HELPER = {
    seedBase: seedBase,
    seedHighRisk: seedHighRisk,
    runQuickDemo: runQuickDemo,
    clearAll: clearAll,
    switchRole: switchRole,
    toAdmin: toAdmin,
    toUser: toUser,
    printSummary: printSummary,
    verifyReportFail: verifyReportFail,
    verifyReportRetrySuccess: verifyReportRetrySuccess,
    verifyHighRiskSeed: verifyHighRiskSeed,
    verifyManualReviewLead: verifyManualReviewLead,
    verifyManualReviewNoteTrace: verifyManualReviewNoteTrace
  };

  console.info("[SMOKE_HELPER] ready. Call SMOKE_HELPER.seedBase() to start.");
})(typeof globalThis !== "undefined" ? globalThis : this);
