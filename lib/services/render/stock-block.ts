/**
 * 股市区块渲染（2026-09-14 C-1 Phase3 自 `render/full.ts` **纯搬移**，行为零变化）：
 * `renderStockIndexBlock`（指数条）· `renderStockRecap`（昨日三卡）·
 * `renderGdIpoStrip`（广东IPO 横滑卡，供 must/stock 两个位置复用）。
 */
import type { DailyReport, MarketCard, ReportItem } from "../../contracts/report";
import { STR } from "./i18n";
import { escapeHtml, GD_IPO_STAGE_BIZ } from "./cards";
import { GD_IPO_STAGE_LABEL } from "../classify/gd-ipo";
import { companyNameOf } from "../classify/gd-ipo-spoken";
import { relativeDayLabel } from "./atoms";
import { itemAnchorId } from "./atoms";
import { tagClsOf } from "./atoms";
import { gdIpoStageOf, topGdIpo } from "../classify/gd-ipo-spoken";
import { renderReportItemHtml } from "./report-item";

/**
 * 昨日股市复盘三卡（美股 / A股 / 港股）：每张 = 涨跌概况 + 关键板块。
 * 参考区，置于执行摘要之后、板块导航之前；stock_recap 缺失或三卡全空则不渲染。
 * 内容纯市场事实概述，无零售/对公引申（用户 2026-08-25 拍板，且转口播友好）。
 */
export function renderStockIndexBlock(card: MarketCard, quoteChannel?: string, quoteDate?: string): string {
  if (!card.indices || !card.indices.length) return "";
  const items = card.indices
    .map((i) => {
      const cls = i.changePct
        ? i.changePct.trim().startsWith("-")
          ? "down"
          : "up"
        : "";
      const pct = i.changePct
        ? ` <em class="stock-idx-pct ${cls}">${escapeHtml(i.changePct)}</em>`
        : "";
      return `<span class="stock-idx">${escapeHtml(i.name)} <b>${escapeHtml(i.value)}</b>${pct}</span>`;
    })
    .join("");
  // 行情来源备注：精准发布时间（取值日=上一交易日收盘）+ 渠道（新浪行情）
  const src =
    quoteChannel && quoteDate
      ? `<span class="stock-idx-src">${escapeHtml(quoteChannel)} · 取值于 ${escapeHtml(quoteDate)} 收盘</span>`
      : "";
  return `<div class="stock-indices"><span class="stock-idx-cap">收盘点位</span><div class="stock-idx-list">${items}</div>${src}</div>`;
}

export function renderStockRecap(report: DailyReport): string {
  const recap = report.stock_recap;
  if (!recap) return "";
  const cards = [
    { label: "A股", cls: "a", card: recap.aShare },
    { label: "港股", cls: "hk", card: recap.hk },
    { label: "美股", cls: "us", card: recap.us },
  ];
  const cardHtml = cards
    .map(({ label, cls, card }) => {
      const empty = !card.overview && !card.spoken && card.sectors.length === 0 && !card.indices?.length;
      // 卡脚小字备注：渠道（来源网站）+ 发布时间（数据日期）+ 交叉验证网站（2026-08-25 用户拍板替代来源链接按钮）
      const meta =
        card.meta && (card.meta.source || card.meta.date || card.meta.crossCheck)
          ? `<p class="stock-meta">${[
              card.meta.source ? `渠道：${escapeHtml(card.meta.source)}` : "",
              card.meta.date ? `发布时间：${escapeHtml(card.meta.date)}` : "",
              card.meta.crossCheck ? "" : "",
              card.meta.crossCheck ? `交叉验证：${escapeHtml(card.meta.crossCheck)}` : "",
            ]
              .filter(Boolean)
              .join(" · ")}</p>`
          : "";
      const indices = renderStockIndexBlock(card, recap.quoteChannel, recap.quoteDate);
      if (empty) {
        return `<li class="stock-card stock-card--${cls}" data-audio-section="stock"><header class="stock-card-head">${label}</header><p class="stock-empty">暂无数据</p>${indices}${meta}</li>`;
      }
      const overview = card.overview || card.spoken || "";
      // 大盘解读权威源（2026-08-29 用户：港股大盘解读应锚定新浪财经等收评/总结报告）
      // 卡内展示「直接看原报告」入口，让行长不必另去检索即可读权威解读。
      const sourceReport = card.sourceReport
        ? `<a class="stock-source-report" href="${escapeHtml(card.sourceReport.url)}" target="_blank" rel="noopener">📄 原报告：${escapeHtml(card.sourceReport.title)}</a>`
        : "";
      // 关键板块总结：最多取 3 条，避免「具体的板块细节」挤占顶部复盘卡
      // （细节下沉到底部「股市动态」消息清单，2026-08-25 用户要求）
      const sectors = card.sectors.length
        ? `<div class="stock-sectors"><span class="stock-sec-label">关键板块总结</span><ul>${card.sectors
            .slice(0, 3)
            .map((s) => `<li>${escapeHtml(s)}</li>`)
            .join("")}</ul></div>`
        : "";
      return `<li class="stock-card stock-card--${cls}" data-audio-section="stock">
        <header class="stock-card-head">${label}</header>
        ${indices}
        ${overview ? `<p class="stock-overview"><span class="stock-sec-label">大盘一句话总结</span>${escapeHtml(overview)}</p>` : ""}
        ${sourceReport}
        ${sectors}
        ${meta}
      </li>`;
    })
    .join("");
  const ms = recap.marketStatus;
  // 非交易日：橙字警示休市 + 上一交易日日期；交易日：常规说明。
  // note 为可选（旧 store.json 可能缺失），缺失时回退到 spokenNote 的日期文案。
  const closedNote = ms?.note || (ms?.isMarketClosed ? ms?.spokenNote : "");
  const stockNote = ms?.isMarketClosed
    ? `<p class="stock-note stock-note--closed" style="color:#c8842a;font-weight:600">⚠️ ${escapeHtml(closedNote ?? "")}</p>`
    : `<p class="stock-note">昨日市场复盘 · 涨跌概况与关键板块（AI 生成）</p>`;
  return `<section class="stock-recap">
    <div class="stock-must">
      <h3 class="exec-col-title">📊 股市解读<span class="stock-hint-inline" aria-hidden="true">← 左右滑动查看 →</span></h3>
      ${stockNote}
      <ul class="stock-scroller">${cardHtml}</ul>
    </div>
  </section>`;
}

/**
 * 广东 IPO 阶段 → 展示文案（横滑徽章、底部四阶段分栏组头、筛选条 chips 共用）。
 *
 * ⚠️ 2026-09-10 用户拍板口径：**「注册生效」归「注册发行」**，不归「已上市」
 * （注册生效 = 待发行，语义上未必已挂牌）。此前官方源把它判 stage-listed、
 * 关键词表判 stage-registered → 同卡分栏与徽章自相矛盾（P0-1），现已统一。
 *
 * 2026-09-14（P0-3）：本文件此前的私有副本（注释还误称「唯一来源」）已删除，
 * 改由 `services/classify/gd-ipo.ts` 导入 —— 阶段枚举单一真源。
 */

/**
 * 广东 IPO 横滑卡（任务六）：在「今日必读」与「股市播报」各插一行，最多 3 条最有机会
 * （商机价值优先：辅导备案 > 注册生效·过会 > 在审·受理 > 已上市），带「股份行广州分行商机
 * 线索」文案，左右滑动。口播由 buildGdIpoSpoken 同序同量生成，确保展示卡与口播一致。
 * 无广东 IPO 命中（report.sections.ipo 无「粤」标条目）→ 返回空串，不渲染。
 */
export function renderGdIpoStrip(items: ReportItem[], opts?: { section?: "must" | "stock" }): string {
  // 顶部横滑＝口播同源池：同样排除「单纯赴港上市」（非红筹），与 pickSpokenItems 口径一致
  const picks = topGdIpo(items, undefined, 3, undefined, { uniqueCompany: true, excludePlainHk: true });
  if (picks.length === 0) return "";
  const cards = picks
    .map((it) => {
      const stage = gdIpoStageOf(it);
      const company = companyNameOf(it.title_cn || "");
      const biz = GD_IPO_STAGE_BIZ[stage] || "";
      const url = it.url || "";
      const src = it.source ? escapeHtml(it.source) : "交易所";
      // P2 呈现：相对时距，避免「09/03」被读成今日动态
      const rel = relativeDayLabel(it.date);
      const date = it.date ? escapeHtml(rel ? `${it.date} · ${rel}` : it.date) : "";
      const link = url
        ? `<a class="ipo-src" href="${escapeHtml(url)}" target="_blank" rel="noopener">来源 · ${src}</a>`
        : `<span class="ipo-src">${src}</span>`;
      // 红筹线索（plan-redchip-crawl-push §5.1）：徽章 + 「新」角标 + 变更小字 + 报告入口。
      // 徽章文案来自判定档（服务层已定），渲染层不重新判定（防两处口径漂移）。
      const rc = it.redchip;
      const rcBadge = rc
        ? `<span class="ipo-redchip ipo-redchip--${rc.verdict}">${escapeHtml(rc.label)}</span>` +
          (rc.isNew ? `<span class="ipo-new">新</span>` : "") +
          (rc.changedFields?.length
            ? `<span class="ipo-rc-changed">↑${escapeHtml(rc.changedFields.join("/"))}</span>`
            : "")
        : "";
      const reportKindLabel =
        rc?.reportKind === "deep" ? "深度" : rc?.reportKind === "manual" ? "人工" : "会前";
      const reportLink = rc?.reportUrl
        ? `<a class="ipo-report" href="${escapeHtml(rc.reportUrl)}" target="_blank" rel="noopener">穿透分析报告（${reportKindLabel}） →</a>`
        : "";
      return `<li class="ipo-card${rc ? " ipo-card--redchip" : ""}" id="${it.url ? itemAnchorId(it.url) : ""}" data-audio-section="ipo">
        <div class="ipo-card-head">
          ${rcBadge}
          <span class="ipo-name">${escapeHtml(company)}</span>
          <span class="ipo-stage ipo-stage--${stage}">${escapeHtml(GD_IPO_STAGE_LABEL[stage] || "IPO")}</span>
        </div>
        ${biz ? `<p class="ipo-biz">${escapeHtml(biz)}</p>` : ""}
        <div class="ipo-foot"><span class="ipo-date">${date}</span>${link}</div>
        ${reportLink}
      </li>`;
    })
    .join("");
  const sec = opts?.section === "stock" ? "stock" : "must";
  return `<div class="exec-ipo exec-ipo--${sec}">
    <h3 class="exec-col-title">🏦 广东IPO<span class="ipo-hint-inline" aria-hidden="true">← 左右滑动查看 →</span></h3>
    <ul class="ipo-scroller">${cards}</ul>
  </div>`;
}

// ----- top-level renderer -----

