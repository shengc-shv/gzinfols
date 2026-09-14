/**
 * 单条报告卡渲染（正文卡 / 折折叠列表的原子单元）。
 *
 * 2026-09-14（C-1 Phase1）：自 `full.ts` **纯搬移**（行为零变化）。抽出原因是
 * `ipo-panel.ts` 需要它 —— 若留在 full.ts 会与「full 反向 re-export 子模块」形成环。
 */
import { escapeHtml } from "./cards";
import { STR } from "./i18n";
import { tagClsOf, MARKET_BADGE, capSummary, relativeDayLabel } from "./atoms";
import type { ReportItem } from "../../contracts/report";

export function renderReportItemHtml(
  item: ReportItem,
  showSource = true,
  stage?: string,
  progressHtml?: string,
): string {
  const title = escapeHtml(item.title_cn || item.title_orig || "");
  const url = escapeHtml(item.url);
  const isIpo = stage !== undefined;
  // IPO 卡优先用结构化 ipoMeta（爬虫字段平铺），其余卡片沿用「摘要首句 ≤50 字」
  const bodyText = isIpo && item.ipoMeta ? item.ipoMeta : item.summary || "";
  const summary = bodyText ? escapeHtml(isIpo && item.ipoMeta ? bodyText : capSummary(bodyText)) : "";
  const rel = isIpo ? relativeDayLabel(item.date) : "";
  const time = item.date ? escapeHtml(rel ? `${item.date} · ${rel}` : item.date) : "";
  const official = item.source_type === "official";
  const badge = official ? { label: "官方", cls: "src-official" } : { label: "媒体", cls: "src-media" };
  const tags = (item.tags ?? [])
    .map((t) => {
      // IPO 卡片：把「粤」地域标记的显示文案替换为注册城市（ipoCity），保留 t-gd 样式；
      // 其它板块（gz_local 等）的「粤」标无 ipoCity 字段，原样展示，不受影响。
      const label = t === "粤" && item.ipoCity ? item.ipoCity : t;
      return `<span class="tag ${tagClsOf(t)}">${escapeHtml(label)}</span>`;
    })
    .join("");
  const mkt = item.market ? MARKET_BADGE[item.market] : undefined;
  const mktBadge = mkt ? `<span class="mkt-badge ${mkt.cls}">${mkt.label}</span>` : "";
  // P2-2 双链接：主链接（列表页）+ 交易所/监管官方源入口（人工核查用）
  const officialSrc =
    isIpo && item.officialUrl
      ? `<p class="official-src">官方源：<a href="${escapeHtml(item.officialUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.officialLabel || item.officialUrl)}</a></p>`
      : "";
  return `<article class="brief${item.importance === 3 ? " must" : ""}" data-source="${item.source_type}" data-tags="${(item.tags ?? []).join(" ")}" data-market="${escapeHtml(item.market ?? "")}" data-stage="${escapeHtml(stage ?? "")}">
  <div class="bm">${mktBadge}<span class="src-badge ${badge.cls}">${badge.label}</span>${showSource && item.source ? `<span>${escapeHtml(item.source)}</span>` : ""}${time ? `<span>${time}</span>` : ""}${item.importance === 3 ? `<span class="imp-badge">必知</span>` : ""}</div>
  <h3><a href="${url}" target="_blank" rel="noopener noreferrer">${title}</a></h3>
  ${summary ? `<p class="sum">${summary}</p>` : ""}
  ${progressHtml ?? ""}
  ${officialSrc}
  ${tags ? `<div class="tags">${tags}</div>` : ""}
</article>`;
}

/** 4 大零售部门标签（2026-08-22 用户：无这 4 个标签的条目排最后，优先展示带标签的）。 */
export const DEPT_TAGS = new Set(["财富", "私行", "客群", "信贷"]);

export function renderReportCardList(
  items: ReportItem[],
  showSource = true,
): string {
  if (items.length === 0) return `<p class="empty">${STR.emptySource}</p>`;
  // 稳定排序：带 4 部门零售标签的排前，无标签的沉底（同组内保持原顺序：今日 rank / 时间）。
  const hasTag = (it: ReportItem): number =>
    (it.tags ?? []).some((t) => DEPT_TAGS.has(t)) ? 0 : 1;
  const sorted = [...items].sort((a, b) => hasTag(a) - hasTag(b));
  const top = sorted.slice(0, 5);
  const more = sorted.slice(5);
  let html = top.map((a) => renderReportItemHtml(a, showSource)).join("\n");
  if (more.length > 0) {
    html +=
      more
        .map((a) => renderReportItemHtml(a, showSource).replace('<article class="brief', '<article class="brief more'))
        .join("\n") +
      `<button class="expand-btn" type="button">展开其余 ${more.length} 条</button>`;
  }
  return html;
}
