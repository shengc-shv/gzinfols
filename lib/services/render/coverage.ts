/**
 * 覆盖度与来源分布区块（A5 数据戳颗粒度 + F3 板块权重治理，2026-09-16 用户批准）。
 *
 * 目的：让读者**看见**内容覆盖的真实形态，而不是靠猜——
 *   · 板块：五板块 + 股市动态的实际条数；**0 条板块显式标注「本期无」**（F3：不凑数、不静默消失）；
 *   · 来源：每源「抓取 → 收录」条数与保留条目均分（A5）；**抓取为 0 的已启用源显式列出**（缺失源可见）。
 *
 * 折叠在 `<details>` 内、默认收起：不占首屏注意力，但一键可查（「引用得出手」的可信度支撑）。
 * 渲染层零判定：数据全部来自 `report.sourceStats`（select 漏斗同一次统计）与调用方传入的板块计数。
 */
import type { DailyReport } from "../../contracts/report";
import { escapeHtml } from "./cards";

export function renderCoverage(
  report: DailyReport,
  sectionCounts: Array<[string, number]>,
): string {
  const stats = report.sourceStats ?? [];

  const sections = sectionCounts
    .map(([label, n]) =>
      n > 0
        ? `<li><span class="cov-k">${escapeHtml(label)}</span><span class="cov-v">${n} 条</span></li>`
        : `<li class="cov-zero"><span class="cov-k">${escapeHtml(label)}</span><span class="cov-v">本期无</span></li>`,
    )
    .join("");

  const withData = stats.filter((s) => s.inflow > 0);
  const missing = stats.filter((s) => s.inflow === 0);
  const srcRows = withData
    .map(
      (s) =>
        `<li><span class="cov-k">${escapeHtml(s.sourceId)}</span>` +
        `<span class="cov-v">${s.inflow} → ${s.kept}${s.avgScore === null ? "" : ` · 均分 ${s.avgScore}`}</span></li>`,
    )
    .join("");
  const missingRow = missing.length
    ? `<p class="cov-note cov-missing">本期未采集到内容的已启用源：${missing
        .map((s) => escapeHtml(s.sourceId))
        .join("、")}</p>`
    : "";
  const noSrc = stats.length === 0;

  return `<details class="coverage">
    <summary>覆盖度与来源分布</summary>
    <div class="cov-grid">
      <div class="cov-col"><h4>板块条数</h4><ul>${sections}</ul></div>
      ${noSrc ? "" : `<div class="cov-col"><h4>来源（抓取 → 收录）</h4><ul>${srcRows}</ul></div>`}
    </div>
    ${noSrc ? `<p class="cov-note">本期未记录来源分布（该能力自 2026-09-16 起生效，历史期次无此数据）。</p>` : missingRow}
    <p class="cov-note">「收录」＝经时间窗、跨天判重、相关性漏斗后进入本期的条数；标「本期无」的板块是<strong>确实没有</strong>，不是漏采。</p>
  </details>`;
}
