import { test } from "node:test";
import assert from "node:assert/strict";
import { select } from "../lib/services/select";
import { createContext } from "../lib/orchestrator";
import type { SourceDef } from "../lib/contracts/source";
import type { ArticleInput } from "../lib/contracts/article";
import { MemFs, SilentLog } from "./helpers";

const sources: SourceDef[] = [
  { id: "s1", name: "源一", type: "rss", url: "https://example.com/1", category: "finance", tier: "T1" },
  { id: "s2", name: "源二", type: "rss", url: "https://example.com/2", category: "finance", tier: "T2" },
];

const KEYWORDS = { global_exclude: {}, dimensions: {}, opportunity_tracker: {}, risk_tracker: {} };

function article(over: Partial<ArticleInput>): ArticleInput {
  return {
    sourceId: "s1",
    title: "普通财经新闻标题",
    url: "u",
    category: "finance",
    publishedAt: new Date("2026-09-11T08:00:00Z"),
    excerpt: "摘要",
    isIpo: false,
    tier: "T2",
    source: "源一",
    ...over,
  } as ArticleInput;
}

function makeCtx(over: { startTime?: Date; windowDays?: number } = {}) {
  return createContext({
    date: "2026-09-11",
    mode: { kind: "ai" },
    sources,
    log: new SilentLog(),
    startTime: over.startTime ?? new Date("2026-09-11T08:00:00Z"),
    config: { windowDays: over.windowDays ?? 2 },
  });
}

async function runSelect(
  articles: ArticleInput[],
  ctx: ReturnType<typeof makeCtx>,
  history: import("../lib/services/memory/history").HistoryStore = {},
) {
  const fs = new MemFs();
  fs.setJson("sources.keywords.json", KEYWORDS);
  return select(articles, ctx, { fs, history });
}

test("Stage1 pre-window：窗外条目被丢弃（gzinfo 日历日窗口，无 +1 宽限）", async () => {
  const now = new Date("2026-09-11T08:00:00Z");
  const inWindow = article({ url: "in", publishedAt: new Date(now.getTime() - 86_400_000) });
  const outOfWindow = article({
    url: "out",
    publishedAt: new Date(now.getTime() - 10 * 86_400_000),
  });
  const r = await runSelect([inWindow, outOfWindow], makeCtx({ startTime: now, windowDays: 2 }));
  assert.deepEqual(r.articles.map((a) => a.url), ["in"]);
});

test("Stage1 窗口口径：前天（第 3 个日历日）出窗——gzinfo 日历日语义，无 windowDays+1 宽限", async () => {
  const now = new Date("2026-09-11T08:00:00Z");
  const edge = article({ url: "edge", publishedAt: new Date(now.getTime() - 3 * 86_400_000) });
  const r = await runSelect([edge], makeCtx({ startTime: now, windowDays: 2 }));
  assert.equal(r.articles.length, 0);
});

test("Stage1 IPO 豁免：isIpo 条目按 7 天窗口（2 天窗外仍保留）", async () => {
  const now = new Date("2026-09-11T08:00:00Z");
  const ipo = article({
    url: "ipo",
    isIpo: true,
    category: "gd-ipo",
    title: "某广东企业 IPO 注册申请已受理",
    publishedAt: new Date(now.getTime() - 5 * 86_400_000),
  });
  const r = await runSelect([ipo], makeCtx({ startTime: now, windowDays: 2 }));
  assert.equal(r.articles.length, 1);
});

test("Stage2 单机构过滤：单家非白名单银行新闻被丢（IPO 豁免）", async () => {
  const single = article({
    url: "single-bank",
    title: "成都银行发布中报业绩",
    excerpt: "成都银行上半年营收增长",
  });
  const whitelist = article({
    url: "gz-bank",
    title: "广州银行推出跨境金融服务",
    excerpt: "广州银行落地新方案",
  });
  const r = await runSelect([single, whitelist], makeCtx());
  assert.deepEqual(r.articles.map((a) => a.url), ["gz-bank"]);
});

test("Stage3 股市单股过滤：非巨头单股异动被丢，宏观/巨头保留", async () => {
  const macro = article({ url: "macro", category: "stocks", title: "A股三大指数收涨，北向资金流入" });
  const single = article({ url: "small", category: "stocks", title: "某科技公司股价大涨创历史新高" });
  const r = await runSelect([macro, single], makeCtx());
  assert.deepEqual(r.articles.map((a) => a.url), ["macro"]);
});

test("Stage4 keyword-funnel：L0 硬排除（标题命中黑名单即丢）", async () => {
  const kw = {
    global_exclude: { hard_exclude: ["彩票"] },
    dimensions: {},
    opportunity_tracker: {},
    risk_tracker: {},
  };
  const fs = new MemFs();
  fs.setJson("sources.keywords.json", kw);
  const bad = article({ url: "bad", title: "今日彩票开奖号码" });
  const good = article({ url: "good", title: "普惠小微贷款支持工具落地" });
  const r = await select([bad, good], makeCtx(), { fs });
  assert.deepEqual(r.articles.map((a) => a.url), ["good"]);
});

test("Stage5 标题相似度判重：同主题同 tier 只留 1（新→旧保留）；不同 tier 各留 1", async () => {
  const a1 = article({
    url: "t1",
    sourceId: "s1",
    tier: "T2",
    title: "央行宣布降准 0.5 个百分点释放流动性",
    publishedAt: new Date("2026-09-11T07:00:00Z"),
  });
  const a2 = article({
    url: "t2",
    sourceId: "s2",
    tier: "T2",
    title: "央行宣布降准0.5个百分点 释放长期流动性",
    publishedAt: new Date("2026-09-11T06:00:00Z"),
  });
  const a3 = article({
    url: "t3",
    sourceId: "s1",
    tier: "T1",
    title: "央行宣布降准 0.5 个百分点释放流动性",
    publishedAt: new Date("2026-09-11T05:00:00Z"),
  });
  const r = await runSelect([a2, a1, a3], makeCtx());
  // 同 T2 只留更新的 t1；T1 与 T2 不同档 → 各留 1（gzinfo「政府留 1 + 媒体留 1」）
  assert.deepEqual(r.articles.map((a) => a.url).sort(), ["t1", "t3"]);
});

test("Stage6 跨天判重：历史库已有相似标题（先来后到），新条目同 tier 被丢", async () => {
  const now = new Date("2026-09-11T08:00:00Z");
  const fresh = article({
    url: "fresh",
    sourceId: "s2",
    tier: "T2",
    title: "央行两部门：个人住房贷款最长可贷40年",
    publishedAt: now,
  });
  const history: Record<string, import("../lib/services/memory/history").HistoryEntry> = {
    "hist-1": {
      title: "央行两部门：个人住房贷款最长可贷40年",
      url: "hist-1",
      sourceId: "s2",
      source: "历史源",
      category: "finance",
      publishedAt: new Date(now.getTime() - 86_400_000).toISOString(),
      firstSeenAt: new Date(now.getTime() - 86_400_000).toISOString(),
      lastSeenAt: new Date(now.getTime() - 86_400_000).toISOString(),
    },
  };
  const r = await runSelect([fresh], makeCtx({ startTime: now }), history);
  assert.deepEqual(r.articles.map((a) => a.url), [], "历史先来者占同 tier 位 → 新条目被丢");
});

test("Stage7 全局相关性 Top200 + 每源软上限 20：同一源超过 20 条被截断", async () => {
  process.env.DEDUP_SIMILAR = "off"; // 隔离 Stage5/6（本测试只验证 Stage7 配额）
  try {
    const now = new Date("2026-09-11T08:00:00Z");
    // 25 条真实感互异标题（bigram Dice 两两 < 0.6，避免被 Stage6 跨天判重吞掉）
    const titles = [
      "美联储加息路径展望", "广州地铁新线开通", "制造业PMI回升", "新能源汽车出口增长", "养老服务体系建设",
      "大湾区科技创新", "人民币汇率走势", "跨境电商新政", "医保支付改革", "义务教育政策",
      "房地产信贷数据", "黄金价格创新高", "粮食安全保障", "航空客流恢复", "海洋经济规划",
      "汽车以旧换新", "创新药审批加速", "新材料产业基金", "半导体设备国产化", "光伏装机量统计",
      "餐饮连锁扩张", "零售数字化转型", "服装品牌出海", "家电换新补贴", "乡村旅游振兴",
    ];
    const items = titles.map((t, i) =>
      article({ url: `p${i}`, title: t, publishedAt: new Date(now.getTime() - i * 60_000) }),
    );
    const r = await runSelect(items, makeCtx());
    assert.equal(r.articles.length, 20, "每源软上限 20（全局 Top200 不构成约束）");
  } finally {
    delete process.env.DEDUP_SIMILAR;
  }
});

test("B-1 filterResults：商机/风险命中条目建表（risks-only 超集，供回检与 side-outputs）", async () => {
  const kw = {
    global_exclude: {},
    dimensions: {},
    opportunity_tracker: {
      gov_subsidy: { priority: "S" as const, strong_triggers: ["补贴", "专项资金"], action: "跟进申报", fields: [] },
    },
    risk_tracker: {},
  };
  const fs = new MemFs();
  fs.setJson("sources.keywords.json", kw);
  const hit = article({ url: "opp", title: "广州发放产业补贴专项资金" });
  const miss = article({ url: "plain", title: "一项普通财经动态" });
  const r = await select([hit, miss], makeCtx(), { fs });
  assert.ok(r.filterResults.get("opp")?.opportunities?.length === 1);
  assert.equal(r.filterResults.get("plain"), undefined, "未命中 opp/risks 的条目不入表（gzinfo B-1 语义）");
});
