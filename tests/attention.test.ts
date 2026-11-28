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
