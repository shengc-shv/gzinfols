import type {
  DailyReport,
  MarketCard,
  RenderInjection,
  ReportInsight,
  ReportItem,
  ReportMustRead,
  ReportSectionKey,
  TradingSection,
} from "../../contracts/report";
import type { ArticleInput } from "../../contracts/article";
import type { WatchlistPick } from "../../contracts/market";
import { REPORT_LOCALE } from "./locale";
import { STR, SUBCATEGORY_ORDER, SUBCATEGORY_LABELS } from "./i18n";
import { SECTIONS, BANNED_WORDS } from "../enrich/validator";
import { rollUpTags } from "../enrich/tag-rollup";
import { PRIORITY_SEGMENTS, OTHER_SEGMENT, mapTagsToSegments } from "../classify/customer-segment";
import { titleSimilarityDice } from "../select/filters/dedup-similar";
import {
  renderRawCategoryPanel,
  countItemsRecent,
  CATEGORY_LABELS,
  CATEGORY_DIGEST_LABELS,
  TECH_MAIN_SUBS,
  sortByTierAndTime,
  isGdIpoCandidate,
  isGzLocalCandidate,
  isPolicyMarketCandidate,
  renderCardList,
  escapeHtml,
  GD_IPO_STAGE_BIZ,
  IPO_CAPITAL_ACT_RE,
  IPO_FLOW_RE,
  type SourceGroup,
  type SubGroup,
  type RawByCategory,
} from "./cards";
import {
  renderTradingPanel,
  renderExecutiveSummary,
  TREND_LABEL,
} from "./sections";
export type { SourceGroup, SubGroup, RawByCategory } from "./cards";
import { TIER_COLORS, THEME_CSS } from "./theme";
import type { AudioMeta } from "../voice";
import { selectTopMustRead } from "../enrich/select-top";
// 分行相关性评分器（纯函数、不调 LLM）：用于「未打标历史条目」的并入门槛（2026-08-29 方案③）
import { scoreBranchRelevance } from "../select/filters/relevance-score";
import { generateAudioHighlightScript, AUDIO_HIGHLIGHT_CSS } from "./inline-player";
import { getReportTz, todayKey } from "../../utils/time";
import type { Category, SourceDef } from "../../contracts/source";
import { SOURCE_TIER_LABELS, type SourceTier } from "../../contracts/source";
import { CATEGORY_ORDER } from "../../contracts/source";
import { V2EX_OFF_TOPIC_RE } from "./site-filters";
import type { TickerAnalysis } from "../../contracts/market";
import {
  getAssetGroupLabels,
  ASSET_GROUP_ORDER,
} from "../market/watchlist";
import type { AssetGroup } from "../../contracts/market";
import {
  classifyGdIpo,
  inferStage,
  isGdStage,
  IPO_STAGE_ORDER,
  GD_IPO_STAGE_LABEL,
  type GdIssuerRegistry,
  type GdStage,
} from "../classify/gd-ipo";
// 阶段枚举（GdStage / GD_STAGES / IPO_STAGE_ORDER / GD_IPO_STAGE_LABEL）**单一真源**
// 在 services/classify/gd-ipo.ts。渲染层此前各留一份私有副本（2026-09-14 P0-3 修复），
// 与「新增阶段漏改某一处」的风险同构；此处 re-export 保持既有 import 路径可用。
export { IPO_STAGE_ORDER };
import { topGdIpo, gdIpoStageOf, companyNameOf } from "../classify/gd-ipo-spoken";
import { IPO_LIST_WINDOW_DAYS } from "../../ipo-config";

// ----- C-1 Phase2：分组业务规则已迁到 assemble/（纯搬移，行为零变化）-----
// import 供本文件内部使用 + re-export 保持对外 API 不变
// （`render/index.ts` 的 `export * from "./full"`、`tests/groupRaw.test.ts` 从
//  `../lib/services/render` 取 groupRaw、`scripts/regen-enrich.ts` 取
//  MERGED_SUBGROUP_LIMITS/isSportsArticle —— 三条既有路径全部继续可用）。
import { groupRaw, themeKeysOf, conductToGzSubs, capByThemeAndTier } from "../assemble/group";
import {
  SOURCE_DISPLAY_LIMITS,
  MERGED_SUBGROUP_LIMITS,
  MERGE_PER_SOURCE_CAP,
  isSportsArticle,
} from "../assemble/limits";

export * from "../assemble/group";
export * from "../assemble/limits";


// ----- C-1 Phase1：纯展示函数已外移到独立模块（纯搬移，行为零变化）-----
// 这里**import 供本文件内部使用** + **re-export 保持对外 API 不变**（render/index.ts 的
// `export * from "./full"` 与 scripts/regen-enrich.ts 的直接 import 路径均不受影响）。
import { tagClsOf, MARKET_BADGE, capSummary, relativeDayLabel } from "./atoms";
import { renderReportItemHtml, DEPT_TAGS, renderReportCardList } from "./report-item";
import {
  type FilterChipDef,
  type FilterGroupDef,
  DEFAULT_FILTER_GROUPS,
  renderFilterBar,
  renderFilterBarForPanel,
  renderStockFilterBar,
} from "./filter-bar";
import {
  ipoStageGroupLabel,
  renderIpoFilterBar,
  renderIpoProgress,
  renderIpoPanelHtml,
} from "./ipo-panel";
import { SIGNAL_TONE, renderMarkdown } from "./markdown";

export * from "./atoms";
export * from "./report-item";
export * from "./filter-bar";
export * from "./ipo-panel";
export * from "./markdown";



// ----- types -----


// ----- labels & ordering -----

/**
 * 完整版面渲染（gzinfo lib/output/render.ts 逐字移植，2026-09-13 B6 渲染全量对齐）。
 *
 * 2.0 适配（其余逐字）：
 *  - REPORT_LOCALE 经 `./locale` 注入（组合根 setReportLocale），服务层不读 env；
 *  - `loadAllSources()` / `readFileSync(gd-issuers.json)` 两处 IO 移出服务层：
 *    groupRaw 增可选 opts（knownSourceIds / gdIssuers），由调用方注入；
 *  - 加密相关：renderCryptoWidgets 调用点已随 sections.ts 剔除（加密永久剔除）。
 */
/**
 * 广州商机杂讯兜底词表（与 scripts/analyze-gz.ts 的 HEURISTIC_RULES 无关词表一致，
 * 生产验证过）。南沙/政府列表页会长期挂旧政策文件库存（电费补贴/招聘/摆卖/殡葬/
 * 诊所备案等），LLM 相关性分类偶有漏网——此词表在渲染层兜底过滤。
 */
/** 构造 url → 中文标题 映射（供 must_read 回写标题）。 */
function resolveTitleMap(report: DailyReport): Map<string, string> {
  const m = new Map<string, string>();
  const secs: ReportSectionKey[] = ["gz_local", "biz_insight", "policy_market", "tech", "ipo"];
  for (const s of secs) {
    for (const it of report.sections?.[s] ?? []) {
      if (it.url && it.title_cn) m.set(it.url, it.title_cn);
    }
  }
  return m;
}

/**
 * 顶部执行摘要：今日定调 + 今日必读 + 商机洞察（消费新 report 结构：
 * hero_line / must_read / insights）。must_read 仅含 url+why，按 url 回写标题。
 */
function renderReportExec(report: DailyReport): string {
  const titleMap = resolveTitleMap(report);
  // N 层：选 top 3（音频核心）+ 数据化"三件事"标识
  const sourceItems: ReportItem[] = SECTIONS.flatMap((s) => report.sections[s] ?? []);
  const { top: topMust, rationale: topRationale } = selectTopMustRead(
    report.must_read,
    sourceItems,
  );
  const topMustUrls = new Set(topMust.map((m) => m.url));
  const must = report.must_read
    .map((m, i) => {
      const title = m.title || titleMap.get(m.url) || m.url;
      const body = `<strong>${escapeHtml(title)}</strong><span class="must-why">${escapeHtml(m.why)}</span>`;
      const inner = m.url
        ? `<a class="must-body must-link" href="${escapeHtml(m.url)}" target="_blank" rel="noopener">${body}</a>`
        : `<div class="must-body">${body}</div>`;
      const isTop = m.url && topMustUrls.has(m.url);
      const topBadge = isTop ? `<span class="must-top-badge" title="今日三件事：行长音频重点">三件事</span>` : "";
      const cls = isTop ? "must-card must-top" : "must-card";
      return `<li class="${cls}" data-audio-section="must" ${isTop ? 'data-top-must="true"' : ""}><span class="must-index">${i + 1}</span>${inner}${topBadge}</li>`;
    })
    .join("");
  const renderInsightCard = (it: ReportInsight): string => {
    const srcMarks = (it.sources && it.sources.length > 0)
      ? ` <span class="insight-srcs">${it.sources.slice(0, 3).map((s, i) =>
          `<a class="insight-src" href="${escapeHtml(s.url)}" target="_blank" rel="noopener" title="${escapeHtml(s.title || "来源" + (i + 1))}" aria-label="来源${i + 1}">${["①","②","③","④","⑤"][i]}</a>`
        ).join("")}</span>`
      : "";
    const segs = it.segments && it.segments.length ? it.segments : [OTHER_SEGMENT];
    const segChips = `<div class="insight-segs">${segs
      .map((s) => `<span class="seg-chip seg-${SEG_KEY[s] ?? "other"}">${escapeHtml(SEG_SHORT[s] ?? s)}</span>`)
      .join("")}</div>`;
    return `<article class="insight" data-audio-section="insight">
      ${(it.tags ?? []).length > 0
        ? `<div class="insight-tags">${(it.tags ?? [])
            .map((t) => `<span class="tag ${tagClsOf(t)}">${escapeHtml(t)}</span>`)
            .join("")}</div>`
        : ""}
      ${segChips}
      <h3>${escapeHtml(it.topic)}${srcMarks}</h3>
      ${it.impact ? `<p><b>影响：</b>${escapeHtml(it.impact)}</p>` : ""}
      ${it.action ? `<p><b>建议：</b>${escapeHtml(it.action)}</p>` : ""}
    </article>`;
  };
  // 商机洞察：单板块（恢复原始模式），客户客群标签打在具体信息卡片上；
  // 每标签最多出现 2 条（其他业务线最多 1 条），多标签按其优先级归口、各标签配额独立计数（互不挤占）。
  const SEG_LIST = PRIORITY_SEGMENTS as readonly string[];
  const SEG_SHORT: Record<string, string> = {
    "零售AUM": "零售AUM",
    "中高端客群(过亿资产)": "高端客户",
    "普惠小微贷款客户": "普惠小微",
    [OTHER_SEGMENT]: "其他业务线",
  };
  const SEG_KEY: Record<string, string> = {
    "零售AUM": "aum",
    "中高端客群(过亿资产)": "private",
    "普惠小微贷款客户": "inclusive",
    [OTHER_SEGMENT]: "other",
  };
  const SEG_CAP: Record<string, number> = {
    "零售AUM": 2,
    "中高端客群(过亿资产)": 2,
    "普惠小微贷款客户": 2,
    [OTHER_SEGMENT]: 1,
  };
  const primaryOf = (it: ReportInsight): string => {
    let best: string | null = null;
    let bestIdx = Number.POSITIVE_INFINITY;
    for (const s of it.segments ?? []) {
      const idx = SEG_LIST.indexOf(s);
      if (idx >= 0 && idx < bestIdx) {
        bestIdx = idx;
        best = s;
      }
    }
    return best ?? OTHER_SEGMENT;
  };
  // 配额选择：按优先级归口排序，逐条占用其所有标签的配额（各标签独立计数，互不挤占）
  const used: Record<string, number> = {};
  const selectedInsights: ReportInsight[] = [];
  const sortedForCap = [...(report.insights ?? [])].sort((a, b) => {
    const pa = SEG_LIST.indexOf(primaryOf(a));
    const pb = SEG_LIST.indexOf(primaryOf(b));
    return (pa < 0 ? SEG_LIST.length : pa) - (pb < 0 ? SEG_LIST.length : pb);
  });
  for (const it of sortedForCap) {
    const segs = it.segments && it.segments.length ? it.segments : [OTHER_SEGMENT];
    if (segs.every((s) => (used[s] ?? 0) < (SEG_CAP[s] ?? 1))) {
      segs.forEach((s) => (used[s] = (used[s] ?? 0) + 1));
      selectedInsights.push(it);
    }
  }
  const insightsHtml = selectedInsights.map(renderInsightCard).join("");
  // M 层：风险卡片（与 insights 同样的卡片样式；M 关键特征：红/警示色 + 部门影响拆解）
  const riskCard = (() => {
    const r = report.risk;
    if (!r) return "";
    const srcMarks = (r.sources && r.sources.length > 0)
      ? ` <span class="risk-srcs">${r.sources.slice(0, 3).map((s, i) =>
          `<a class="risk-src" href="${escapeHtml(s.url)}" target="_blank" rel="noopener" title="${escapeHtml(s.title || "来源" + (i + 1))}" aria-label="来源${i + 1}">${["①","②","③","④","⑤"][i]}</a>`
        ).join("")}</span>`
      : "";
    const sourceBadge = r.source
      ? `<span class="risk-source-badge risk-source-${r.source.toLowerCase()}">${r.source === "T1" ? "官方" : r.source === "T1.5" ? "准官方" : "媒体"}</span>`
      : "";
    const fbKey = (r.sources && r.sources[0]?.url) || r.url || `risk:${r.topic}`;
    return `<article class="risk-card" data-audio-section="risk">
        <div class="risk-header">⚠️ 风险预警${sourceBadge}${srcMarks}</div>
        <h3>${escapeHtml(r.topic)}</h3>
        ${r.evidence ? `<p><b>依据：</b>${escapeHtml(r.evidence)}</p>` : ""}
        ${r.impact ? `<p><b>影响：</b>${escapeHtml(r.impact)}</p>` : ""}
        ${r.action ? `<p><b>建议：</b>${escapeHtml(r.action)}</p>` : ""}
      </article>`;
  })();
  return `<section class="exec-summary">
    <div class="exec-head">
      <h2 class="exec-title">执行摘要</h2>
      <span class="exec-sub">今日必读 · 商机洞察 · 风险预警（AI 生成）· 广东IPO（交易所/证监会官方源）</span>
    </div>
    ${must ? `<div class="exec-must"><h3 class="exec-col-title">📌 今日必读<span class="must-hint-inline" aria-hidden="true">← 左右滑动查看 →</span></h3><ul class="must-scroller">${must}</ul></div>` : ""}
    ${insightsHtml ? `<div class="exec-insights"><h3 class="exec-col-title">💡 商机洞察<span class="insight-hint-inline" aria-hidden="true">← 左右滑动查看 →</span></h3><div class="insight-scroller">${insightsHtml}</div></div>` : ""}
    ${riskCard ? `<div class="exec-risk"><h3 class="exec-col-title">⚠️ 风险预警<span class="risk-hint-inline" aria-hidden="true">← 左右滑动查看 →</span></h3><div class="risk-scroller">${riskCard}</div></div>` : ""}
    ${renderGdIpoStrip(report.sections?.ipo ?? [], { section: "must" })}
  </section>`;
}

/**
 * 昨日股市复盘三卡（美股 / A股 / 港股）：每张 = 涨跌概况 + 关键板块。
 * 参考区，置于执行摘要之后、板块导航之前；stock_recap 缺失或三卡全空则不渲染。
 * 内容纯市场事实概述，无零售/对公引申（用户 2026-08-25 拍板，且转口播友好）。
 */
function renderStockIndexBlock(card: MarketCard, quoteChannel?: string, quoteDate?: string): string {
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

function renderStockRecap(report: DailyReport): string {
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
  const picks = topGdIpo(items, undefined, 3, undefined, { uniqueCompany: true });
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
      return `<li class="ipo-card" data-audio-section="ipo">
        <div class="ipo-card-head">
          <span class="ipo-name">${escapeHtml(company)}</span>
          <span class="ipo-stage ipo-stage--${stage}">${escapeHtml(GD_IPO_STAGE_LABEL[stage] || "IPO")}</span>
        </div>
        ${biz ? `<p class="ipo-biz">${escapeHtml(biz)}</p>` : ""}
        <div class="ipo-foot"><span class="ipo-date">${date}</span>${link}</div>
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

/**
 * 外地地名锚（广州本地严格过滤用）：标题命中任一外地省/市/地名 → 该条为全国/外地
 * 政策（上海/北京/深圳/江苏/浙江…），即使 category=gz 也不进 gz_local，归政策与市场。
 * 广州本地板块宁缺毋滥：领导冲着「广州」点进来，看到的必须是广州事件本身。
 */
const FOREIGN_REGION_RE =
  /上海|北京|深圳|江苏|浙江|南京|苏州|杭州|宁波|成都|重庆|天津|武汉|长沙|合肥|青岛|济南|福州|厦门|昆明|西安|郑州|东莞|佛山|珠海|中山|惠州|汕头|湛江|茂名|肇庆|江门|清远|韶关|梅州|河源|阳江|揭阳|汕尾|潮州|云浮|广东/;


/**
 * SKIP_AI 模式执行摘要回填（2026-08-21 修复：store.json 复用断链）。
 *
 * 背景：两阶段管线改造后 daily.ts 不再调用旧 selectExecutiveSummary，
 * history/<date>/store.json（真实 AI 当日产物）成为死数据——SKIP_AI 本地预览
 * 时 must_read/insights 恒空（PASS2 不产出），尽管 store.json 里有当日 executive。
 *
 * 本函数把 store 的 ExecutiveSummary（旧 schema：must_read{title,why,url?} /
 * insights{topic,impact,action,tag?}）适配为 report 的新 schema：
 * - must_read：url 缺失时按标题在 report.sections 回匹配（Dice≥0.5），仍无则丢弃
 *   （宁缺毋滥，避免空链接卡片）；why 保留
 * - insights：tag[] → tags[]，topic/impact/action 照搬
 * - 违禁词过滤：命中 BANNED_WORDS 的 must_read/insights 丢弃（P0 合规，
 *   store 里「加密资产疯涨」这类旧产物不回流）
 */
/**
 * 商机洞察来源回链在 AI 生成阶段完成（executive-summary.ts 的 resolveInsightSources，
 * 用生成时看到的 inputs 含真实 URL 回链），结果随 store.json 落库复用；本函数仅透传。
 */
export function mergeStoredExecutive(
  report: DailyReport,
  exec: {
    hero_line?: string;
    must_read: Array<{ title: string; why: string; url?: string }>;
    insights: Array<{ topic: string; impact: string; action: string; tag?: string[]; segments?: string[]; sources?: Array<{ title: string; url: string }> }>;
    // M 层：风险（M 阶段 SKIP_AI 复用 store 时透传）
    risk?: {
      topic: string;
      evidence: string;
      impact: string;
      action: string;
      url?: string;
      source?: "T1" | "T1.5" | "T2";
      sources?: Array<{ title: string; url: string }>;
    };
  },
): DailyReport {
  const banned = new Set(BANNED_WORDS);
  const bannedIn = (s: string): boolean => banned.has(s) || BANNED_WORDS.some((w) => s.includes(w));

  // 标题 → url 回匹配：先宽松前缀包含（store 标题常是 sections 标题的精简版，
  // 如「8月LPR不变，房贷或续降」⊂「8月LPR保持不变，今年房贷还能否下调？」），
  // 再 Dice≥0.4 兜底（措辞改写宽容）。
  // 不可变：复制入参，全程只改 out，最后返回 out（不污染调用方的 report）
  const out: DailyReport = { ...report };
  const allItems: ReportItem[] = SECTIONS.flatMap((s) => report.sections[s] ?? []);
  const matchUrl = (title: string): string | undefined => {
    if (!title) return undefined;
    const norm = (s: string): string => s.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
    const nt = norm(title);
    if (!nt) return undefined;
    let best: { url: string; score: number } | undefined;
    for (const it of allItems) {
      const t = it.title_cn || it.title_orig || "";
      if (!t) continue;
      const nti = norm(t);
      if (nti.includes(nt) || nt.includes(nti)) return it.url; // 包含关系直接命中
      const score = titleSimilarityDice(title, t);
      if (score >= 0.4 && (!best || score > best.score)) best = { url: it.url, score };
    }
    return best?.url;
  };

  // must_read 回填（保留 url 显式携带的，其余按标题回匹配，无匹配丢弃）
  const must: ReportMustRead[] = [];
  for (const m of exec.must_read ?? []) {
    if (!m || !m.why || bannedIn(`${m.title} ${m.why}`)) continue;
    const url = m.url || matchUrl(m.title);
    if (!url) continue; // 无法定位到报告内条目 → 丢弃（宁缺毋滥）
    must.push({ url, why: m.why, ...(m.title ? { title: m.title } : {}) });
  }
  if (must.length > 0) out.must_read = must;

  // insights 回填（tag[] → tags[]，违禁过滤；sources：store 已含（生成时回链），原样透传）
  const insights: ReportInsight[] = [];
  for (const it of exec.insights ?? []) {
    if (!it || !it.topic || bannedIn(JSON.stringify(it))) continue;
    const sources = Array.isArray(it.sources) && it.sources.length > 0
      ? it.sources.slice(0, 3).filter((s) => s && s.url).map((s) => ({ title: s.title || "", url: s.url }))
      : [];
    insights.push({
      topic: it.topic,
      tags: Array.isArray(it.tag) ? it.tag.slice(0, 6) : [],
      impact: it.impact || "",
      action: it.action || "",
      ...(Array.isArray(it.segments) && it.segments.length ? { segments: it.segments } : {}),
      ...(sources.length > 0 ? { sources } : {}),
    });
  }
  if (insights.length > 0) out.insights = insights;

  // M 层：风险回填（store.json 复用路径，SKIP_AI 必走此处）。evidence/impact/action 任一违禁 → 整条丢弃。
  if (exec.risk && exec.risk.topic) {
    const r = exec.risk;
    const corpus = `${r.topic} ${r.evidence} ${r.impact} ${r.action}`;
    if (!bannedIn(corpus)) {
      const sources = Array.isArray(r.sources) && r.sources.length > 0
        ? r.sources.slice(0, 3).filter((s) => s && s.url).map((s) => ({ title: s.title || "", url: s.url }))
        : [];
      out.risk = {
        topic: r.topic,
        evidence: r.evidence || "",
        impact: r.impact || "",
        action: r.action || "",
        ...(r.url ? { url: r.url } : {}),
        ...(r.source ? { source: r.source } : {}),
        ...(sources.length > 0 ? { sources } : {}),
      };
    }
  }

  // hero_line 回填：SKIP_AI 的弱兜底非空但无定调价值 → 视为缺省，用 store 的 hero_line
  //（真实 AI 当日定调）或回填成功的 must_read 首条生成「今日关注：xxx」覆盖（2026-08-21 用户反馈）。
  // 弱兜底两种形态：pipeline.ts 的「今日更新 N 条资讯：<PASS2首条>」+ degrade ⑦ 的
  // HERO_FALLBACK「今日暂无可推送重点」（SKIP_AI 下 PASS2 必读为空触发 R12 → 降级）。
  const heroIsWeakFallback =
    !report.hero_line ||
    /^今日更新\s*\d+\s*条资讯/.test(report.hero_line) ||
    /今日暂无可推送重点/.test(report.hero_line);
  if (heroIsWeakFallback) {
    if (exec.hero_line) {
      out.hero_line = exec.hero_line;
    } else if (must.length > 0) {
      const it = allItems.find((x) => x.url === must[0].url);
      if (it) out.hero_line = `今日关注：${it.title_cn || it.title_orig || ""}`.slice(0, 70);
    }
  }
  return out;
}

/**
 * 发布前剥离 CSS 注释（2026-09-14）。
 *
 * 为什么必须做：`THEME_CSS` / `AUDIO_HIGHLIGHT_CSS` 是模板字符串，其中的注释会
 * **原样进入公开页面**。清理加密残留时实测到：新增的说明性注释（提到已移除的加密
 * widget 样式组、失效的阴影变量名）被直接渲染进产物 —— 既把内部笔记发布出去，
 * 又让合规断言（tests/compliance-crypto.test.ts）与 CSS 自洽断言
 * （tests/render-invariants.test.ts）误报。CSS 注释对渲染零影响，故统一在注入点剥离；
 * 源码内的注释保留给维护者。
 */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

export function renderHtml(
  report: DailyReport,
  date: string,
  opts: RenderInjection & { audio?: AudioMeta } = {},
): string {
  // 跨板块去重（一文一卡）：同一 URL 只展示一次，优先级
  // 广州本地 > 业务启示 > 政策与市场 > 科技前沿 > IPO。
  const seen = new Set<string>();
  const dedupe = (list: ReportItem[]): ReportItem[] => {
    // 同板块内二次去重：来自不同源、标题完全一致（归一化后）、且权威等级
    // 相同的条目只留一条（用户规则：同权威等级留一个，避免通稿被多源重复刷屏）。
    const seenTitleTier = new Set<string>();
    const normTitle = (t: string): string =>
      (t || "")
        .toLowerCase()
        .replace(/\s+/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, "");
    const authorityOf = (it: ReportItem): string =>
      it.tier ?? (it.source_type === "official" ? "T1" : "T2");
    return list.filter((it) => {
      if (it.url && seen.has(it.url)) return false;
      const key = `${normTitle(it.title_cn || it.title_orig || "")}|${authorityOf(it)}`;
      if (seenTitleTier.has(key)) return false;
      if (it.url) seen.add(it.url);
      seenTitleTier.add(key);
      return true;
    });
  };

  const gzLocal = dedupe(report.sections?.gz_local ?? []);
  const bizInsight = (() => {
    const list = dedupe(report.sections?.biz_insight ?? []);
    // 客户客群权重提升：命中零售AUM/中高端客群(过亿资产)/普惠小微贷款客户 的条目置顶
    const segRank = (it: ReportItem): number =>
      mapTagsToSegments(it.tags, it.title_cn || it.title_orig || "").some((s) =>
        (PRIORITY_SEGMENTS as readonly string[]).includes(s),
      )
        ? 0
        : 1;
    // 稳定排序：优先段置顶，段内保持原序（原序已是 tier/时间序）
    return list
      .map((it, i) => ({ it, i }))
      .sort((a, b) => segRank(a.it) - segRank(b.it) || a.i - b.i)
      .map((x) => x.it);
  })();
  const policyMarket = dedupe(report.sections?.policy_market ?? []);
  const techAll = dedupe(report.sections?.tech ?? []);
  // 底部「广东IPO动态」tab：只展示广东企业（「粤」标或 isGdIpoCandidate，与顶部横滑同一套判定），
  // 不再混入港交所全国递表（浙江/湖南/广西等）。展示近 7 天（用户 2026-09-10：口播 2 天 / 列表 7 天）。
  // uniqueCompany:false —— 完整列表保留「同企业不同阶段」（进展视角），
  // 企业级去重只作用于 3 个稀缺的横滑位与口播（P1-4）。
  const ipoAll = topGdIpo(report.sections?.ipo ?? [], undefined, 9999, IPO_LIST_WINDOW_DAYS, {
    uniqueCompany: false,
  });
  // 股市动态（底部消息清单，非 AI 生成）：直接来自 report.stock_news（三市场原始新闻）
  const stockNews = (report.stock_news ?? []).filter((it) => it.url);

  // 中文日期「8月22日 星期六」：用 UTC 解析避免 CI(UTC) runner 的本地时区偏移
  // 导致 getDay() 算错一天（例：2026-08-22 在 UTC 下被当作 8/21 星期五）。
  const zhDate = (() => {
    const [yy, mm, dd] = date.split("-").map(Number);
    const w = ["日", "一", "二", "三", "四", "五", "六"][new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay()];
    return `${mm}月${dd}日 星期${w}`;
  })();

  // 2026-08-29 原则5 失败可见：gz_local 板块即使 0 条也常驻展示并显式提示「今日无广州本地要闻」，
  // 避免静默消失让行长误以为系统缺数/漏采（其余板块仍按 count>0 取舍）。
  const tabs = [
    { id: "p-gz", label: "广州本地", section: "gz_local", cls: "var(--c-gz)", count: gzLocal.length, items: gzLocal, alwaysShow: true, emptyHint: "今日暂无广州本地要闻（本地源未捕捉到高价值广州事件）。大湾区/广东要闻可在「政策与市场」查看。" },
    { id: "p-stock", label: "股市动态", section: "stock_news", cls: "var(--c-trading)", count: stockNews.length, items: stockNews, alwaysShow: false, emptyHint: "今日暂无股市动态" },
    { id: "p-biz", label: "业务启示", section: "biz_insight", cls: "var(--c-biz)", count: bizInsight.length, items: bizInsight, alwaysShow: false, emptyHint: "今日暂无业务启示" },
    { id: "p-pol", label: "政策与市场", section: "policy_market", cls: "var(--c-pol)", count: policyMarket.length, items: policyMarket, alwaysShow: false, emptyHint: "今日暂无政策与市场动态" },
    { id: "p-tech", label: "科技前沿", section: "tech", cls: "var(--c-tech)", count: techAll.length, items: techAll, alwaysShow: false, emptyHint: "今日暂无科技前沿" },
    // 2026-08-30 重启（D-009）：广东 IPO 板块由 buildGdIpo side-output 直接构建（绕过 LLM），
    // 2026-09-10 用户拍板：底部 tab 只展示广东（过滤全国递表），标签改为「广东IPO动态」。
    { id: "p-ipo", label: "广东IPO动态", section: "ipo", cls: "var(--c-ipo)", count: ipoAll.length, items: ipoAll, alwaysShow: false, emptyHint: "今日暂无广东IPO动态" },
  ].filter((t) => t.count > 0 || t.alwaysShow);

  const totalItems = gzLocal.length + bizInsight.length + policyMarket.length + techAll.length;
  // 数据截止时间（2026-09-14 P0-4）：由调用方注入 `opts.now`（管线传 ctx.startTime），
  // 服务层**不再回落 `new Date()`** —— 隐式时钟会让同一天两次渲染结果不同（破坏可复现性），
  // 也让「渲染时刻」绕过注入。缺省则不显示时刻（宁缺毋滥，不编造时间）。
  // 时区固定北京时间（Asia/Shanghai，UTC+8 无夏令时）：此前 toTimeString() 在 CI(UTC)
  // 下显示 UTC 时间（11:14 实为北京 19:14），误导读者。
  const nowHm = opts.now
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(opts.now)
    : "";
  const hero = report.hero_line?.trim();
  // 微信/QQ/推特 等转发卡片元信息（2026-09-14 P1-2 + P0-4）：基址由调用方注入
  // （REPORT_BASE_URL → ctx.config.reportBaseUrl）。
  // 此前硬编码 fallback 指向**旧仓库** gzinfo 的 gh-pages 域，且本仓库不存在
  // og-image.png → 每次发布都带一个必然 404 的外域缩略图。
  // 现在的口径：baseUrl 为空则**完全不输出** og:image / twitter:image
  // （宁可无缩略图，也不指向他仓 404；同时 warn 提示配置缺失）。
  const shareBase = (opts.baseUrl ?? "").replace(/\/+$/, "");
  if (!shareBase) {
    console.warn(
      "[render] 未提供 baseUrl（REPORT_BASE_URL）→ 输出不含 og:image/twitter:image；" +
        "转发卡片将无缩略图。请在 CI/本地注入 REPORT_BASE_URL 指向本仓 Pages 根。",
    );
  }
  const shareImageTags = shareBase
    ? `<meta property="og:image" content="${shareBase}/og-image.png">
<meta property="og:image:width" content="240">
<meta property="og:image:height" content="240">
`
    : "";
  const shareTwitterImage = shareBase
    ? `<meta name="twitter:image" content="${shareBase}/og-image.png">
`
    : "";
  const shareTitle = `${STR.siteTitle} · ${date}`;
  const shareDesc = hero
    ? `今日定调：${hero}`
    : "广州地区零售业务每日资信简报（个人整理，非本行立场）";

  return `<!doctype html>
<html lang="${REPORT_LOCALE === "en" ? "en" : "zh-CN"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${shareTitle}</title>
<meta name="description" content="${escapeHtml(shareDesc)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(shareTitle)}">
<meta property="og:description" content="${escapeHtml(shareDesc)}">
${shareImageTags}<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(shareTitle)}">
<meta name="twitter:description" content="${escapeHtml(shareDesc)}">
${shareTwitterImage}<style>
${stripCssComments(THEME_CSS)}
${stripCssComments(AUDIO_HIGHLIGHT_CSS)}
  /* 商机洞察客户客群标签 (2026-09-08) */
  .insight-segs { margin: 4px 0 6px; display: flex; flex-wrap: wrap; gap: 5px; }
  .seg-chip { font-size: 11px; font-weight: 600; border-radius: 9px; padding: 1px 8px; line-height: 1.7; white-space: nowrap; }
  .seg-chip.seg-aum { color: #fff; background: #b8860b; }
  .seg-chip.seg-private { color: #fff; background: #8e44ad; }
  .seg-chip.seg-inclusive { color: #fff; background: #1e7e34; }
  .seg-chip.seg-other { color: #555; background: #ececec; }
  </style>
</head>
<body>
<main>
    ${opts.audio ? `<div class="player-card">
    <div class="player-title"><span class="ic">🎧</span> 今日语音简报 <span class="player-dur">${escapeHtml(opts.audio.duration)}</span>${opts.audio.backend ? `<span class="player-badge player-badge-${opts.audio.backend}">${opts.audio.backend === "tencent" ? "腾讯合成" : "开源合成"}</span>` : ""}</div>
    <audio controls preload="none" src="${escapeHtml(opts.audio.src)}" id="audio-player"></audio>
    ${opts.audio.segments && opts.audio.segments.length ? `<script type="application/json" id="audio-segments">${escapeHtml(JSON.stringify(opts.audio.segments))}</script>` : ""}
  </div>` : ""}
  <!-- 报头：今日定调 + 数据截至 -->
  <header class="masthead">
    <div class="eyebrow">广州地区 · 零售业务每日资信（个人整理，非本行立场）</div>
    <h1>${zhDate}</h1>
    ${hero ? `<p class="hero-line">今日定调：${escapeHtml(hero)}</p>` : ""}
    <p class="meta-line">${nowHm ? `数据截至 ${nowHm} · ` : ""}去重后资讯 ${totalItems} 条 · 商机 ${report.insights?.length ?? 0} 条${opts.webMode === true ? ` · <a class="archive" href="../archive.html">${STR.archiveLink}</a>` : ""}</p>
  </header>

  ${renderReportExec(report)}

  ${renderStockRecap(report)}

  <!-- 板块导航：单层 tab，移动端横滑不折行 -->
  <nav class="tabs">
    ${tabs.map((t, i) => `<button class="tab${i === 0 ? " active" : ""}" data-target="${t.id}" style="--cat:${t.cls}">${t.label}<span class="n">${t.count}</span></button>`).join("")}
  </nav>

  ${tabs.map((t, i) => `<section class="panel${i === 0 ? " active" : ""}" id="${t.id}">
    ${
      t.id === "p-stock"
        ? renderStockFilterBar()
        : t.id === "p-ipo"
          ? renderIpoFilterBar(t.items)
          : renderFilterBarForPanel(t.items)
    }
    ${
      t.items.length
        ? t.id === "p-ipo"
          ? renderIpoPanelHtml(t.items)
          : renderReportCardList(t.items, true)
        : `<p class="empty-hint">${escapeHtml(t.emptyHint || "今日暂无相关内容")}</p>`
    }
  </section>`).join("")}

  <footer>
    <p>免责声明：本页面为个人学习项目，内容基于公开信息整理，不代表任何机构立场；市场信息不构成投资建议。页面面向内部参考，请勿外传。</p>
    ${opts.webMode === true ? `<p><a class="archive" href="../archive.html">${STR.archiveLink}（8月20日 / 8月19日 / 更多 →）</a></p>` : ""}
  </footer>
</main>
<script>
  // tab 切换（单层五板块）
  document.querySelectorAll('.tabs > .tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = btn.dataset.target;
      document.querySelectorAll('.tabs > .tab').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      document.querySelectorAll('.panel').forEach(function (p) {
        p.classList.toggle('active', p.id === target);
      });
    });
  });
  // 空板块保险：panel 无卡片则连同 tab 移除
  document.querySelectorAll('.panel').forEach(function (panel) {
    if (panel.querySelectorAll('.brief').length === 0) {
      var tab = document.querySelector('.tab[data-target="' + panel.id + '"]');
      if (tab) tab.remove();
      panel.remove();
    }
  });
  // 展开其余 N 条
  document.querySelectorAll('.expand-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var panel = btn.closest('.panel');
      if (panel) panel.classList.add('expanded');
      btn.remove();
    });
  });
  // 板块内标签筛选（两维度：来源 OR、业务线 OR；维度间 AND；全不选 / 全选 = 全部显示）
  document.querySelectorAll('.filter-bar').forEach(function (bar) {
    var panel = bar.closest('.panel');
    if (!panel) return;
    bar.addEventListener('click', function (e) {
      var chip = e.target.closest('.filter-chip');
      if (chip) { chip.classList.toggle('active'); applyFilter(panel, bar); return; }
      if (e.target.closest('.filter-reset')) {
        bar.querySelectorAll('.filter-chip.active').forEach(function (c) { c.classList.remove('active'); });
        applyFilter(panel, bar);
      }
    });
  });
  function applyFilter(panel, bar) {
    var chips = bar.querySelectorAll('.filter-chip');
    var active = Array.prototype.filter.call(chips, function (c) { return c.classList.contains('active'); });
    var btn = panel.querySelector('.expand-btn');
    // 广东IPO 四阶段分栏：过滤后隐藏「无可见卡片」的整组（否则会留下空组标题）
    function syncGroups() {
      panel.querySelectorAll('.ipo-group').forEach(function (grp) {
        var visible = grp.querySelectorAll('.brief:not(.filtered-out)').length;
        grp.classList.toggle('filtered-out', visible === 0);
      });
    }
    // 全不选（重置）或全选 → 全部显示，并恢复「前 5 展示 + 其余折叠」的默认布局
    if (active.length === 0 || active.length === chips.length) {
      panel.classList.remove('expanded');
      if (btn) btn.style.display = '';
      panel.querySelectorAll('.brief').forEach(function (card) { card.classList.remove('filtered-out'); });
      syncGroups();
      return;
    }
    // 筛选生效：自动展开折叠区——命中项（含原折叠区内）无需再点「展开」即可见，
    // 与查询结果刷新的预期联动；隐藏展开按钮，避免出现「仍提示折叠 N 条」的错位。
    panel.classList.add('expanded');
    if (btn) btn.style.display = 'none';
    // 按维度（data-group）分组收集选中值
    var selByGroup = {};
    active.forEach(function (c) {
      var g = c.getAttribute('data-group');
      (selByGroup[g] = selByGroup[g] || []).push(c.getAttribute('data-filter'));
    });
    panel.querySelectorAll('.brief').forEach(function (card) {
      var src = card.getAttribute('data-source');
      var tags = (card.getAttribute('data-tags') || '').split(' ').filter(Boolean);
      var market = card.getAttribute('data-market');
      var stage = card.getAttribute('data-stage') || '';
      var ok = true;
      for (var g in selByGroup) {
        var sel = selByGroup[g];
        if (g === 'src') {
          // 维度内 OR：命中官方 / 媒体 其一即满足
          if (sel.indexOf(src) < 0) { ok = false; break; }
        } else if (g === 'market') {
          // 股市动态面板：按 A股 / 港股 / 美股 过滤（维度内 OR）
          if (sel.indexOf(market) < 0) { ok = false; break; }
        } else if (g === 'stage') {
          // 广东IPO 面板：按四阶段过滤（维度内 OR）；「__none__」= 阶段待定（无阶段信号）
          var stageHit = sel.some(function (f) { return f === '__none__' ? stage === '' : stage === f; });
          if (!stageHit) { ok = false; break; }
        } else {
          // 维度内 OR：命中业务线其一即满足；「__none__」（其他）命中空标签卡片
          var hit = sel.some(function (f) {
            if (f === '__none__') return tags.length === 0; // 其他 = 无 4 部门标签
            return tags.indexOf(f) >= 0;
          });
          if (!hit) { ok = false; break; }
        }
      }
      card.classList.toggle('filtered-out', !ok);
    });
    syncGroups();
  }
</script>
${opts.audio?.segments && opts.audio.segments.length ? `<script>
${generateAudioHighlightScript()}
</script>` : ""}
</body>
</html>`;
}
