/**
 * 回归测试：IPO 板块归属与「粤」标**不得**由数据源 category 决定
 * （无状态源架构红线；2026-09-14 crunchbase-news 事故）。
 *
 * 事故链：`sources.config.json` 把通用创投 RSS `crunchbase-news` 配成 `category: "gd-ipo"`，
 * 而 side-gd-ipo 以 `IPO_CAT.has(category)` / `category === "gd-ipo"` 直通 →
 * 8 条美国创投新闻（The Crunchbase Tech Layoffs Tracker / Mistral AI 等）
 * 进入「广东IPO动态」板块，并被打上「粤」标 + `ipoCity = "广东"`。
 * 实测同时存在反向错误：真粤企「深圳市海柔創新…（主板递表·广东企业）」漏标「粤」。
 *
 * 本测试锁住四件事：
 *  1. 源配置不变量：`category ∈ {ipo, gd-ipo}` 只能给**结构化 IPO 采集源**（非通用 RSS）；
 *  2. category 单独命中不再足以进板块 / 打粤标（须结构化信号或内容判定）；
 *  3. 结构化广东信号（`registeredProvince`）仍能打粤标 —— 防过度收紧导致真粤企漏标；
 *  4. 港交所「全国参考」递表条目仍进板块但**不**打粤标（既有设计不得回退）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { todayKey } from "../lib/utils/time";
import { buildGdIpo } from "../lib/pipeline/side-outputs/side-gd-ipo";
import type { ArticleInput } from "../lib/contracts/article";
import type { DailyReport } from "../lib/contracts/report";
import type { PipelineContext } from "../lib/contracts/pipeline";

const ctx = {
  date: "2026-09-14",
  log: { info: () => {}, warn: () => {}, error: () => {} },
} as unknown as PipelineContext;

function mmdd(offset: number): string {
  const base = Date.parse(`${todayKey()}T00:00:00Z`) + offset * 86_400_000;
  const d = new Date(base);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}

const emptyReport = (): DailyReport =>
  ({
    date: "2026-09-14",
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  }) as unknown as DailyReport;

const makeArticle = (over: Partial<ArticleInput>): ArticleInput =>
  ({
    sourceId: "test-src",
    source: "测试源",
    title: "t",
    url: "https://example.com/a",
    excerpt: "",
    category: "finance",
    tier: "T2",
    publishedAt: new Date(`${mmdd(0).replace("/", "-")}T08:00:00+08:00`),
    ...over,
  }) as ArticleInput;

type Src = {
  id: string;
  type: string;
  category: string;
  enabled?: boolean;
  role?: string;
};

function loadSources(): Src[] {
  const raw = JSON.parse(readFileSync(new URL("../sources.config.json", import.meta.url), "utf8"));
  return Array.isArray(raw) ? raw : raw.sources;
}

test("源配置不变量：category ∈ {ipo, gd-ipo} 只能是结构化 IPO 采集源", () => {
  const offenders = loadSources()
    .filter((s) => s.enabled !== false)
    .filter((s) => s.category === "ipo" || s.category === "gd-ipo")
    // 结构化判定：非 RSS 抓取（api/scrape）或显式声明为爬虫输入
    .filter((s) => !(s.type !== "rss" || s.role === "crawled-input"))
    .map((s) => `${s.id}(type=${s.type})`);
  assert.deepEqual(
    offenders,
    [],
    "通用 RSS 不得配置为 ipo/gd-ipo —— 该 category 是结构化 IPO 采集源专用标记，" +
      "配错会绕过内容判定直通 IPO 板块（crunchbase-news 事故根因）",
  );
});

test("generic RSS 误配 gd-ipo：不进 IPO 板块、不打「粤」标（crunchbase 事故回归）", () => {
  // 夹具刻意保留 category: "gd-ipo" —— 模拟误配的源；修复后仅 category 不再生效。
  const usNews: ArticleInput[] = [
    makeArticle({
      sourceId: "crunchbase-news",
      source: "Crunchbase News",
      title: "The Week's 10 Biggest Funding Rounds: The Boring Co., Cognition And Motive Lead A Massive Week",
      excerpt: "It was a monster week for U.S. startup funding, with four companies each raising $1 billion.",
      url: "https://news.crunchbase.com/venture/biggest-funding-rounds/",
      category: "gd-ipo",
    }),
    makeArticle({
      sourceId: "crunchbase-news",
      source: "Crunchbase News",
      title: "The Crunchbase Tech Layoffs Tracker",
      url: "https://news.crunchbase.com/venture/tech-layoffs-tracker/",
      category: "gd-ipo",
    }),
  ];
  const out = buildGdIpo(emptyReport(), usNews, ctx);
  assert.equal(out.sections.ipo?.length ?? 0, 0, "无结构化信号且内容判定不通过 → 不得进 IPO 板块");
  assert.ok(
    !JSON.stringify(out.sections.ipo ?? []).includes("粤"),
    "通用外文源不得被打「粤」标",
  );
});

test("结构化广东信号（registeredProvince）打「粤」标 —— 不依赖 category", () => {
  const arts: ArticleInput[] = [
    makeArticle({
      sourceId: "em-declare",
      source: "东财在审表",
      title: "尚睿科技：IPO已受理（拟北交所）",
      excerpt: "注册地：广东｜保荐：广发证券股份有限公司｜更新：2026-09-14",
      url: "https://data.eastmoney.com/xg/xg/#A25256",
      category: "finance",
      ipoStage: "stage-reviewing",
      registeredProvince: "广东",
    }),
  ];
  const out = buildGdIpo(emptyReport(), arts, ctx);
  assert.equal(out.sections.ipo?.length, 1, "结构化 IPO 记录应进板块");
  assert.ok(out.sections.ipo![0].tags?.includes("粤"), "结构化广东信号应打「粤」标");
});

test("内容判定命中（标题含广东城市 + IPO 阶段词）打「粤」标", () => {
  const arts: ArticleInput[] = [
    makeArticle({
      sourceId: "stcn-web",
      source: "证券时报",
      title: "深圳市海柔創新智能科技集團股份有限公司（主板递表·广东企业）",
      url: "https://www.stcn.com/article/detail/3332222.html",
      category: "finance",
    }),
  ];
  const out = buildGdIpo(emptyReport(), arts, ctx);
  assert.equal(out.sections.ipo?.length, 1, "媒体源内容判定命中应补位进 IPO 板块");
  assert.ok(out.sections.ipo![0].tags?.includes("粤"), "深圳企业内容判定命中应打「粤」标");
});

test("港交所「全国参考」递表：进板块但不打「粤」标（既有设计不得回退）", () => {
  const arts: ArticleInput[] = [
    makeArticle({
      sourceId: "hk-filing",
      source: "港交所新股递表(主板/GEM·全国参考)",
      title: "浙江和夏科技股份有限公司（GEM递表）",
      url: "https://www1.hkexnews.hk/app/appactive_app_gem_c.json#123456",
      category: "ipo",
      ipoStage: "stage-reviewing",
    }),
  ];
  const out = buildGdIpo(emptyReport(), arts, ctx);
  assert.equal(out.sections.ipo?.length, 1, "全国参考递表应保留在板块内（展示层再按广东过滤）");
  assert.ok(
    !out.sections.ipo![0].tags?.includes("粤"),
    "外省企业不得打「粤」标",
  );
});
