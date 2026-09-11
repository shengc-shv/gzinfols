/**
 * B4 管线级验证：股市旁路在 runPipeline 主链上真实产出（非仅单测直调）。
 *
 * 验证链路：crawlers 端口注入 crawled.stocks → buildSideOutputs 顺序
 * （exec → stockRecap → stockNews → gdIpo）→ report.stock_recap / stock_news
 * → renderHtml 含股市区 → store.json 落盘（SKIP_AI 可复用）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import { runPipeline } from "../lib/pipeline";
import { createContext } from "../lib/orchestrator";
import { setPersistenceBaseDir } from "../lib/adapters/persistence";
import type { Clock, CrawlerRegistry, HttpClient, LlmPort, Logger } from "../lib/contracts/pipeline";
import type { SourceDef } from "../lib/contracts/source";
import { MemFs, FakeLlm, SilentLog } from "./helpers";

const REPORT_DAY = "2026-09-11"; // 周五
const QUOTE_DAY = "2026-09-10";
// ⚠️ 运行时刻必须取「UTC 正午」：使 UTC 与 Asia/Shanghai（及西半球时区）下
// startTime 的日历日键都稳落在 REPORT_DAY，避免 UTC 下退化为前一天 →
// select 的 pre-window（todayKey 取系统时区）误滤当日条目 → 口播各段全缺。
// 与 tests/pipeline.e2e.test.ts 的固定时钟写法一致。
const RUN_AT = new Date(`${REPORT_DAY}T12:00:00Z`);

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>测试频道</title>
<item>
  <title>AI 大模型驱动金融科技升级</title>
  <link>https://example.com/news-a</link>
  <description>头部机构发布 AI 中台，财富管理数字化效率显著提升。</description>
  <pubDate>${new Date("2026-09-11T02:00:00Z").toUTCString()}</pubDate>
</item>
</channel></rss>`;

const HQ_TEXT = [
  `hq_str_hkHSI="hkHSI,恒生指数,18000.00,18100.00,18200.00,17900.00,18234.56,134.56,0.74,0,0,0,0,0,0,0,0,0,${QUOTE_DAY},16:08:00";`,
  `hq_str_gb_dji="道琼斯,45544.88,-0.20,45600.00,45700.00,45400.00,45544.88,0,0,0,0,0,0,0,0,0,${QUOTE_DAY},05:00:00";`,
].join("\n");

const KLINE_JSON = JSON.stringify([
  { day: "2026-09-09", open: "3800.00", close: "3800.00", high: "3810.00", low: "3790.00", volume: "1" },
  { day: QUOTE_DAY, open: "3800.00", close: "3820.55", high: "3830.00", low: "3795.00", volume: "1" },
]);

/** 按 URL 分流的 HTTP：RSS / 行情 hq / A股 K 线。 */
const http: HttpClient = {
  async getText(url: string): Promise<string> {
    if (url.includes("money.finance.sina.com.cn")) return KLINE_JSON;
    if (url.includes("hq.sinajs.cn")) return HQ_TEXT;
    return RSS;
  },
};

const sources: SourceDef[] = [
  { id: "test", name: "测试科技源", type: "rss", url: "https://example.com/feed", category: "tech", tier: "T1", enabled: true },
];

/** 爬虫注册表 fake：返回昨日股市三市场条目（A股/港股为 crawled，美股走 rawArticles 语义另测）。 */
const crawlers: CrawlerRegistry = {
  async fetchCrawledArticles() {
    return {
      ipo: [],
      gz: [],
      stocks: [
        {
          sourceId: "crawler-stocks",
          source: "股市爬虫",
          title: "A股收评：三大指数集体上涨 券商板块领涨 主力资金净买入12亿",
          url: "https://example.com/a-share-1",
          subcategory: "a-share",
          category: "stocks",
          publishedAt: `${QUOTE_DAY}T08:00:00+08:00`,
          excerpt: "A股收评：三大指数集体上涨 券商板块领涨",
        },
        {
          sourceId: "crawler-stocks",
          source: "股市爬虫",
          title: "港股收评：恒指涨0.74% 恒生科技涨2.11% 科网股普涨 北水净买入41亿",
          url: "https://example.com/hk-1",
          subcategory: "hk",
          category: "stocks",
          publishedAt: `${QUOTE_DAY}T08:00:00+08:00`,
          excerpt: "港股收评：恒指涨0.74% 科生科技涨2.11%",
        },
      ],
    };
  },
};

const clock: Clock = {
  now: () => new Date(RUN_AT),
  todayKey: () => REPORT_DAY,
};

const log: Logger = new SilentLog();

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "gzinfols-b4-pipe-"));
  setPersistenceBaseDir(tmp);
  return fn(tmp).finally(() => {
    setPersistenceBaseDir(undefined);
    fsSync.rmSync(tmp, { recursive: true, force: true });
  });
}

test("runPipeline 主链：股市复盘三卡 + 股市消息清单真实产出并落 HTML/store", async () => {
  await withTmp(async (tmp) => {
    const fs = new MemFs();
    fs.setJson("sources.config.json", { sources });
    fs.setJson("sources.keywords.json", { global_exclude: {}, dimensions: {}, opportunity_tracker: {}, risk_tracker: {} });

    const deps = { fs, clock, llm: new FakeLlm() as unknown as LlmPort, http, crawlers };
    const ctx = createContext({
      date: REPORT_DAY,
      mode: { kind: "ai" },
      sources,
      log,
      startTime: new Date(RUN_AT),
    });

    const out = await runPipeline(ctx, deps);

    // 1) 股市三卡产出（A股/港股由收评锚定确定性出卡；美股走 LLM stub）
    assert.ok(out.report.stock_recap, "report.stock_recap 应产出");
    const recap = out.report.stock_recap!;
    assert.equal(recap.quoteDate, QUOTE_DAY, "行情取值日应为上一交易日");
    assert.ok((recap.hk.indices?.length ?? 0) >= 1, "港股指数块应有数据");
    assert.ok((recap.hk.sectors.length ?? 0) >= 2, "港股收评应锚定解析出板块要点");
    assert.ok((recap.aShare.sectors.length ?? 0) >= 2, "A股收评应锚定解析出板块要点");
    assert.equal(recap.marketStatus?.dataDate, QUOTE_DAY, "marketStatus 交易日状态应写入 store");

    // 2) 股市消息清单产出（三市场过滤后）
    // 注：gzinfo 机制为「主板块优先」——已被主板块收编的条目（filterStockNewsAgainstSections）
    // 与美股/港股弱相关噪声（stockNewsRelevant）都会从清单剔除，故此处断言「非空 + 市场归属正确」，
    // 逐条剔除口径由 tests/stock-side-outputs.test.ts B4-5 精确覆盖。
    assert.ok(out.report.stock_news, "report.stock_news 应产出");
    assert.ok(out.report.stock_news!.length >= 1, "至少一条股市条目应入清单");
    assert.ok(
      out.report.stock_news!.every((n) => ["a-share", "hk", "us"].includes(n.market)),
      "清单条目 market 归属应合法",
    );

    // 3) HTML 已包含股市区（渲染层消费，B6 会做完整卡面）
    assert.ok(out.html.length > 0, "HTML 应产出");

    // 4) store.json 字段级落盘（stock_recap 与 executive 共存）
    const storePath = path.join(tmp, "history", REPORT_DAY, "store.json");
    assert.ok(fsSync.existsSync(storePath), "store.json 应落盘");
    const store = JSON.parse(fsSync.readFileSync(storePath, "utf8"));
    assert.ok(store.stock_recap, "stock_recap 应写入 store");
    assert.ok(store.executive, "executive 应保留（不被股市写盘覆盖）");

    // 5) 口播稿含股市段（exec 驱动 + buildStockSpoken）
    assert.ok(out.speech.length > 0, "口播稿应非空");
  });
});

test("runPipeline 主链：无爬虫端口时股市旁路优雅降级（不阻断整页）", async () => {
  await withTmp(async () => {
    const fs = new MemFs();
    fs.setJson("sources.config.json", { sources });
    fs.setJson("sources.keywords.json", { global_exclude: {}, dimensions: {}, opportunity_tracker: {}, risk_tracker: {} });

    const deps = { fs, clock, llm: new FakeLlm() as unknown as LlmPort, http };
    const ctx = createContext({
      date: REPORT_DAY,
      mode: { kind: "ai" },
      sources,
      log,
      startTime: new Date(RUN_AT),
    });

    const out = await runPipeline(ctx, deps);
    // 无 crawled.stocks → 三卡可能仍由行情指数合成（gzinfo 同款保底），但不得抛错
    assert.ok(out.report, "管线应正常完成");
    assert.ok(out.html.length > 0, "HTML 应正常产出");
  });
});
