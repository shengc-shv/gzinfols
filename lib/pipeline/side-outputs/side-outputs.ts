/**
 * 三个旁路编排（PR4 引入 + B-1）。
 *
 * 顺序：
 * 1. 必读/商机（hero_line + must_read + insights）—— 最高优先级
 * 2. 股市复盘三卡（stock_recap）—— 输入来自 rawArticles + crawled
 * 3. 股市消息清单（stock_news）—— 底部面板
 *
 * 每个 stage 返回新 report（非破坏性）；main 中可链式调用。
 *
 * B-1：filterResults（url → FilterResult）从 keyword-funnel 透传到 executive-summary，
 * 让 LLM 知道哪些文章已被关键词层标为风险候选，避免漏掉明显风险。
 */

import type { ArticleInput } from "../../contracts/article";
import type { DailyReport } from "../../contracts/report";
import type { HistoryStore } from "../../services/memory/history";
import type { FilterResult, PipelineContext, PipelineDeps } from "../../contracts/pipeline";
import type { IngestResult } from "../../contracts/pipeline";

import { buildExecutiveSummary } from "./side-exec-summary";
// 股市复盘三卡 / 股市消息清单：B4 接入（依赖 trading 模块移植）

import { buildGdIpo } from "./side-gd-ipo";

/**
 * 执行三个旁路，返回最终 report。
 * history 在主流程中由调用方管理（saveHistory 返回新 store 后回传）。
 * filterResults（B-1）可选，缺省时 executive-summary 不传 risk_candidates 给 LLM。
 */
export async function buildSideOutputs(
  mergedReport: DailyReport,
  history: HistoryStore,
  filteredArticles: ArticleInput[],
  rawArticles: ArticleInput[],
  crawled: IngestResult["crawled"],
  ctx: PipelineContext,
  filterResults: Map<string, FilterResult> | undefined,
  deps?: Pick<PipelineDeps, "llm">,
): Promise<DailyReport> {
  // 1. 必读 / 商机
  let report = await buildExecutiveSummary(mergedReport, history, filteredArticles, ctx, filterResults, deps);
  // 2. 股市复盘三卡（B4：buildStockRecap）
  // 3. 股市消息清单（B4：buildStockNews）
  // 4. 广东地区IPO（绕过相关性 LLM，直接从 filteredArticles 构建，gzinfo 2026-08-30 实跑修复）
  report = buildGdIpo(report, filteredArticles, ctx);
  return report;
}
