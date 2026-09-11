/**
 * 昨日股市复盘三卡（美股 / A股 / 港股）（PR4 引入）。
 *
 * 输入来自原始抓取（不经 PASS1 过滤，复盘参考区豁免漏斗）：
 * - 美股：rawArticles 中 category=stocks & subcategory=us
 * - A股：crawled.stocks 中 subcategory=a-share
 * - 港股：crawled.stocks 中 subcategory=hk
 *
 * 模式自适应：
 * - AI 模式：合并三市场 → fetchMarketQuotes（行情指数） → generateStockRecap → writeStore
 * - SKIP_AI 模式：仅从 store.json 复用，零 LLM；quotes 也不取（store 中已含指数）
 *
 * 失败优雅降级（无 recap → 页面不渲染该区，不阻断整页）。
 */

import type { ArticleInput } from "../../contracts/article";
import type { DailyReport } from "../../contracts/report";
import type { CrawledArticle } from "../../contracts/article";
import type { StockItem } from "../../contracts/market";
import type { PipelineContext, PipelineDeps } from "../../contracts/pipeline";
import {
  generateStockRecap,
  selectStockRecap,
  synthesizeFallbackCard,
  synthesizeRecapFromQuotes,
  findHkRecapReport,
} from "../../services/market/recap";
import { loadStockRecapStore, writeStockRecapStore } from "../../adapters/persistence";
import { makeMarketRunner } from "../../services/market/runner";
import { filterByWindow } from "../../utils/time";
import { fetchMarketQuotes, prevTradingDay } from "../../services/market/quotes";
import { computeMarketStatus, formatCnDate, formatCnDateShort } from "../../services/market/market-status";

interface CrawledSubset {
  stocks: CrawledArticle[];
}

function toStockItem(it: {
  title?: string;
  summary?: string;
  url?: string;
  source?: string;
  publishedAt?: Date | string;
}): StockItem {
  return {
    title: it.title || "无标题",
    summary: it.summary || "",
    url: it.url || "",
    source: it.source || "",
    publishedAt: it.publishedAt
      ? typeof it.publishedAt === "string"
        ? it.publishedAt.slice(0, 10)
        : new Date(it.publishedAt).toISOString().slice(0, 10)
      : undefined,
  };
}

/**
 * 生成股市复盘三卡并写入 report.stock_recap。
 * 返回新 report（不 mutate 入参）。失败返回原 report。
 */
export async function buildStockRecap(
  report: DailyReport,
  rawArticles: ArticleInput[],
  crawled: CrawledSubset,
  ctx: PipelineContext,
  deps: Pick<PipelineDeps, "http" | "llm">,
): Promise<DailyReport> {
  const date = ctx.date;
  const skipAi = ctx.mode.kind === "skip-ai";

  // 美股：用 fetchAll 原始快照（未受全局 2 天窗口过滤），本地 4 天窗口兜底防陈旧。
  // 保证周一/节后首跑也能取到「上一美股交易日」的收盘复盘。
  const usItems: StockItem[] = filterByWindow(
    rawArticles.filter((a) => a.category === "stocks" && a.subcategory === "us"),
    4,
  ).map(toStockItem);
  const aShareItems: StockItem[] = crawled.stocks
    .filter((a) => a.subcategory === "a-share")
    .map(toStockItem);
  const hkItems: StockItem[] = crawled.stocks
    .filter((a) => a.subcategory === "hk")
    .map(toStockItem);

  const persistedRecap = loadStockRecapStore(date);
  // 行情指数（新浪行情 API）：取「上一交易日」收盘精确点位 + 涨跌幅；
  // 失败优雅降级（quotes=null → 三卡缺指数块，不阻断整页）。
  // 2026-08-27 修：SKIP_AI 也拉指数（fetchMarketQuotes 不调 LLM，仅 HTTP），
  // 让 synthesizeFallbackCard 在 SKIP_AI 也能用指数合成空卡 → 港股/A股永不空。
  const quotes = await fetchMarketQuotes(prevTradingDay(date), deps.http);

  try {
    let recap = await selectStockRecap({
      skipAi,
      persisted: persistedRecap,
      generate: () =>
        generateStockRecap(
          { date, us: usItems, aShare: aShareItems, hk: hkItems },
          quotes,
          makeMarketRunner(deps.llm),
        ),
    });
    // 2026-09-01 修（股市板块初始化失败根因）：
    // SKIP_AI 当日首次运行无 store.json → persisted=undefined → selectStockRecap 返回 null；
    // AI 模式下 generateStockRecap 内 LLM 失败也返回 null。两者均导致股市解读区整区不渲染。
    // 此时行情 quotes 已成功拉到 → 用指数合成最小复盘三卡（overview=指数点位+涨跌幅），
    // 让「收盘点位+涨跌幅」筹码在 SKIP_AI 无缓存 / AI 失败两种场景下都展示完整。
    if (!recap && quotes) {
      recap = synthesizeRecapFromQuotes(quotes);
      ctx.log.info(
        "recap",
        `📈 股市复盘：无 AI 产物，用行情指数合成最小复盘三卡（A股 ${recap.aShare.overview ? 1 : 0} / 港股 ${recap.hk.overview ? 1 : 0} / 美股 ${recap.us.overview ? 1 : 0}）`,
      );
    }
    if (!recap) {
      ctx.log.info("recap", "ℹ️ 股市复盘无可用输入或生成失败（跳过该区）");
      return report;
    }
    // 2026-08-27 修：selectStockRecap 在 LLM 模式优先用 persisted（绕过了 generate 内的
    // synthesizeFallbackCard）。这里对任何空卡**始终**应用指数兜底 — 即使 persisted
    // 里的 hk/us/aShare 仍空、quotes 有数据，也用指数合成最小复盘。
    if (quotes) {
      recap.us = synthesizeFallbackCard(recap.us, quotes.quotes.us) ?? recap.us;
      recap.aShare = synthesizeFallbackCard(recap.aShare, quotes.quotes.aShare) ?? recap.aShare;
      recap.hk = synthesizeFallbackCard(recap.hk, quotes.quotes.hk) ?? recap.hk;
    }
    // 港股大盘解读权威源：无论 AI/SKIP_AI，均从 hkItems 锚定新浪财经等收评/总结报告，
    // 卡内展示「直接看原报告」入口（2026-08-29 用户：港股大盘解读应以此为准）。
    recap.hk.sourceReport = findHkRecapReport(hkItems);
    // SKIP_AI 复用 store 时 store 里可能没存指数块 → 用本次抓取的 quotes 补齐，
    // 保证「收盘点位 + 涨跌幅」筹码在三种模式下都展示完整（2026-08-29）。
    if (quotes) {
      recap.us.indices = recap.us.indices ?? quotes.quotes.us;
      recap.aShare.indices = recap.aShare.indices ?? quotes.quotes.aShare;
      recap.hk.indices = recap.hk.indices ?? quotes.quotes.hk;
      recap.quoteChannel = recap.quoteChannel ?? quotes.channel;
      recap.quoteDate = recap.quoteDate ?? quotes.date;
    }
    // 2026-08-30 用户：周末/周一报告标注股市数据为上一交易日收盘。
    // 2026-09-03 修：必须在 writeStockRecap **之前**算好 —— 原实现写在写盘之后，
    // 导致 marketStatus 永远进不了 store.json，SKIP_AI 复用与口播侧拿到的都是 undefined，
    // 口播只剩「A股：」而丢掉「（北京时间9月2日 周三收盘）」标注。
    recap.marketStatus = computeMarketStatus(date, quotes?.date);
    if (!skipAi) {
      writeStockRecapStore(date, recap);
      ctx.log.info(
        "recap",
        `📈 股市复盘三卡生成：美股 ${usItems.length} / A股 ${aShareItems.length} / 港股 ${hkItems.length} 条输入`,
      );
    } else if (persistedRecap) {
      ctx.log.info("recap", "📈 SKIP_AI 复用 store.json 股市复盘三卡");
    }
    return { ...report, stock_recap: recap };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.log.warn("recap", `⚠️ 股市复盘生成失败（继续）: ${msg}`);
    return report;
  }
}
