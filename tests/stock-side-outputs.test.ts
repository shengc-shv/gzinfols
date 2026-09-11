/**
 * B4 股市链路集成测试（gzinfo side-outputs/stock-recap + stock-news 行为核对）。
 *
 * 覆盖（对照 docs/parity-plan.md §5 B4 验收口径）：
 *  1. 行情 API 解析 → 三卡指数块（A股 K线 / 港股 f[6] / 美股 f[1]）+ 卡脚渠道与取值日；
 *  2. marketStatus 交易日文案（交易日/周末周一分流，页面 note + 口播 spokenNote）；
 *  3. 收评锚定优先（发布日 == 行情取值日）→ 确定性出卡，不进 LLM；
 *  4. store.json 字段级落盘（stock_recap / stock_news 与 executive 共存，互不覆盖）；
 *  5. 股市消息清单：主板块去重 + 美股港股弱相关过滤（gzinfo P1④）；
 *  6. 口播股市段（buildStockSpoken 接入）：市场前缀含时区与交易日、板块要点纳入。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import { createContext } from "../lib/orchestrator";
import { setPersistenceBaseDir, writeExecStore } from "../lib/adapters/persistence";
import { buildStockRecap } from "../lib/pipeline/side-outputs/side-stock-recap";
import { buildStockNews } from "../lib/pipeline/side-outputs/side-stock-news";
import { assembleBriefingScript } from "../lib/services/voice";
import { computeMarketStatus, formatCnDate } from "../lib/services/market/market-status";
import type { HttpClient } from "../lib/contracts/pipeline";
import type { ArticleInput, CrawledArticle } from "../lib/contracts/article";
import type { DailyReport } from "../lib/contracts/report";
import type { ExecutiveSummary } from "../lib/services/enrich/executive-summary";
import { SilentLog } from "./helpers";

const TRADE_DAY = "2026-09-10"; // 周四（交易日）
const REPORT_DAY = "2026-09-11"; // 周五（交易日）
const CLOSED_DAY = "2026-09-14"; // 周一（休市时段）
const QUOTE_DAY = "2026-09-10";

/** 新浪 hq 文本：港股 f[3]=昨收 f[6]=收盘；美股 f[1]=收盘 f[2]=涨跌幅。 */
const HQ_TEXT = [
  `hq_str_hkHSI="hkHSI,恒生指数,18000.00,18100.00,18200.00,17900.00,18234.56,134.56,0.74,0,0,0,0,0,0,0,0,0,${QUOTE_DAY},16:08:00";`,
  `hq_str_hkHSTECH="hkHSTECH,恒生科技,5800.00,5700.00,5850.00,5650.00,5820.33,120.33,2.11,0,0,0,0,0,0,0,0,0,${QUOTE_DAY},16:08:00";`,
  `hq_str_gb_dji="道琼斯,45544.88,-0.20,45600.00,45700.00,45400.00,45544.88,0,0,0,0,0,0,0,0,0,${QUOTE_DAY},05:00:00";`,
  `hq_str_gb_ixic="纳斯达克,21000.00,0.35,20900.00,21100.00,20850.00,21000.00,0,0,0,0,0,0,0,0,0,${QUOTE_DAY},05:00:00";`,
  `hq_str_gb_inx="标普500,6500.00,0.10,6480.00,6520.00,6470.00,6500.00,0,0,0,0,0,0,0,0,0,${QUOTE_DAY},05:00:00";`,
].join("\n");

/** A股 K 线（日线）：目标日 + 前一交易日，用于涨跌幅计算。 */
const KLINE_JSON = JSON.stringify([
  { day: "2026-09-09", open: "3800.00", close: "3800.00", high: "3810.00", low: "3790.00", volume: "1" },
  { day: QUOTE_DAY, open: "3800.00", close: "3820.55", high: "3830.00", low: "3795.00", volume: "1" },
]);

/** 按 URL 分流的 HTTP fake（行情 hq / A股 K 线）。 */
const quoteHttp: HttpClient = {
  async getText(url: string): Promise<string> {
    if (url.includes("money.finance.sina.com.cn")) return KLINE_JSON;
    return HQ_TEXT;
  },
};

/** 行情取不到任何数据的 HTTP fake（验证降级：无 quotes 时仍不空卡）。 */
const deadHttp: HttpClient = {
  async getText(): Promise<string> {
    throw new Error("fetch failed 模拟网络故障");
  },
};

const stockArticle = (url: string, title: string, subcategory: string, excerpt = ""): ArticleInput =>
  ({
    sourceId: "crawler-stocks",
    source: "股市爬虫",
    title,
    url,
    category: "stocks",
    subcategory,
    publishedAt: new Date(`${QUOTE_DAY}T08:00:00Z`),
    excerpt: excerpt || title,
    isIpo: false,
  }) as ArticleInput;

const crawled = (items: Array<{ url: string; title: string; subcategory: string }>): { stocks: CrawledArticle[] } => ({
  stocks: items.map((it) => ({
    sourceId: "crawler-stocks",
    source: "股市爬虫",
    title: it.title,
    url: it.url,
    subcategory: it.subcategory,
    category: "stocks",
    publishedAt: `${QUOTE_DAY}T08:00:00+08:00`,
    excerpt: it.title,
  })) as CrawledArticle[],
});

function emptyReport(date = REPORT_DAY): DailyReport {
  return {
    date,
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  };
}

function mkCtx(date = REPORT_DAY, mode: "ai" | "skip-ai" = "ai") {
  return createContext({
    date,
    mode: mode === "ai" ? { kind: "ai" } : { kind: "skip-ai", summaryCache: new Map() },
    sources: [],
    log: new SilentLog(),
    // startTime 取「UTC 正午」：使其在 UTC 与 Asia/Shanghai 下日历日键都稳落在 date，
    // 避免固定 date + 依赖系统时区的时刻组合在跨时区 CI（UTC）下窗口/日期键漂移。
    startTime: new Date(`${date}T12:00:00Z`),
  });
}

/** 极简 LLM：返回美股卡（A股/港股由收评锚定确定性产出，不进 LLM）。 */
const llmStub = {
  async complete(): Promise<string> {
    return JSON.stringify({
      us: { overview: "美股三大指数涨跌互现", sectors: ["科技股走强：纳斯达克涨0.35%"], spoken: "美股涨跌互现。" },
    });
  },
};

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "gzinfols-b4-"));
  setPersistenceBaseDir(tmp);
  return fn(tmp).finally(() => {
    setPersistenceBaseDir(undefined);
    fsSync.rmSync(tmp, { recursive: true, force: true });
  });
}

test("B4-1 行情解析：A股走K线、港股取 f[6]、美股取 f[1]；卡脚渠道与取值日正确", async () => {
  await withTmp(async (tmp) => {
    const report = emptyReport();
    const articles: ArticleInput[] = [];
    const crawledStocks = crawled([
      { url: "https://example.com/hk1", title: "港股收评：恒指涨0.74% 恒生科技涨2.11% 科网股普涨", subcategory: "hk" },
      { url: "https://example.com/a1", title: "A股收评：科创50指数高开低走跌2.10% 算力产业链下挫", subcategory: "a-share" },
    ]);
    const ctx = mkCtx();
    const out = await buildStockRecap(report, articles, crawledStocks, ctx, { http: quoteHttp, llm: llmStub });

    assert.ok(out.stock_recap, "应产出 stock_recap");
    const recap = out.stock_recap!;
    assert.equal(recap.us.indices?.length, 3, "美股三指数应齐");
    assert.equal(recap.hk.indices?.length, 2, "港股两指数应齐");
    assert.equal(recap.aShare.indices?.length, 3, "A股三指数应齐（K线渠道）");
    assert.equal(recap.quoteDate, QUOTE_DAY, "取值日应为上一交易日");
    // 卡脚渠道（页面展示「数据来源：新浪行情 · 取值于 X」）
    assert.ok((recap.quoteChannel ?? "").includes("新浪"), "渠道应为新浪");
    // 港股 f[6]=收盘 → 点位与涨跌幅同源
    const hsi = recap.hk.indices!.find((i) => i.name === "恒生指数");
    assert.equal(hsi?.value, "18234.56");
    assert.equal(hsi?.changePct, "+0.74%");

    // 收评锚定：A股/港股均命中当日收评 → 确定性出卡（sectors 来自收评解析）
    assert.ok((recap.aShare.sectors.length ?? 0) >= 2, "A股应锚定收评解析出板块要点");
    assert.ok((recap.hk.sectors.length ?? 0) >= 2, "港股应锚定收评解析出板块要点");
    assert.ok(out.stock_recap!.us.overview.length > 0, "美股走 LLM 出 overview");
  });
});

test("B4-2 marketStatus：交易日 note 为空、spokenNote 带日期；周一（休市）note 给橙字警示", () => {
  const tradeDay = computeMarketStatus(REPORT_DAY, QUOTE_DAY);
  assert.equal(tradeDay.isMarketClosed, false);
  assert.equal(tradeDay.note, "", "交易日页面不显示休市警示");
  assert.ok(tradeDay.spokenNote?.includes(formatCnDate(QUOTE_DAY)), "口播恒带交易日日期");

  const closed = computeMarketStatus(CLOSED_DAY);
  assert.equal(closed.isMarketClosed, true, "周一早间属休市时段");
  assert.ok(closed.note?.includes("休市"), "休市警示文案");
  assert.ok(closed.spokenNote?.includes("休市时段"), "口播休市口径");
});

test("B4-3 store.json 字段级落盘：stock_recap 与 executive 共存互不覆盖", async () => {
  await withTmp(async (tmp) => {
    const exec: ExecutiveSummary = {
      hero_line: "今日关注：财富管理",
      must_read: [],
      insights: [],
    };
    writeExecStore(REPORT_DAY, exec);

    const ctx = mkCtx();
    const out = await buildStockRecap(
      emptyReport(),
      [],
      crawled([{ url: "https://example.com/a1", title: "A股收评：三大指数集体上涨", subcategory: "a-share" }]),
      ctx,
      { http: quoteHttp, llm: llmStub },
    );
    assert.ok(out.stock_recap, "AI 模式应写盘并返回三卡");

    const storePath = path.join(tmp, "history", REPORT_DAY, "store.json");
    assert.ok(fsSync.existsSync(storePath), "store.json 应落盘");
    const store = JSON.parse(fsSync.readFileSync(storePath, "utf8"));
    assert.ok(store.stock_recap, "stock_recap 字段应写入");
    assert.ok(store.executive, "executive 字段应保留（read-modify-write 不覆盖）");
  });
});

test("B4-4 SKIP_AI：复用 store.json 的 stock_recap，零 LLM 调用", async () => {
  await withTmp(async (tmp) => {
    const ctx = mkCtx();
    // 先 AI 模式落盘
    await buildStockRecap(
      emptyReport(),
      [],
      crawled([{ url: "https://example.com/a1", title: "A股收评：三大指数集体上涨", subcategory: "a-share" }]),
      ctx,
      { http: quoteHttp, llm: llmStub },
    );
    // 再 SKIP_AI 复用
    let llmCalls = 0;
    const countingLlm = {
      async complete(): Promise<string> {
        llmCalls++;
        throw new Error("SKIP_AI 不应调用 LLM");
      },
    };
    const skipCtx = mkCtx(REPORT_DAY, "skip-ai");
    const out = await buildStockRecap(emptyReport(), [], crawled([]), skipCtx, {
      http: quoteHttp,
      llm: countingLlm,
    });
    assert.equal(llmCalls, 0, "SKIP_AI 不得触发 LLM");
    assert.ok(out.stock_recap, "应复用 store.json 的 stock_recap");
  });
});

test("B4-5 股市消息清单：主板块去重 + 美股港股弱相关过滤 + 每市场上限", async () => {
  await withTmp(async () => {
    const report = emptyReport();
    // 主板块已出现同 url 的宏观条目 → 股市动态应剔除
    report.sections.policy_market = [
      {
        url: "https://example.com/macro",
        title_cn: "房贷期限延长至40年",
        source: "政策源",
        source_type: "official",
        date: "09/11",
        summary: "房贷政策调整。",
        importance: 3,
        rank: 1,
        tags: [],
        locale: "national",
      },
    ];
    const rawArticles: ArticleInput[] = [
      stockArticle("https://example.com/macro", "房贷期限延长至40年", "us", "房贷政策调整。"),
      stockArticle("https://example.com/us-good", "美联储降息预期升温 美股银行股集体走强", "us", "利率与银行板块。"),
      stockArticle("https://example.com/us-noise", "巴菲特96岁生日 市场关注其持仓", "us", "个人生活报道。"),
    ];
    const crawledStocks = crawled([
      { url: "https://example.com/a1", title: "A股收评：三大指数上涨 券商板块领涨", subcategory: "a-share" },
      { url: "https://example.com/hk1", title: "港股收评：恒指涨0.74% 北水净买入41亿", subcategory: "hk" },
    ]);
    const ctx = mkCtx();
    const out = await buildStockNews(report, rawArticles, crawledStocks, ctx, { llm: llmStub });

    assert.ok(out.stock_news, "应产出 stock_news");
    const news = out.stock_news!;
    assert.ok(!news.some((n) => n.url === "https://example.com/macro"), "主板块已出现的条目应剔除");
    assert.ok(!news.some((n) => n.url === "https://example.com/us-noise"), "美股弱相关（个人生活）应过滤");
    assert.ok(news.some((n) => n.url === "https://example.com/us-good"), "美股业务/市场相关应保留");
    assert.ok(news.some((n) => n.market === "a-share"), "A股主战场不过滤");
    assert.ok(news.every((n) => n.market !== "us" || n.locale === "overseas"), "美股 locale 应为 overseas");
  });
});

test("B4-6 口播股市段：市场前缀含时区与交易日、板块要点纳入（buildStockSpoken 接入）", async () => {
  // gzinfo 口径：口播只消费 exec 的 spoken_*（此处模拟 syncNarration 的确定性派生产物）
  const exec: ExecutiveSummary = {
    hero_line: "今日关注：零售信贷与财富管理",
    spoken_hero: "零售信贷与财富管理成为今日焦点，建议关注客群经营窗口。",
    spoken_insights: "具备零售A U M商机的，存款结构优化，值得关注。",
    must_read: [],
    insights: [],
  };
  const report = emptyReport();
  report.stock_recap = {
    us: { overview: "美股三大指数收跌", sectors: ["银行股走弱：受利率预期影响跌1.2%", "市场情绪"], spoken: "" },
    aShare: {
      overview: "沪指收报3820.55点（涨0.54%）",
      sectors: ["券商板块：主力资金净买入12亿元", "半导体板块：受政策提振走强"],
      spoken: "",
    },
    hk: { overview: "恒指收报18234.56点（涨0.74%）", sectors: ["科网股普涨：恒生科技涨2.11%"], spoken: "" },
    quoteChannel: "新浪行情",
    quoteDate: QUOTE_DAY,
    marketStatus: computeMarketStatus(REPORT_DAY, QUOTE_DAY),
  };
  const b = await assembleBriefingScript(report, { exec });
  assert.ok(b, "口播稿应生成");
  assert.ok(b.script.includes("下面是9月10日股市收盘信息"), "股市引导句应点明交易日");
  assert.ok(b.script.includes("A股（北京时间"), "A股前标北京时间");
  assert.ok(b.script.includes("美股（美东时间"), "美股前标美东时间");
  assert.ok(b.script.includes("券商"), "板块要点应进入口播（整体行情→重点板块）");
  assert.ok(!b.script.includes("市场情绪"), "空洞套话板块应被 buildStockSpoken 丢弃");
  assert.ok((b.parts.stock_recap?.length ?? 0) > 0, "段落 parts 应含 stock_recap");
  assert.ok(b.segments.some((s) => s.id === "stock"), "段落时序应含 stock 段");
});

test("B4-7 行情全失败降级：无 quotes 时仍不空卡（LLM 兜底/收评锚定路径）", async () => {
  await withTmp(async () => {
    const ctx = mkCtx();
    const out = await buildStockRecap(
      emptyReport(),
      [],
      crawled([{ url: "https://example.com/a1", title: "A股收评：三大指数集体上涨 券商领涨", subcategory: "a-share" }]),
      ctx,
      { http: deadHttp, llm: llmStub },
    );
    assert.ok(out.stock_recap, "行情失败也应产出三卡（不阻断整页）");
    assert.equal(out.stock_recap!.quoteChannel, undefined, "无行情 → 无渠道标注");
  });
});
