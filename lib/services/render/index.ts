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
import { assignItemIds } from "../assemble/item-id";
import { stripCryptoNews } from "../assemble/safety";
import { recalibrateImportance } from "../assemble/importance";

export * from "./full";
// A2 站内详情页（renderDetailPage / detailPagesOf / detailHrefOf）
export * from "./detail";
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
  // A2（2026-09-16）：渲染前**统一**补齐条目 ID（幂等、不 mutate 入参）。
  // 放在这里而不是各个入口脚本，是为了让所有渲染路径（管线 / scripts/render.ts /
  // render-live.ts / 测试）都拿到 id —— 卡片据此链到站内详情页 `i/<id>.html`。
  // 老报告（JSON 无 id）重渲染时会被补上；已有 id 的一律保留（链接不变）。
  // 顺序：红线过滤（加密零容忍）→ A1b 重要度重标定 → 补条目 ID。
  // 三者都是幂等纯函数，放在渲染入口可覆盖「本次渲染」与「老报告重渲染」两条路径。
  const prepared = assignItemIds(recalibrateImportance(stripCryptoNews(report)));
  return renderHtmlFull(prepared, report.date, opts);
}

export function renderMarkdown(report: DailyReport): string {
  return renderMarkdownFull(report, report.date);
}
