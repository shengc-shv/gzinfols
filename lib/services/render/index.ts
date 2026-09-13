/**
 * 渲染服务出口（C7）。
 *
 * 2026-09-13 B6 渲染全量对齐：轻量版（280 行）退役，切换为 gzinfo render.ts
 * 逐字移植的完整版面（full.ts ≈ 2117 行 + theme/i18n/cards/sections 子模块）。
 * 旧轻量版签名 renderHtml(report, opts) 由本文件的兼容包装保留——
 * 调用方（pipeline / scripts/render.ts / 测试）无需感知 date 参数。
 *
 * REPORT_LOCALE：默认 zh；如需 en，由入口脚本调 `setReportLocale(env.REPORT_LOCALE)`。
 */
import type { DailyReport } from "../../contracts/report";
import type { AudioMeta } from "../voice";
import {
  renderHtml as renderHtmlFull,
  renderMarkdown as renderMarkdownFull,
} from "./full";

export * from "./full";
export { setReportLocale, REPORT_LOCALE } from "./locale";

export function renderHtml(
  report: DailyReport,
  opts: { audio?: AudioMeta } = {},
): string {
  return renderHtmlFull(report, report.date, opts);
}

export function renderMarkdown(report: DailyReport): string {
  return renderMarkdownFull(report, report.date);
}
