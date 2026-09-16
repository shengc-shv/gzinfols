/**
 * 站内详情页（A2，2026-09-16）——「点开不跳外链、上下文不丢」。
 *
 * 定位：每条条目一页 `site/<date>/i/<itemId>.html`，构建期生成、**零 LLM**。
 *  - **外链降为次级出口**：卡片点开先进站内详情页，原文链接在详情页内（二次点击）；
 *  - **返回即回到原位**：返回链接带 `#<itemId>` 锚点，回到报告页并定位到该卡片；
 *    配合报告页的滚动位置记忆（sessionStorage）可精确还原阅读位置；
 *  - **是二期的落点**：B1 检索 / A3 增量 / B2 时间线 / C1 客群视图 / E2 导出都指向本页，
 *    故 URL 必须稳定可寻址（依赖 A2 的条目 ID 契约）。
 *
 * 纯函数、无 IO：只产 HTML 字符串，写盘由 scripts 负责（渲染层不碰 fs）。
 */
import type { DailyReport, ReportItem, ReportSectionKey } from "../../contracts/report";
import { itemIdOf } from "../../utils/item-id";
import { escapeHtml } from "./cards";
import { THEME_CSS } from "./theme";
import { stripCssComments } from "./css";

/** 板块中文名（与报告页筛选栏同款文案）。 */
const SECTION_LABEL: Record<ReportSectionKey, string> = {
  gz_local: "广州本地",
  biz_insight: "业务启示",
  policy_market: "政策与市场",
  tech: "科技前沿",
  ipo: "IPO 动态",
};

const IMPORTANCE_LABEL: Record<number, string> = {
  3: "今日必知",
  2: "默认",
  1: "折叠",
};

const LOCALE_LABEL: Record<string, string> = {
  gz: "广州",
  national: "全国",
  overseas: "境外",
};

/** 详情页相对路径（相对 `site/<date>/`）：`i/<itemId>.html`。 */
export function detailHrefOf(item: Pick<ReportItem, "id" | "url">): string {
  const id = item.id ?? itemIdOf(item.url);
  return `i/${id}.html`;
}

/**
 * 渲染单个条目的详情页。
 *
 * @param report 所属报告（提供日期与返回链接）
 * @param item 条目
 * @param section 所属板块键
 */
export function renderDetailPage(
  report: DailyReport,
  item: ReportItem,
  section: ReportSectionKey,
): string {
  const id = item.id ?? itemIdOf(item.url);
  const title = item.title_cn || item.title_orig || "(无标题)";
  const back = `../${report.date}.html#${id}`;
  const summary = (item.summary || "").trim();

  const kv: Array<[string, string]> = [
    ["来源", item.source + (item.tier ? ` · ${item.tier}` : "")],
    ["发布", item.date],
    ["板块", SECTION_LABEL[section] ?? section],
    ["重要度", IMPORTANCE_LABEL[item.importance] ?? String(item.importance)],
    ["地域", LOCALE_LABEL[item.locale] ?? item.locale],
    ["标签", (item.tags ?? []).length ? (item.tags ?? []).join(" / ") : "—"],
  ];
  // IPO 附加结构化字段（有才渲染，不编造）
  if (item.ipoStage) kv.push(["IPO 阶段", item.ipoStage]);
  if (item.ipoCity) kv.push(["企业属地", item.ipoCity]);
  if (item.ipoMeta) kv.push(["保荐/板块/受理", item.ipoMeta]);

  const kvHtml = kv
    .map(
      ([k, v]) =>
        `      <div class="kv-row"><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`,
    )
    .join("\n");

  const origTitle = item.title_orig && item.title_orig !== title ? item.title_orig : "";

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(report.date)}</title>
<meta name="robots" content="noindex">
<style>
${stripCssComments(THEME_CSS)}
  body { max-width: 46rem; margin: 0 auto; padding: 1.5rem 1.1rem 3rem; }
  .back { display: inline-block; margin-bottom: 1rem; font-size: .82rem; color: var(--fg-soft); text-decoration: none; }
  .back:hover { text-decoration: underline; }
  h1 { font-size: 1.15rem; line-height: 1.55; margin: 0 0 .7rem; }
  .orig { font-size: .78rem; color: var(--muted); margin: -.3rem 0 .8rem; }
  .summary { font-size: .92rem; line-height: 1.85; margin: 0 0 1.2rem; color: var(--fg); }
  .kv { margin: 0 0 1.3rem; border-top: 1px solid var(--rule); }
  .kv-row { display: flex; gap: .8rem; padding: .45rem 0; border-bottom: 1px solid var(--rule); font-size: .82rem; }
  .kv-row dt { flex: 0 0 6.5rem; color: var(--muted); }
  .kv-row dd { margin: 0; color: var(--fg); }
  .origin { margin-top: 1.4rem; font-size: .85rem; }
  .origin a { color: var(--c-link, #2f4cdd); }
  .note { margin-top: 1.6rem; font-size: .74rem; color: var(--muted); line-height: 1.7; }
</style></head>
<body>
  <a class="back" href="${escapeHtml(back)}">← 返回 ${escapeHtml(report.date)} 简报</a>
  <h1>${escapeHtml(title)}</h1>
  ${origTitle ? `<p class="orig">${escapeHtml(origTitle)}</p>` : ""}
  ${summary ? `<p class="summary">${escapeHtml(summary)}</p>` : ""}
  <dl class="kv">
${kvHtml}
  </dl>
  ${
    item.url
      ? `<p class="origin">原文：<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.source || "打开来源")}</a>（新窗口打开）</p>`
      : ""
  }
  <p class="note">本页为简报条目的站内上下文视图，内容摘录自公开来源；完整原文请以上方链接为准。</p>
</body>
</html>`;
}

/** 生成某期报告的全部详情页（[{ 文件名, html }]；不含 IO）。 */
export function detailPagesOf(
  report: DailyReport,
): Array<{ id: string; html: string }> {
  const out: Array<{ id: string; html: string }> = [];
  for (const key of Object.keys(report.sections ?? {}) as ReportSectionKey[]) {
    for (const it of report.sections[key] ?? []) {
      const id = it.id ?? itemIdOf(it.url);
      out.push({ id, html: renderDetailPage(report, it, key) });
    }
  }
  return out;
}
