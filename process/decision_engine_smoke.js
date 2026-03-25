const decisionEngine = require("../cloudfunctions/decisionEngine/index");

const LOCAL_LISTINGS = [
  {
    listing_id: "listing_smoke_a",
    title: "信州区电梯两室",
    city: "上饶",
    district: "信州区",
    community_name: "书香花园",
    price_total: 88,
    area_sqm: 89,
    layout_desc: "2室2厅",
    elevator_flag: true,
    missing_fields_json: []
  },
  {
    listing_id: "listing_smoke_b",
    title: "广丰区步梯三室",
    city: "上饶",
    district: "广丰区",
    community_name: "阳光家园",
    price_total: 76,
    area_sqm: 96,
    layout_desc: "3室1厅",
    elevator_flag: false,
    missing_fields_json: ["elevator_flag"]
  },
  {
    listing_id: "listing_smoke_c",
    title: "信州区电梯三室",
    city: "上饶",
    district: "信州区",
    community_name: "锦绣江南",
    price_total: 92,
    area_sqm: 102,
    layout_desc: "3室2厅",
    elevator_flag: true,
    missing_fields_json: []
  }
];

async function call(action, extra = {}) {
  return decisionEngine.main(
    {
      action,
      user_id: "user_smoke",
      local_listings: LOCAL_LISTINGS,
      ...extra
    },
    {}
  );
}

async function main() {
  const start = await call("start", {
    chat_session_id: "chat_smoke_001",
    selected_listing_ids: ["listing_smoke_a", "listing_smoke_b"],
    context: {
      active_intake: {
        intake_id: "intake_smoke_001",
        city: "上饶",
        budget_max: 90
      },
      memory_profile: {
        elevator_required: true
      }
    }
  });

  if (!start.success) {
    throw new Error(`start failed: ${start.error && start.error.code}`);
  }

  const decisionSessionId = start.data.decision_session_id;
  const state = await call("state", {
    decision_session_id: decisionSessionId
  });
  const pairwise = await call("pairwise", {
    decision_session_id: decisionSessionId,
    winner_listing_id: "listing_smoke_a",
    loser_listing_id: "listing_smoke_b"
  });
  if (pairwise.data.current_stage === "pairwise") {
    throw new Error("pairwise did not advance stage after the only unique pair was answered");
  }
  if (pairwise.data.next_pairwise_question) {
    throw new Error("pairwise should not repeat the same question when only one unique pair exists");
  }
  const critique = await call("critique", {
    decision_session_id: decisionSessionId,
    text: "不要楼梯房，而且太贵的不考虑"
  });
  const relax = await call("relax", {
    decision_session_id: decisionSessionId
  });

  const allPassed = [state, pairwise, critique, relax].every((item) => item && item.success);
  if (!allPassed) {
    throw new Error("one of state/pairwise/critique/relax failed");
  }

  console.log("decision_engine_smoke_ok", {
    decision_session_id: decisionSessionId,
    stage: critique.data.current_stage,
    stable_count: critique.data.candidate_buckets.stable.length,
    balanced_count: critique.data.candidate_buckets.balanced.length,
    value_count: critique.data.candidate_buckets.value.length,
    relaxation_count: relax.data.relaxation_options.length
  });
}

main().catch((err) => {
  console.error("decision_engine_smoke_failed", err && err.message ? err.message : err);
  process.exitCode = 1;
});
