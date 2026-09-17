/**
 * 红筹线索面板（plan-redchip-crawl-push §5.1）。
 *
 * 独立于五板块 tab 的常驻区块：tab 只收录「已匹配到 IPO 卡片」的红筹条目，
 * 而**匹配失败的线索**（T7）只能在面板里被看到 —— 否则线索会静默消失。
 * 渲染层不重新判定任何东西：文案/字段全部来自服务层产出的 `RedchipPanel`。
 */
import type { RedchipPanel, RedchipPanelEntry } from "../../contracts/redchip";
import { escapeHtml } from "./cards";

/** VIE 状态文案（仅画像，不参与判定）。 */
const VIE_LABEL: Record<string, string> = {
  current: "存在 VIE 架构",
  historical: "曾有 VIE（已终止）",
  none: "无 VIE",
  unverified: "VIE 未核验",
};

function itemHtml(e: RedchipPanelEntry): string {
  const facts: string[] = [];
  if (e.board) facts.push(escapeHtml(e.board));
  if (e.status) facts.push(escapeHtml(e.status));
  if (e.submitDate) facts.push(`递表 ${escapeHtml(e.submitDate)}`);

  const evidence: string[] = [];
  if (e.domicile) evidence.push(`注册地 ${escapeHtml(e.domicile)}`);
  evidence.push(`广东运营命中 ${e.gdCityHits}`);
  evidence.push(VIE_LABEL[e.vie] ?? "VIE 未核验");

  const report = e.reportUrl
    ? `<a class="ipo-report" href="${escapeHtml(e.reportUrl)}" target="_blank" rel="noopener">穿透分析报告（会前版本） →</a>`
    : "";
  const source = e.sourceUrl
    ? `<a class="ipo-src" href="${escapeHtml(e.sourceUrl)}" target="_blank" rel="noopener">申请版本 PDF</a>`
    : "";

  return `<li class="redchip-item redchip-item--${e.verdict}">
      <div class="redchip-head">
        <span class="ipo-redchip ipo-redchip--${e.verdict}">${escapeHtml(e.label)}</span>
        ${e.isNew ? `<span class="ipo-new">新</span>` : ""}
        <span class="redchip-name">${escapeHtml(e.nameCn || e.nameEn || e.leadId)}</span>
        ${e.matched ? "" : `<span class="redchip-unmatched">未匹配卡片</span>`}
      </div>
      ${facts.length ? `<p class="redchip-facts">${facts.join(" ｜ ")}</p>` : ""}
      <p class="redchip-evid">${evidence.join(" · ")}</p>
      ${e.changedFields?.length ? `<p class="redchip-changed">本次更新：${escapeHtml(e.changedFields.join("、"))}</p>` : ""}
      <div class="redchip-foot">${report}${source}</div>
    </li>`;
}

/**
 * 台账入口链接（**站点相对路径**）。
 *
 * 报告页固定位于 `site/<date>/<date>.html`，台账总览页在 `site/redchip/index.html`，
 * 故用 `../redchip/index.html`。⚠️ 发布根副本（`site/index.html`）里这个相对路径会被解析成
 * `/../redchip/…`，`build-site` 必须同步改写（与 `../archive.html` 同款处理）——
 * 实测漏改会让整片 404（2026-09-17 首页详情链接事故同源）。
 */
const LEDGER_HREF = "../redchip/index.html";

function ledgerHtml(panel: RedchipPanel): string {
  const n = panel.ledgerCount ?? 0;
  if (!n) return "";
  const windowed = panel.entries.length;
  const hint =
    windowed > 0
      ? `本期新增动向 ${windowed} 家`
      : "本期无新动向";
  return `<p class="redchip-ledger"><a href="${LEDGER_HREF}">📋 红筹商机台账（在册 ${n} 家）→</a><span class="redchip-ledger-hint">${hint} · 台账为全量在册线索，面板只列近期动向</span></p>`;
}

/**
 * 面板渲染。
 *
 * 三态：
 * - 有近期动向 → 完整面板（列表 + 台账入口）
 * - **窗口内无动向但台账有在册线索** → 只渲染台账入口一行（不能整块消失，
 *   否则读者会把「近期无新动向」误读成「没有红筹商机」）
 * - 台账也为空 → 空串（不渲染空区块，与「空板块自动隐藏」口径一致）
 */
export function renderRedchipPanel(panel: RedchipPanel | undefined): string {
  if (!panel) return "";
  if (panel.entries.length === 0 && !panel.ledgerCount) return "";
  const captured = panel.capturedAt
    ? `数据截至 ${escapeHtml(panel.capturedAt.slice(0, 16).replace("T", " "))}`
    : "";
  if (panel.entries.length === 0) {
    return `<section class="redchip-panel redchip-panel--quiet" aria-labelledby="redchip-title">
    <h2 class="redchip-title" id="redchip-title">🚩 红筹线索</h2>
    ${ledgerHtml(panel)}
    <p class="redchip-note">「线索」为机器判定（离岸注册 ∧ 广东运营实体语境命中），<strong>非结论</strong>。${captured}</p>
  </section>`;
  }
  return `<section class="redchip-panel" aria-labelledby="redchip-title">
    <h2 class="redchip-title" id="redchip-title">🚩 红筹线索<span class="redchip-count">${panel.entries.length}</span></h2>
    <ul class="redchip-list">${panel.entries.map(itemHtml).join("")}</ul>
    ${ledgerHtml(panel)}
    <p class="redchip-note">「线索」为机器判定（离岸注册 ∧ 广东运营实体语境命中），<strong>非结论</strong>；点击可查看穿透分析报告（会前版本）。${captured}</p>
  </section>`;
}
