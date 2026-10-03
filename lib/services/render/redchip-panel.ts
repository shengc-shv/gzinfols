/**
 * 红筹线索面板（plan-redchip-crawl-push §5.1）。
 *
 * 独立于五板块 tab 的常驻区块：tab 只收录「已匹配到 IPO 卡片」的红筹条目，
 * 而**匹配失败的线索**（T7）只能在面板里被看到 —— 否则线索会静默消失。
 * 渲染层不重新判定任何东西：文案/字段全部来自服务层产出的 `RedchipPanel`。
 */
import type { RedchipPanel, RedchipPanelEntry } from "../../contracts/redchip";
import { REDCHIP_LIST_WINDOW_DAYS } from "../../ipo-config";
import { REDCHIP_SOURCE_LABELS } from "../redchip/provenance";
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
  if (e.changedAt) facts.push(`最近更新 ${escapeHtml(e.changedAt.slice(0, 10))}`);

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
  return `<p class="redchip-ledger"><a href="${LEDGER_HREF}">📋 红筹商机台账（在册 ${n} 家）→</a><span class="redchip-ledger-hint">台账为全量在册线索，面板只列近期动向</span></p>`;
}

/**
 * 数据时刻文案。
 *
 * ⚠️ 两种来源**含义不同，措辞不得混用**：
 * - `snapshot`（抓取元信息）→ 「数据截至」：那一刻确实跑过抓取；
 * - `ledger`（台账派生）→ 「台账更新至」：只证明台账里有这个时刻的记录。
 *   写成「数据截至」会让读者以为当天抓过 —— 这正是「数字与日期对不上」的根因。
 */
function capturedText(panel: RedchipPanel): string {
  if (!panel.capturedAt) return "⚠️ 无数据时间戳";
  const ts = escapeHtml(panel.capturedAt.slice(0, 16).replace("T", " "));
  return panel.capturedSource === "ledger" ? `台账更新至 ${ts}` : `数据截至 ${ts}`;
}

/**
 * 来源行（provenance）：**呈现必须带来源与新鲜度**。
 *
 * 四类事实按可用性拼装：近窗动向家数 / 数据时刻 / 按市场分布 / 降级说明。
 * 缺失者不编造 —— 时间红线：没有就是没有，只如实写「无数据时间戳」。
 */
function provenanceHtml(panel: RedchipPanel): string {
  const facts: string[] = [`近 ${REDCHIP_LIST_WINDOW_DAYS} 日动向 ${panel.entries.length} 家`];
  facts.push(capturedText(panel));
  const markets = Object.entries(panel.ledgerByMarket ?? {}).sort((a, b) => b[1] - a[1]);
  if (markets.length) {
    facts.push(
      "来源：" +
        markets.map(([k, v]) => `${escapeHtml(REDCHIP_SOURCE_LABELS[k] ?? k)} ${v} 家`).join(" / "),
    );
  }
  return `<p class="redchip-provenance">${facts.join(" · ")}</p>`;
}

/** 降级说明（源失败 / 数据过期）——有则必须显示，不得静默。 */
function freshnessHtml(panel: RedchipPanel): string {
  return panel.freshnessNote ? `<p class="redchip-fresh">${escapeHtml(panel.freshnessNote)}</p>` : "";
}

/**
 * 「非红筹但广东相关」的近窗申请（2026-10-03 sc：**只在面板展现**）。
 *
 * 用 `<details>` 折叠：它们不是红筹线索（判定未过境外注册），不该与上面的红筹列表抢注意力，
 * 但爬虫这部分工作必须可见 —— 故给一行摘要 + 展开清单。不参与任何卡片/口播。
 */
function gdAdjacentHtml(panel: RedchipPanel): string {
  const list = panel.gdAdjacent ?? [];
  if (!list.length) return "";
  const items = list
    .map((g) => {
      const facts: string[] = [];
      if (g.submitDate) facts.push(`递表 ${escapeHtml(g.submitDate)}`);
      if (g.domicile) facts.push(`注册地 ${escapeHtml(g.domicile)}`);
      facts.push(`广东实体语境命中 ${g.gdCityHits}`);
      const link = g.sourceUrl
        ? ` <a class="ipo-src" href="${escapeHtml(g.sourceUrl)}" target="_blank" rel="noopener">PDF</a>`
        : "";
      return `<li><span class="redchip-adj-name">${escapeHtml(g.nameCn || g.nameEn || g.leadId)}</span> <span class="redchip-adj-facts">${facts.join(" · ")}</span>${link}</li>`;
    })
    .join("");
  return `<details class="redchip-adjacent">
      <summary>另有 ${list.length} 家近 ${REDCHIP_LIST_WINDOW_DAYS} 日新增的<b>广东相关申请</b>（境内/香港注册，非红筹）</summary>
      <ul class="redchip-adj-list">${items}</ul>
      <p class="redchip-adj-note">判定口径为「境外注册 ∧ 广东运营实体语境命中」，故境内/香港注册的广东企业不计入红筹 —— 此处仅作呈现，不参与卡片与口播。</p>
    </details>`;
}

const NOTE = `「线索」为机器判定（离岸注册 ∧ 广东运营实体语境命中），<strong>非结论</strong>；在册数为<strong>累计</strong>口径（非近期新增）。`;

/**
 * 面板渲染。
 *
 * 三态：
 * - 有近期动向 → 完整面板（列表 + 台账入口 + 来源行）
 * - **窗口内无动向但台账有在册线索**（或只有广东相关申请）→ 只渲染台账入口一行
 *   （不能整块消失，否则读者会把「近期无新动向」误读成「没有红筹商机」）
 * - 三者皆空 → 空串（不渲染空区块，与「空板块自动隐藏」口径一致）
 */
export function renderRedchipPanel(panel: RedchipPanel | undefined): string {
  if (!panel) return "";
  if (panel.entries.length === 0 && !panel.ledgerCount && !panel.gdAdjacent?.length) return "";
  if (panel.entries.length === 0) {
    return `<section class="redchip-panel redchip-panel--quiet" aria-labelledby="redchip-title">
    <h2 class="redchip-title" id="redchip-title">🚩 红筹线索</h2>
    ${ledgerHtml(panel)}
    ${provenanceHtml(panel)}
    ${freshnessHtml(panel)}
    ${gdAdjacentHtml(panel)}
    <p class="redchip-note">${NOTE}</p>
  </section>`;
  }
  return `<section class="redchip-panel" aria-labelledby="redchip-title">
    <h2 class="redchip-title" id="redchip-title">🚩 红筹线索<span class="redchip-count">${panel.entries.length}</span></h2>
    <ul class="redchip-list">${panel.entries.map(itemHtml).join("")}</ul>
    ${ledgerHtml(panel)}
    ${provenanceHtml(panel)}
    ${freshnessHtml(panel)}
    ${gdAdjacentHtml(panel)}
    <p class="redchip-note">${NOTE}点击可查看穿透分析报告（会前版本）。</p>
  </section>`;
}
