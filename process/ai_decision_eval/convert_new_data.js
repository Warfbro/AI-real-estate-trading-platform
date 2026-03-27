const fs = require("fs");
const path = require("path");

// 解析200条房源数据
function parseListings(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const listings = [];
  const listingBlocks = content.split("[LISTING]").slice(1);

  listingBlocks.forEach((block) => {
    const lines = block.trim().split("\n");
    const listing = {};

    lines.forEach((line) => {
      const match = line.match(/^(\w+)=(.+)$/);
      if (match) {
        const [, key, value] = match;
        listing[key] = value.trim();
      }
    });

    if (listing.listing_id) {
      // 转换为 decisionEngine 需要的格式
      listings.push({
        listing_id: listing.listing_id,
        city: listing.city,
        district: listing.district,
        plate: listing.plate,
        community: listing.community,
        title: `${listing.community} ${listing.layout} ${listing.price_total_wan}万`,
        price_total: parseFloat(listing.price_total_wan) * 10000,
        area_sqm: parseFloat(listing.area_m2),
        layout_desc: listing.layout,
        floor_level: listing.floor_level,
        facing: listing.facing,
        decoration: listing.decoration,
        year_built: parseInt(listing.year_built),
        elevator_flag: null, // 原数据没有电梯信息
        school_strength: listing.school_strength,
        commerce_level: listing.commerce_level,
        transport_level: listing.transport_level,
        property_level: listing.property_level,
        environment_level: listing.environment_level,
        noise_level: listing.noise_level,
        parking_level: listing.parking_level,
        medical_level: listing.medical_level,
        risk_level: listing.risk_level,
        risk_tags: listing.risk_tags ? listing.risk_tags.split("|") : [],
        fit_tags: listing.fit_tags ? listing.fit_tags.split("|") : [],
        summary: listing.summary,
        missing_fields_json: []
      });
    }
  });

  return listings;
}

// 解析需求测试样本
function parseDemandCases(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const cases = [];
  const caseBlocks = content.split("[DEMAND_CASE]").slice(1);

  caseBlocks.forEach((block) => {
    const lines = block.trim().split("\n");
    const demandCase = {};

    lines.forEach((line) => {
      const match = line.match(/^(\w+)=(.+)$/);
      if (match) {
        const [, key, value] = match;
        demandCase[key] = value.trim();
      }
    });

    if (demandCase.case_id) {
      cases.push(demandCase);
    }
  });

  return cases;
}

// 将 DEMAND_CASE 转换为评测 case
function convertToEvalCase(demandCase, allListings) {
  // 解析 expected_slots
  let expectedSlots = {};
  try {
    expectedSlots = JSON.parse(demandCase.expected_slots || "{}");
  } catch (e) {
    console.error(`Failed to parse expected_slots for ${demandCase.case_id}:`, e.message);
  }

  // 解析 retrieval_hint
  let retrievalHint = {};
  try {
    retrievalHint = JSON.parse(demandCase.retrieval_hint || "{}");
  } catch (e) {
    console.error(`Failed to parse retrieval_hint for ${demandCase.case_id}:`, e.message);
  }

  // 获取候选房源
  const candidateIds = demandCase.candidate_ids ? demandCase.candidate_ids.split("|").map(id => id.trim()) : [];
  const candidateListings = candidateIds
    .map(id => allListings.find(l => l.listing_id === id))
    .filter(Boolean);

  // 如果候选房源少于4个，从符合条件的房源中补充
  if (candidateListings.length < 4) {
    const budgetMax = retrievalHint.budget_max ? retrievalHint.budget_max * 10000 : null;
    const schoolStrength = retrievalHint.school_strength;
    const layoutPrefix = retrievalHint.layout_prefix;

    const additionalCandidates = allListings.filter(l => {
      if (candidateIds.includes(l.listing_id)) return false;
      if (budgetMax && l.price_total > budgetMax) return false;
      if (schoolStrength && l.school_strength !== schoolStrength) return false;
      if (layoutPrefix && !l.layout_desc.startsWith(layoutPrefix)) return false;
      return true;
    }).slice(0, 4 - candidateListings.length);

    candidateListings.push(...additionalCandidates);
  }

  // 构造 context
  const context = {
    active_intake: {
      user_query: demandCase.user_input,
      intent: expectedSlots.goal || "buy_house"
    },
    memory_profile: {}
  };

  if (expectedSlots.budget_max) {
    context.active_intake.budget_max_wan = expectedSlots.budget_max;
  }
  if (expectedSlots.layout) {
    context.active_intake.layout_pref = expectedSlots.layout;
  }
  if (expectedSlots.district) {
    context.active_intake.target_area = {
      district: expectedSlots.district
    };
  }
  if (expectedSlots.school_strength) {
    context.memory_profile.school_priority = expectedSlots.school_strength === "强";
  }

  // 确定 gold top listing
  // 简单策略：第一个候选就是金标准
  const goldTopListingId = candidateIds[0] || (candidateListings[0] && candidateListings[0].listing_id) || "";

  // 构造评测 case
  return {
    case_id: demandCase.case_id.toLowerCase(),
    title: `${demandCase.case_type} - ${demandCase.subtype}`,
    tags: [
      "demand",
      demandCase.case_type.replace(/\s+/g, "_"),
      "budget_constraint",
      expectedSlots.school_strength === "强" ? "school_priority" : "",
      expectedSlots.layout ? "layout_specified" : ""
    ].filter(Boolean),
    query: demandCase.user_input,
    context: context,
    listings: candidateListings,
    interactions: [], // 暂不添加交互
    gold: {
      top_listing_id: goldTopListingId,
      relevance: candidateListings.reduce((acc, listing, index) => {
        // 按候选顺序给相关性评分
        acc[listing.listing_id] = candidateIds.includes(listing.listing_id)
          ? (3 - candidateIds.indexOf(listing.listing_id))
          : 0;
        return acc;
      }, {}),
      top1_rules: {
        budget_max: expectedSlots.budget_max ? expectedSlots.budget_max * 10000 : null,
        layout_includes: expectedSlots.layout || null
      }
    }
  };
}

// 主函数
function main() {
  const listingsPath = path.resolve(__dirname, "房产决策系统_第一版200条房源数据.txt");
  const demandsPath = path.resolve(__dirname, "房产决策系统_第一版大样本评测包_100plus_重新生成.txt");
  const outputPath = path.resolve(__dirname, "ai_decision_eval_dataset_v3.json");

  console.log("正在解析房源数据...");
  const allListings = parseListings(listingsPath);
  console.log(`解析完成，共 ${allListings.length} 条房源`);

  console.log("正在解析需求测试样本...");
  const demandCases = parseDemandCases(demandsPath);
  console.log(`解析完成，共 ${demandCases.length} 个需求样本`);

  // 选择前20个需求样本转换
  console.log("正在转换前20个需求样本...");
  const selectedCases = demandCases.slice(0, 20);
  const evalCases = selectedCases.map(dc => convertToEvalCase(dc, allListings));

  const dataset = {
    dataset_version: "2026-03-26.v3",
    description: "AI 买房决策离线评测集 v3。基于200条房源数据和100条需求样本生成，覆盖学区刚需、舒适自住、低总价上车、性价比折中等真实场景。",
    cases: evalCases
  };

  fs.writeFileSync(outputPath, JSON.stringify(dataset, null, 2), "utf8");
  console.log(`\n数据集已生成：${outputPath}`);
  console.log(`共 ${evalCases.length} 个评测 case`);

  // 输出标签统计
  const tagCounts = {};
  evalCases.forEach(c => {
    c.tags.forEach(tag => {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    });
  });
  console.log("\n标签分布：");
  Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).forEach(([tag, count]) => {
    console.log(`  ${tag}: ${count}`);
  });
}

main();
