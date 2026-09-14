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
import type { DailyReport, RenderInjection } from "../../contracts/report";
import type { AudioMeta } from "../voice";
import {
  renderHtml as renderHtmlFull,
  renderMarkdown as renderMarkdownFull,
} from "./full";

export * from "./full";
export { setReportLocale, REPORT_LOCALE } from "./locale";

/**
 * 渲染入口（兼容包装）。
 *
 * 2026-09-14 P0-4：分享基址 / Web 模式 / 渲染时刻改为**注入**（服务层不读 env、不读隐式时钟）。
 * 缺省时：不输出 og:image、不渲染归档链接、不显示「数据截至 时刻」——宁可缺项，不误导。
 */
export function renderHtml(
  report: DailyReport,
  opts: RenderInjection & { audio?: AudioMeta } = {},
): string {
  return renderHtmlFull(report, report.date, opts);
}

export function renderMarkdown(report: DailyReport): string {
  return renderMarkdownFull(report, report.date);
}
