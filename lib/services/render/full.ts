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
import { stripCssComments } from "./css";
import type { AudioMeta } from "../voice";
import { selectTopMustRead } from "../enrich/select-top";
// 分行相关性评分器（纯函数、不调 LLM）：用于「未打标历史条目」的并入门槛（2026-08-29 方案③）
import { scoreBranchRelevance } from "../select/filters/relevance-score";
import {
  generateAudioHighlightScript,
  AUDIO_HIGHLIGHT_CSS,
  renderAudioChapters,
  renderAudioNowHint,
} from "./inline-player";
import { itemIdOf } from "../../utils/item-id";
import { renderDeltaBadge } from "./delta-badge";
import { PAGE_ACTIONS_CSS, generatePageActionsScript, renderFavBar, renderReportDateMeta } from "./page-actions";
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

// ----- C-1 Phase3：执行摘要 / 股市区块已外移到独立模块（纯搬移，行为零变化）-----
import { resolveTitleMap, renderReportExec, FOREIGN_REGION_RE } from "./exec-block";
import {
  renderStockIndexBlock,
  renderStockRecap,
  renderGdIpoStrip,
} from "./stock-block";
// mergeStoredExecutive 是**业务规则**，唯一实现在 assemble/merge-executive.ts；
// 此前本文件另有一份仅格式不同的副本（测试 import 的正是这份）—— 已收敛为纯 re-export，
// 并由 tests/merge-store-exec.test.ts 断言两处为同一引用，杜绝再次分叉。
export { mergeStoredExecutive } from "../assemble/merge-executive";

export * from "./exec-block";
export * from "./stock-block";


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
  renderRoleBar,
} from "./filter-bar";
import {
  ipoStageGroupLabel,
  renderIpoFilterBar,
  renderIpoProgress,
  renderIpoPanelHtml,
} from "./ipo-panel";
import { renderRedchipPanel } from "./redchip-panel";
import { renderCoverage } from "./coverage";
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
// 已迁至 render/css.ts（A2：避免 full → report-item → detail → full 循环依赖），
// 此处 re-export 保持既有调用点可用。
export { stripCssComments } from "./css";

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
  // 股市动态（底部消息清单，非 AI 生成）：直接来自 report.stock_news（三市场原始新闻）。
  // 补 id（A2）：卡片标题才能链到**站内详情页**而不是直链外链（与正文口径一致）；
  // id 由 url 派生，与 detailPagesOf 同源 → 详情页必然存在，不会是死链。
  const stockNews = (report.stock_news ?? [])
    .filter((it) => it.url)
    .map((it) => ({ ...it, id: it.id ?? itemIdOf(it.url) }));

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
${renderReportDateMeta(date)}
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
${stripCssComments(PAGE_ACTIONS_CSS)}
  /* C4 产品条线覆盖 (2026-09-17)：按揭 / 信用卡 / 代发 —— 未命中显式标「本期无」 */
  .product-coverage { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; margin: 0.5rem 0 0; font-size: 0.76rem; }
  .product-coverage .pc-label { color: var(--muted); }
  .pc-chip { padding: 0 0.45rem; border-radius: 999px; line-height: 1.8; white-space: nowrap; }
  .pc-hit { background: #e8f2ff; color: #1f4e9c; border: 1px solid #c3daf7; font-weight: 600; }
  .pc-none { background: var(--bg); color: var(--muted); border: 1px dashed var(--rule); }
  /* F1 同主题进展节点 (2026-09-17)：同主题被裁剪的报道折叠在卡片内 */
  .progress-nodes { margin: 0.4rem 0 0; font-size: 0.78rem; }
  .progress-nodes > summary { cursor: pointer; color: var(--muted); }
  .progress-nodes ul { margin: 0.3rem 0 0; padding-left: 1.1rem; line-height: 1.8; }
  .progress-nodes li { margin: 0.15rem 0; }
  .progress-nodes .pn-date { color: var(--muted); margin-right: 0.35rem; font-variant-numeric: tabular-nums; }
  .progress-nodes .pn-src { color: var(--muted); margin-left: 0.35rem; font-size: 0.72rem; }
  /* C1 角色视图条 (2026-09-17)：按条线一键筛选 */
  .role-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; margin: 0.85rem 0 0; }
  .role-label { font-size: 0.78rem; color: var(--muted); }
  .role-chip { font: inherit; font-size: 0.78rem; line-height: 1.9; padding: 0 0.55rem;
    border: 1px solid var(--rule); border-radius: 999px; background: var(--bg-elevated); color: var(--fg); cursor: pointer; }
  .role-chip.active { background: #2563eb; border-color: #2563eb; color: #fff; }
  .role-hint { font-size: 0.72rem; color: var(--muted); }
  /* C1 客群标签可点（原为纯展示 span） */
  button.seg-chip { font-family: inherit; cursor: pointer; border: none; }
  button.seg-chip:hover { filter: brightness(0.94); }
  /* A3 增量三态徽章 (2026-09-17)：新增 / 有进展 / 续报 */
  .delta-badge { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 8px;
    font-size: 10px; font-weight: 700; line-height: 1.7; vertical-align: middle; white-space: nowrap; }
  .delta-new { color: #fff; background: #1e7e34; }
  .delta-changed { color: #fff; background: #d97706; }
  .delta-followup { color: #5b6472; background: #eceef1; }
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
    ${renderAudioNowHint()}
    ${renderAudioChapters(opts.audio.segments ?? [])}
    ${opts.audio.segments && opts.audio.segments.length ? `<script type="application/json" id="audio-segments">${escapeHtml(JSON.stringify(opts.audio.segments))}</script>` : ""}
  </div>` : ""}
  <!-- 报头：今日定调 + 数据截至 -->
  <header class="masthead">
    <div class="eyebrow">广州地区 · 零售业务每日资信（个人整理，非本行立场）</div>
    <h1>${zhDate}</h1>
    ${hero ? `<p class="hero-line">今日定调：${escapeHtml(hero)}${renderDeltaBadge(report.heroDelta)}</p>` : ""}
    <p class="meta-line">${nowHm ? `数据截至 ${nowHm} · ` : ""}去重后资讯 ${totalItems} 条 · 商机 ${report.insights?.length ?? 0} 条${opts.webMode === true ? ` · <a class="archive" href="../archive.html">${STR.archiveLink}</a>` : ""}</p>
    ${renderCoverage(report, [
      ["广州本地", gzLocal.length],
      ["业务启示", bizInsight.length],
      ["政策与市场", policyMarket.length],
      ["科技前沿", techAll.length],
      ["广东IPO", ipoAll.length],
      ["股市动态", stockNews.length],
    ])}
  </header>

  ${renderReportExec(report)}

  ${renderStockRecap(report)}

  <!-- C1 角色视图：按条线一键筛选下方板块（再点一次取消） -->
  ${renderRoleBar()}

  <!-- E2 收藏栏（localStorage，纯前端；无收藏时只显示说明） -->
  ${renderFavBar()}

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

  ${renderRedchipPanel(report.redchipPanel)}

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
      // A1a：今日必读的「展开其余 N 条」也复用本按钮（容器为 .exec-must）
      var panel = btn.closest('.panel, .exec-must');
      if (panel) panel.classList.add('expanded');
      btn.remove();
    });
  });

  // A2 阅读位置：进详情页前记住滚动位置，返回时精确还原。
  // 详情页返回链接带 #<itemId>，浏览器会先定位到该卡片，随后这里再还原到离开时的
  // 精确位置（验收要求「返回后滚动位置一致」）。
  document.querySelectorAll('a.to-detail').forEach(function (a) {
    a.addEventListener('click', function () {
      try { sessionStorage.setItem('gz_scroll_' + location.pathname, String(window.scrollY || 0)); } catch (e) {}
    });
  });
  (function () {
    try {
      var k = 'gz_scroll_' + location.pathname;
      var v = sessionStorage.getItem(k);
      if (v !== null) {
        sessionStorage.removeItem(k);
        var y = parseInt(v, 10);
        if (!isNaN(y) && y > 0) window.scrollTo(0, y);
      }
    } catch (e) {}
  })();
  // —— 摘要 → 正文 站内跳转（F2）——
  // ⚠️ 目标卡片有**两重隐藏**，只处理「切 tab」是不够的（2026-09-17 用户实测「点了没反应」）：
  //   ① 常在**未激活**的 tab 面板内（.panel 非 active → display:none）；
  //   ② 还可能落在**折叠区**（.brief.more / A1a 的 .exec-must .must-more）→ 同样 display:none。
  //   对 display:none 的元素 scrollIntoView **不产生任何滚动**，故必须先「切面板 + 展开折叠」
  //   再滚动，否则表现为点了完全没反应。
  // 同一函数也用于「从详情页返回」——返回链接带 #itm-xxx，加载时同样需要这套前置动作。
  function gotoItem(id) {
    var el = document.getElementById(id);
    if (!el) return false;
    var panel = el.closest('.panel');
    if (panel) {
      document.querySelectorAll('.tabs > .tab').forEach(function (b) {
        b.classList.toggle('active', b.dataset.target === panel.id);
      });
      document.querySelectorAll('.panel').forEach(function (p) {
        p.classList.toggle('active', p.id === panel.id);
      });
      // ② 落在折叠区 → 先展开（与「展开其余 N 条」按钮同效，按钮同时移除避免错位）
      if (el.classList.contains('more')) {
        panel.classList.add('expanded');
        var eb = panel.querySelector('.expand-btn');
        if (eb) eb.remove();
      }
    }
    // A1a：今日必读的折叠区（摘要内跳转时可能出现）
    var mustBox = el.closest('.exec-must');
    if (mustBox && el.classList.contains('must-more')) mustBox.classList.add('expanded');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flash');
    setTimeout(function () { el.classList.remove('flash'); }, 1800);
    return true;
  }
  // 事件委托：动态内容也覆盖，且无需逐个绑定
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href^="#itm-"]') : null;
    if (!a) return;
    if (gotoItem(a.getAttribute('href').slice(1))) e.preventDefault();
  });
  // 进来就带锚点（详情页返回 / 分享链接带 #）→ 同样定位
  function onHash() {
    var m = /^#(itm-[A-Za-z0-9_-]+)$/.exec(location.hash || '');
    if (m) setTimeout(function () { gotoItem(m[1]); }, 60);
  }
  window.addEventListener('hashchange', onHash);
  onHash();
  // —— C1 客群切分轴 + 角色视图（2026-09-17）——
  // 与筛选条复用同一套 applyFilter：角色 = 预设一组业务线；客群标签 = 预设一个段位。
  // 都是「设置选中态 → 应用」，不新增匹配规则（避免两套判定漂移）。
  var ROLE_VIEWS = [];
  try { ROLE_VIEWS = JSON.parse((document.getElementById('role-views') || {}).textContent || '[]'); } catch (e) { ROLE_VIEWS = []; }
  var roleBar = document.getElementById('role-bar');
  var roleHint = document.getElementById('role-hint');
  var currentRole = null;
  var ROLE_HINT_DEFAULT = roleHint ? roleHint.textContent : '';
  function activatePanel(pid) {
    document.querySelectorAll('.tabs > .tab').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-target') === pid);
    });
    document.querySelectorAll('.panel').forEach(function (p) {
      p.classList.toggle('active', p.id === pid);
    });
  }
  // 按 { 维度: [值...] } 设置某面板筛选条选中态，并立即应用；返回是否有筛选条
  function setChips(panel, activeMap) {
    var bar = panel.querySelector('.filter-bar');
    if (!bar) return false;
    bar.querySelectorAll('.filter-chip').forEach(function (c) {
      var g = c.getAttribute('data-group');
      var v = c.getAttribute('data-filter');
      var want = activeMap[g];
      c.classList.toggle('active', !!want && want.indexOf(v) >= 0);
    });
    applyFilter(panel, bar);
    return true;
  }
  function applyRole(id) {
    var role = null;
    for (var i = 0; i < ROLE_VIEWS.length; i++) if (ROLE_VIEWS[i].id === id) role = ROLE_VIEWS[i];
    currentRole = role ? role.id : null;
    if (roleBar) {
      roleBar.querySelectorAll('.role-chip').forEach(function (c) {
        c.classList.toggle('active', !!role && c.getAttribute('data-role') === role.id);
      });
    }
    if (roleHint) {
      roleHint.textContent = role
        ? '当前视图：' + role.label + (role.tags.length ? '（' + role.tags.join('/') + '）' : '（全部）')
        : ROLE_HINT_DEFAULT;
    }
    document.querySelectorAll('.panel').forEach(function (panel) {
      setChips(panel, role && role.tags.length ? { tag: role.tags } : {});
    });
  }
  if (roleBar) {
    roleBar.addEventListener('click', function (e) {
      var chip = e.target && e.target.closest ? e.target.closest('.role-chip') : null;
      if (!chip) return;
      var id = chip.getAttribute('data-role');
      applyRole(currentRole === id ? null : id); // 再点一次 = 取消
    });
  }
  // 客群标签（商机洞察卡上）点击 → 按该客群筛选所有板块，并跳到第一个有命中的面板
  function applySegFilter(value) {
    var target = null;
    document.querySelectorAll('.panel').forEach(function (panel) {
      if (!setChips(panel, { seg: [value] })) return;
      if (!target && panel.querySelectorAll('.brief:not(.filtered-out)').length > 0) target = panel;
    });
    if (roleBar) roleBar.querySelectorAll('.role-chip').forEach(function (c) { c.classList.remove('active'); });
    currentRole = null;
    if (roleHint) roleHint.textContent = '已按客群筛选：' + value + '（点筛选条「重置」可清除）';
    if (target) {
      activatePanel(target.id);
      try { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (err) { target.scrollIntoView(); }
    }
  }
  document.addEventListener('click', function (e) {
    var chip = e.target && e.target.closest ? e.target.closest('button.seg-chip[data-seg]') : null;
    if (!chip) return;
    applySegFilter(chip.getAttribute('data-seg'));
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
        } else if (g === 'seg') {
          // C1 客群轴：卡片 data-segs（空格分隔）与选中段位有交集即满足；维度内 OR
          var segs = (card.getAttribute('data-segs') || '').split(' ').filter(Boolean);
          var segHit = sel.some(function (f) {
            return f === '__none__' ? segs.length === 0 : segs.indexOf(f) >= 0;
          });
          if (!segHit) { ok = false; break; }
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
<script>
${generatePageActionsScript()}
</script>
${opts.audio?.segments && opts.audio.segments.length ? `<script>
${generateAudioHighlightScript()}
</script>` : ""}
</body>
</html>`;
}
