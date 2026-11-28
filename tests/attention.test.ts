/**
 * 管理关注 · 独立研判守护（2026-11-28 · sc 定向修订任务书 任务二）。
 *
 * 锁住四件事：
 *  ① 候选来自定稿后的必读/商机/风险，并带上已有经营领域（跨条线判定要用）；
 *  ② LLM 产出必须过**确定性校验**：来源只能来自候选、领域必须合法、不复述必读、
 *     不重复风险、不用命令式语言、最多 3 条；
 *  ③ 任何异常（无 LLM / 抛错 / 解析失败 / 全被剔除）→ 返回空数组，**绝不冒错**；
 *  ④ 0 条 = 页面上整块不展示（宁缺毋滥），不是用必读凑数。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ATTENTION,
  buildAttention,
  buildAttentionPrompt,
  collectAttentionCandidates,
  parseAttention,
} from "../lib/services/assemble/attention";
import type { DailyReport } from "../lib/contracts/report";
import type { LlmPort } from "../lib/contracts/pipeline";

const U1 = "https://e.com/wealth";
const U2 = "https://e.com/gold";
const U3 = "https://e.com/risk";

function item(url: string, over: Record<string, unknown> = {}) {
  return {
    url,
    title_cn: `条目 ${url}`,
    source: "测试源",
    source_type: "media" as const,
    date: "11/28",
    summary: "事实摘要",
    importance: 2 as const,
    rank: 1,
    tags: [] as string[],
    locale: "gz" as const,
    ...over,
  };
}

function report(over: Partial<DailyReport> = {}): DailyReport {
  return {
    date: "2026-11-28",
    hero_line: "",
    must_read: [
      { title: "多家银行调整财富产品策略", why: "多家银行下调代销费率", url: U1 },
      { title: "黄金配置区间上调", why: "黄金配置比例区间上调至 5%—28%", url: U2 },
    ],
    insights: [
      {
        topic: "高净值客户黄金配置需求",
        impact: "推动私行产品适配",
        action: "",
        tags: [],
        sources: [{ title: "源", url: U2 }],
      } as never,
    ],
    risk: {
      topic: "市场波动加剧",
      evidence: "主要指数单日振幅扩大",
      impact: "客户风险偏好可能下移",
      source: "T2",
      url: U3,
    } as never,
    sections: {
      gz_local: [item(U1, { primary_domain: "wealth_aum", related_domains: ["customer_growth"] })],
      biz_insight: [item(U2, { primary_domain: "customer_growth" })],
      policy_market: [item(U3, { primary_domain: "risk_compliance" })],
      tech: [],
      ipo: [],
    },
    ...over,
  };
}

/** 构造一个「按需返回」的 LLM 端口，同时记录收到的 prompt。 */
function fakeLlm(reply: string | Error, seen?: { prompt?: string }): LlmPort {
  return {
    async complete(req) {
      if (seen) seen.prompt = req.prompt;
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

// —— ① 候选 ——————————————————————————————————————

test("① 候选来自必读/商机/风险，且带上已打标的经营领域", () => {
  const cands = collectAttentionCandidates(report());
  assert.deepEqual(
    cands.map((c) => c.kind),
    ["must_read", "must_read", "insight", "risk"],
  );
  assert.deepEqual(cands[0].domains, ["wealth_aum", "customer_growth"], "必读候选带主领域+相关领域");
  assert.equal(cands[3].kind, "risk");
  assert.ok(cands.every((c) => c.urls.length > 0), "无 url 的条目不进候选（来源无法回溯）");
});

test("② 没有候选时 buildAttention 直接返回空数组（不调用 LLM）", async () => {
  let called = false;
  const llm: LlmPort = {
    async complete() {
      called = true;
      return "[]";
    },
  };
  const items = await buildAttention(
    report({ must_read: [], insights: [], risk: undefined, sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] } }),
    { llm },
  );
  assert.deepEqual(items, []);
  assert.equal(called, false, "没候选就不该烧一次调用");
});

// —— ② 校验 ——————————————————————————————————————

test("③ 合法条目通过校验，并带上稳定 id", () => {
  const cands = collectAttentionCandidates(report());
  const items = parseAttention(
    JSON.stringify([
      {
        topic: "财富客户资产配置需求变化",
        rationale: "代销费率调整与黄金配置区间上调同时出现",
        significance: "值得关注客户沟通口径与产品适配节奏",
        domains: ["wealth_aum", "customer_growth"],
        cross_domain_link: "财富管理与客户经营在代销费率和黄金配置上共同影响客户资产配置",
        source_urls: [U1, U2],
      },
    ]),
    cands,
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "att-1");
  assert.deepEqual(items[0].domains, ["wealth_aum", "customer_growth"]);
  assert.deepEqual(items[0].source_urls, [U1, U2]);
});

test("④ 凭空来源（不在候选里）→ 整条剔除", () => {
  const cands = collectAttentionCandidates(report());
  const items = parseAttention(
    JSON.stringify([
      {
        topic: "某条管理议题",
        rationale: "依据",
        significance: "意义",
        domains: ["wealth_aum"],
        source_urls: ["https://fake.example.com/x"],
      },
    ]),
    cands,
  );
  assert.deepEqual(items, [], "来源必须能在当日候选里找到，否则判为编造");
});

test("⑤ 非法领域 id → 过滤；全非法则用来源条目已有领域兜底", () => {
  const cands = collectAttentionCandidates(report());
  const items = parseAttention(
    JSON.stringify([
      {
        topic: "跨条线管理议题",
        rationale: "依据",
        significance: "意义",
        domains: ["不存在的领域", "wealth_aum"],
        source_urls: [U1],
      },
    ]),
    cands,
  );
  assert.deepEqual(items[0].domains, ["wealth_aum"], "非法 id 被过滤，合法的留下");

  const fallback = parseAttention(
    JSON.stringify([
      { topic: "另一个议题", rationale: "依据", significance: "意义", domains: [], source_urls: [U1] },
    ]),
    cands,
  );
  assert.ok(fallback[0].domains.includes("wealth_aum"), "LLM 不给领域时用来源条目已打标的领域兜底");
});

test("⑥ 与必读高度重复且只引那一条 → 判为复述，剔除", () => {
  const cands = collectAttentionCandidates(report());
  const items = parseAttention(
    JSON.stringify([
      {
        topic: "多家银行调整财富产品策略",
        rationale: "费率下调",
        significance: "值得关注",
        domains: ["wealth_aum"],
        source_urls: [U1],
      },
    ]),
    cands,
  );
  assert.deepEqual(items, [], "这就是必读那条的摘要，不能算管理关注");
});

test("⑦ 只引风险那一条、且不带额外领域 → 剔除（风险模块已说过）", () => {
  const cands = collectAttentionCandidates(report());
  const items = parseAttention(
    JSON.stringify([
      {
        topic: "市场波动与客户风险偏好变化",
        rationale: "指数振幅扩大",
        significance: "值得关注",
        domains: ["risk_compliance"],
        source_urls: [U3],
      },
    ]),
    cands,
  );
  assert.deepEqual(items, [], "纯风险复述不算管理关注");
});

test("⑧ 命令式 / 越界措辞 → 剔除（管理关注不是行内指令）", () => {
  const cands = collectAttentionCandidates(report());
  for (const wording of ["必须立即开展客户排查", "要求各部门本周落实", "责成各支行整改"]) {
    const items = parseAttention(
      JSON.stringify([
        {
          topic: "跨条线管理议题",
          rationale: `依据：${wording}`,
          significance: "意义",
          domains: ["wealth_aum", "customer_growth"],
        cross_domain_link: "财富管理与客户经营在代销费率和黄金配置上共同影响客户资产配置",
          source_urls: [U1, U2],
        },
      ]),
      cands,
    );
    assert.deepEqual(items, [], `命令式措辞必须被拦下：${wording}`);
  }
});

test("⑨ 主题自身重复 → 只留先出现的；超过上限 → 截断", () => {
  const cands = collectAttentionCandidates(report());
  const topics = [
    "财富客户配置需求变化",
    "小微企业续贷政策衔接",
    "渠道代销费率调整",
    "跨境理财通额度变化",
    "住房金融需求回暖",
  ];
  const many = topics.map((topic) => ({
    topic,
    rationale: "依据",
    significance: "意义",
    domains: ["wealth_aum", "customer_growth"],
        cross_domain_link: "财富管理与客户经营在代销费率和黄金配置上共同影响客户资产配置",
    source_urls: [U1, U2],
  }));
  const items = parseAttention(JSON.stringify(many), cands);
  assert.equal(items.length, MAX_ATTENTION, "最多 3 条");

  const dup = parseAttention(
    JSON.stringify([
      { topic: "客户资产配置需求变化", rationale: "依据A", significance: "意义", domains: ["wealth_aum"], source_urls: [U1] },
      { topic: "客户资产配置需求变化", rationale: "依据B", significance: "意义", domains: ["customer_growth"], source_urls: [U2] },
    ]),
    cands,
  );
  assert.equal(dup.length, 1, "同主题不重复展示");
});

test("⑩ 解析失败 / 空数组 → 空（宁缺毋滥，不造 3 条）", () => {
  const cands = collectAttentionCandidates(report());
  assert.deepEqual(parseAttention("这不是 JSON", cands), []);
  assert.deepEqual(parseAttention("[]", cands), []);
  assert.deepEqual(parseAttention("", cands), []);
});

// —— ③ 降级 ——————————————————————————————————————

test("⑪ LLM 抛错 → 返回空数组，绝不冒错（不能拖垮发布）", async () => {
  const items = await buildAttention(report(), { llm: fakeLlm(new Error("timeout")) });
  assert.deepEqual(items, []);
});

test("⑫ 无 LLM 端口 → 空数组（不展示模块）", async () => {
  assert.deepEqual(await buildAttention(report(), {}), []);
});

test("⑬ 正常路径：采用 LLM 产出，prompt 含领域枚举与来源约束", async () => {
  const seen: { prompt?: string } = {};
  const items = await buildAttention(report(), {
    llm: fakeLlm(
      JSON.stringify([
        {
          topic: "财富客户资产配置需求变化",
          rationale: "代销费率调整与黄金配置区间上调同时出现",
          significance: "值得关注客户沟通口径与产品适配节奏",
          domains: ["wealth_aum", "customer_growth"],
        cross_domain_link: "财富管理与客户经营在代销费率和黄金配置上共同影响客户资产配置",
          source_urls: [U1, U2],
        },
      ]),
      seen,
    ),
  });
  assert.equal(items.length, 1);
  assert.ok((seen.prompt ?? "").includes("wealth_aum"), "prompt 必须给出合法领域枚举");
  assert.ok((seen.prompt ?? "").includes("source_urls"), "prompt 必须约束来源");
  assert.ok(/不得虚构本行经营数据/.test(buildAttentionPrompt(collectAttentionCandidates(report())).system));
});

// —— 第二轮修订 3.2/3.3/3.4/3.5：领域必须由来源支撑 ——————————

test("⑭ 合法但不相关的领域 ID 必须与来源领域取交集，不得凭空造跨条线", () => {
  const items = parseAttention(
    JSON.stringify([
      {
        topic: "财富业务沟通口径值得进一步了解",
        rationale: "代销费率调整",
        significance: "值得持续观察",
        domains: ["wealth_aum", "retail_credit"], // retail_credit 合法，但来源没这个领域
        source_urls: [U1],
      },
    ]),
    collectAttentionCandidates(report()),
  );
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].domains, ["wealth_aum"], "来源不支持的合法 ID 必须被剔除");
});

test("⑮ 一条候选自带多个标签不构成跨条线；跨条线需两条候选分别支撑", () => {
  const cands = collectAttentionCandidates(report());
  const one = parseAttention(
    JSON.stringify([
      {
        topic: "财富业务沟通口径值得进一步了解",
        rationale: "代销费率调整",
        significance: "值得持续观察",
        domains: ["wealth_aum", "customer_growth"],
        source_urls: [U1], // 只有 c1，它自带两个领域标签
      },
    ]),
    cands,
  );
  assert.deepEqual(one[0].domains, ["wealth_aum"], "单来源多标签 ≠ 跨条线");
  assert.equal(one[0].cross_domain_link, undefined);

  const noLink = parseAttention(
    JSON.stringify([
      {
        topic: "财富客户资产配置需求变化",
        rationale: "代销费率调整与黄金配置区间上调同时出现",
        significance: "值得关注客户沟通口径与产品适配节奏",
        domains: ["wealth_aum", "customer_growth"],
        source_urls: [U1, U2],
      },
    ]),
    cands,
  );
  assert.deepEqual(noLink, [], "两条来源支撑但没有实际关联说明 → 不生成");
});

test("⑯ confidence 分档：事实全可核 → high；夹带无法核到的摘录 → medium；全不可核 → 不生成", () => {
  const cands = collectAttentionCandidates(report());
  const base = {
    topic: "财富业务沟通口径值得进一步了解",
    rationale: "代销费率调整",
    significance: "值得持续观察",
    domains: ["wealth_aum"],
    source_urls: [U1],
  };
  const high = parseAttention(JSON.stringify([base]), cands);
  assert.equal(high[0].confidence, "high", "未给摘录时用候选事实兜底，全部可核");

  const medium = parseAttention(
    JSON.stringify([
      {
        ...base,
        supporting_facts: ["多家银行下调代销费率", "AI 自己总结的一条管理判断"],
      },
    ]),
    cands,
  );
  assert.equal(medium[0].confidence, "medium", "部分事实核不到 → 不能继续标 high");

  const none = parseAttention(
    JSON.stringify([{ ...base, supporting_facts: ["完全无法在候选里核到的事实"] }]),
    cands,
  );
  assert.deepEqual(none, [], "事实支撑不足 → 整条剔除");
});

test("⑰ 与商机洞察重复 → 剔除；多条商机合并成管理议题 → 保留全部来源", () => {
  const cands = collectAttentionCandidates(report());
  const restate = parseAttention(
    JSON.stringify([
      {
        topic: "高净值客户黄金配置需求",
        rationale: "黄金配置区间上调",
        significance: "值得关注",
        domains: ["customer_growth"],
        source_candidate_ids: ["c3"], // U2 同时被必读和商机引用 → 用编号明确指向商机
        source_urls: [U2],
      },
    ]),
    cands,
  );
  assert.deepEqual(restate, [], "换个标题复述商机洞察不算管理关注");

  const U4 = "https://e.com/fee";
  const twoInsights = report({
    insights: [
      report().insights![0],
      {
        topic: "代销费率下行带来的收入结构变化",
        impact: "财富管理中收承压",
        action: "",
        tags: [],
        sources: [{ title: "源2", url: U4 }],
      } as never,
    ],
    sections: {
      ...report().sections!,
      biz_insight: [...report().sections!.biz_insight, item(U4, { primary_domain: "wealth_aum" })],
    },
  });
  const merged = parseAttention(
    JSON.stringify([
      {
        topic: "财富与客群经营的中收议题",
        rationale: "代销费率调整与黄金配置区间上调同时出现",
        significance: "值得关注产品适配节奏",
        domains: ["customer_growth", "wealth_aum"],
        source_candidate_ids: ["c3", "c4"],
        source_urls: [U2, U4],
        cross_domain_link: "客户经营与财富管理在代销收入与黄金配置上共同变化",
      },
    ]),
    collectAttentionCandidates(twoInsights),
  );
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].source_urls, [U2, U4], "多商机合并必须保留全部来源");
});

test("⑱ prompt 要求 candidate_id / supporting_facts / 跨条线关联说明", () => {
  const { prompt, system } = buildAttentionPrompt(collectAttentionCandidates(report()));
  assert.ok(prompt.includes("[c1]"), "候选必须编号，LLM 才能回引");
  assert.ok(prompt.includes("source_candidate_ids"), "prompt 必须约束候选编号");
  assert.ok(prompt.includes("supporting_facts"), "prompt 必须约束事实摘录");
  assert.ok(prompt.includes("cross_domain_link"), "prompt 必须约束跨条线说明");
  assert.ok(/一条候选本身带多个标签，不构成跨条线/.test(system));
});

test("⑲ prompt 不搬运整篇正文：长标题只截断展示，判定用候选仍保留全文", () => {
  const longTitle = "中国证监会严肃查处编造传播证券市场误导性信息案件".repeat(6);
  const c = {
    id: "c1",
    kind: "must_read" as const,
    title: longTitle,
    fact: "监管处罚事实",
    urls: ["https://e.com/x"],
    domains: [] as string[],
  };
  const { prompt, system } = buildAttentionPrompt([c]);
  assert.ok(system.includes("只作定位"), "system 必须禁止整段复述候选标题");
  assert.ok(system.includes("处罚/合规类事件优先按风险提示理解"));
  assert.ok(!prompt.includes(longTitle), "prompt 不得塞进整篇正文");
  assert.ok(prompt.includes("…"), "超长标题应有截断标记");
  assert.equal(c.title.length, longTitle.length, "候选对象本身不 mutate，titleSim 口径不变");
});
