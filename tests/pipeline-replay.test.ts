/**
 * C-2 真实条目回放（上游判定层）。
 *
 * 与 `source-category-invariant.test.ts` / `gd-ipo-side-output.test.ts` 的区别：
 * 那两个文件用的是**合成**夹具（干净的正则能命中），本文件把 **2026-09-14 归档报告里
 * 真实出现过的 13 条 `sections.ipo`** 原样回放，并刻意复原当时的**错误前置条件**
 * （`crunchbase-news` 的 category 被误配为 `gd-ipo`），以此锁住 P0-1 的完整失败模式：
 *
 *   「通用创投 RSS 打上 IPO 类目 → 绕过全部内容判定 → 美国创投新闻进「广东IPO动态」
 *     并打「粤」标」（实测：8 条 Crunchbase 美国创投占据该板块前 8 位）
 *
 * 还覆盖 P0-2 的伴生风险：13 条被 D-2 清除的**非金融**题材（政治/地缘/选举体育/生活方式）
 * 在评分口径下必须全部 `drop` —— 证明「放进滚动池就会被兜底并入」的担忧不成立，
 * 同时把该口径写成断言，避免后续调参时无声放宽。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGdIpo } from "../lib/pipeline/side-outputs/side-gd-ipo";
import { isGdIpoCandidate } from "../lib/services/render/cards";
import { scoreBranchRelevance } from "../lib/services/select/filters/relevance-score";
import type { ArticleInput } from "../lib/contracts/article";
import type { DailyReport } from "../lib/contracts/report";
import type { PipelineContext } from "../lib/contracts/pipeline";

const ctx = {
  date: "2026-09-14",
  log: { info: () => {}, warn: () => {}, error: () => {} },
} as unknown as PipelineContext;

function art(title: string, over: Partial<ArticleInput> = {}): ArticleInput {
  return {
    sourceId: "hk-filing-gd",
    source: "港交所新股递表(广东企业赴港)",
    title,
    url: `https://e.com/${encodeURIComponent(title).slice(0, 24)}`,
    excerpt: "",
    publishedAt: new Date("2026-09-13T00:00:00.000Z"),
    fetchedAt: new Date("2026-09-14T00:00:00.000Z"),
    category: "gd-ipo",
    isIpo: true,
    ...over,
  } as ArticleInput;
}

function emptyReport(): DailyReport {
  return {
    date: "2026-09-14",
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  };
}

/** 归档报告 sections.ipo 中真实出现过的 8 条 Crunchbase 美国创投（标题为原文截断）。 */
const CRUNCHBASE_REAL = [
  "The Week's 10 Biggest Funding Rounds: The Boring Co.",
  "The Only 2 Moats That Actually Work In The AI Era",
  "How This Doctor-Turned-Startup-Founder Decided To Fight Insurance",
  "How To Measure An Innovation Economy: South Korea",
  "29 Companies Joined The Unicorn Board In August, Led By AI",
  "The Crunchbase Tech Layoffs Tracker",
  "The Sales Test This Norwest Partner Gives Founders Before Investing",
  "Mistral AI Raises $3.5B At $24B Valuation In Another Mega-Round",
];

/** 归档中真实的港交所递表条目：2 条广东企业 + 3 条全国参考（带结构化阶段信号）。 */
const HK_GUANGDONG = [
  "廣東微電新能源股份有限公司（主板递表·广东企业）",
  "深圳市海柔創新智能科技集團股份有限公司 - W（主板递表·广东企业）",
];
const HK_NATIONAL = [
  "翱捷科技股份有限公司（主板递表）",
  "浙江和夏科技股份有限公司（GEM递表）",
  "河北聯吉啟成產業園區運營管理股份有限公司（GEM递表）",
];

test("P0-1 回放：即使 category 被误配为 gd-ipo，美国创投也不得进「广东IPO」板块", () => {
  // 刻意复原事故前置：crunchbase 条目带上 gd-ipo 类目（当时 sources.config.json 的错配）
  const articles: ArticleInput[] = [
    ...CRUNCHBASE_REAL.map((t) => art(t, { sourceId: "crunchbase-news", source: "Crunchbase News" })),
    ...HK_GUANGDONG.map((t) => art(t, { excerpt: "市场：主板｜广东企业赴港上市，可跟进跨境融资商机" })),
    ...HK_NATIONAL.map((t) =>
      art(t, {
        sourceId: "hk-filing",
        source: "港交所新股递表(主板/GEM·全国参考)",
        category: "ipo",
        ipoStage: "递表",
      }),
    ),
  ];
  assert.equal(articles.length, 13, "夹具应为归档中的 13 条");

  const out = buildGdIpo(emptyReport(), articles, ctx);
  const titles = out.sections.ipo.map((it) => it.title_cn);
  const joined = titles.join("|");

  // ① 8 条美国创投一条都不能进
  for (const t of CRUNCHBASE_REAL) {
    assert.ok(!joined.includes(t), `美国创投不得进广东IPO板块：${t}`);
  }
  assert.ok(
    !out.sections.ipo.some((it) => /crunchbase|unicorn board|layoffs tracker/i.test(it.title_cn)),
    "板块内不得残留任何 Crunchbase 美国创投痕迹",
  );

  // ② 2 条真广东企业必须进且带「粤」标（本轮修复同时补回了「深圳市海柔創新」此前漏掉的标记）
  for (const t of HK_GUANGDONG) {
    const hit = out.sections.ipo.find((it) => it.title_cn === t);
    assert.ok(hit, `真广东企业条目丢失：${t}`);
    assert.ok(hit.tags.includes("粤"), `广东企业条目应带「粤」标：${t}`);
  }

  // ③ 数量锁死：13 → 5（8 剔除 / 5 保留），防止再次放宽或过度收紧
  assert.equal(out.sections.ipo.length, 5, `应保留 5 条，实际 ${out.sections.ipo.length}：${joined}`);
});

test("P0-1 反证：内容判定对 8 条美国创投全部不通过（不是靠黑名单偶然命中）", () => {
  for (const t of CRUNCHBASE_REAL) {
    assert.equal(isGdIpoCandidate(t, ""), false, `英文创投标题不应通过广东IPO内容判定：${t}`);
  }
  for (const t of HK_GUANGDONG) {
    assert.equal(isGdIpoCandidate(t, "广东企业赴港上市"), true, `真粤企应通过内容判定：${t}`);
  }
});

test("D-2 回放：被清除的 13 条非金融题材在评分口径下必须全部 drop", () => {
  const dropped = [
    "Washington scrambles to meet calls for AI guardrails while the window to act closes",
    "Anthropic's Amodei says China presents 'toughest dilemma' for his proposed AI rules",
    "Xi says China will take lead to foster AI, tech cooperation among BRICS countries",
    "I'm a psychologist who studies couples: Emotionally intelligent partners ask 1 question",
    "Vessel struck in Strait of Hormuz, UKMTO says, as prospects for U.S.-Iran diplomacy dim",
    "Taxing high earners to help fund Social Security gains bipartisan attention",
    "NFL and midterm elections set up prediction markets for a critical fall season",
    "China's Xi urges BRICS nations to work towards peace in the Middle East",
    "Conversations that AIs are having in the office that may influence your performance",
    "Brent crude jumps above $108 after Saudi Arabia shuts down critical pipeline to Red Sea",
    "Trump urges Ukraine to stop 'knocking out' Russian oil refineries as U.S. discusses",
    "Iran says it destroys U.S. advanced drone over Hormuz as Middle East conflict widens",
    "LA Clippers owner Steve Ballmer apologizes over team sanctions",
  ];
  for (const t of dropped) {
    const r = scoreBranchRelevance({ title: t, category: "stocks", subcategory: "us", sourceId: "cnbc-top" });
    assert.equal(r.tier, "drop", `非金融题材应被判 drop（业务相关性红线）：${t} → ${r.tier}`);
  }

  // 对照组：与客群/财富/信贷相关的真实题材必须非 drop —— 防止「一律 drop」这种退化解法
  const kept = [
    "多地房地产成交修复，广州首套房贷利率下调",
    "算力贷科技金融产品上新，银行加码科创客群",
    "证监会同意粤芯半导体IPO注册",
  ];
  for (const t of kept) {
    const r = scoreBranchRelevance({ title: t, category: "gz", subcategory: "gz-finance" });
    assert.notEqual(r.tier, "drop", `相关题材不应被 drop：${t} → ${r.tier}`);
  }
});
