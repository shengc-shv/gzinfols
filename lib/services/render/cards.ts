/**
 * 渲染卡片/面板（M3-C 二期拆分自 lib/output/render.ts）：
 * 单篇文章卡片、来源 tab、L2 子面板、分类面板与共享类型。
 */
import type { ArticleInput } from "../../contracts/article";
import type { Category } from "../../contracts/source";
import { STR } from "./i18n";
import { type SourceTier } from "../../contracts/source";
import { REPORT_LOCALE } from "./locale";
import { getReportTz, isWithinCalendarDays } from "../../utils/time";

// 2026-09-14 Phase 2b：分类标签 / 排序 / 日期精度判定已下沉至 services/vocab
// （解开 assemble → render 反向依赖）。此处 import 供本文件内部使用，并 re-export
// 保持既有 import 路径可用。
import { isDateOnly, sortByTierAndTime } from "../vocab";
export { CATEGORY_LABELS, hasDeptTag, isDateOnly, sortByTierAndTime } from "../vocab";

// ----- types -----
export type SourceGroup = {
  sourceId: string;
  sourceName: string;
  items: ArticleInput[];
  /**
   * When true, items come from multiple merged sources and the renderer
   * should label each article with `a.source` since the source-tab row
   * is suppressed (only one synthetic group).
   */
  merged?: boolean;
};

export type SubGroup = {
  id: string;
  name: string;
  sources: SourceGroup[];
};

export type RawByCategory = Record<Category, SubGroup[]>;

export const CATEGORY_DIGEST_LABELS: Record<Category, string> = {
  tech: STR.catTech,
  finance: STR.catFinance,
  politics: STR.catPolitics,
  'gd-ipo': STR.catGdIpo,
  ipo: STR.catIpo,
  gz: '广州商机',
  stocks: '昨日股市',
};

/**
 * 展示窗口（天）：所有面板统一展示最近 N 天发布的内容，按发布时间倒序。
 * （2026-08-19 用户调整：不再区分「当天/过去7天」时间拆分；2026-08-22 改为与
 * 抓取窗口一致，只展示最近 2 天发布的内容，抓取窗口见 history.ts 的 FETCH_WINDOW_DAYS。）
 */
export const DISPLAY_WINDOW_DAYS = 2;



export const TECH_MAIN_SUBS = new Set(["cn-tech", "overseas-tech"]);
export const TECH_COMMUNITY_SUBS = new Set(["cn-community", "overseas-community"]);

// ----- HTML helpers -----

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatDate(d: Date | undefined): string {
  if (!d) return "";
  try {
    // 只有日期（无时分）→ 展示日期；有真实时分 → 展示 MM/DD HH:mm
    // （2026-08-21 用户要求：有小时分钟展示到小时分钟，没有则展示日期）
    if (isDateOnly(d)) return tzDateStr(d);
    // zh: "05/20 16:00"  · en: "May 20, 4:00 PM" → keep 24h en-GB style "20/05 16:00"
    const localeTag = REPORT_LOCALE === "en" ? "en-GB" : "zh-CN";
    return d.toLocaleString(localeTag, {
      timeZone: getReportTz(),
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return "";
  }
}

// ----- raw article renderers -----

/**
 * 内容判定词表与候选函数 —— **单一真源**在 `services/enrich/heuristics.ts`。
 *
 * 2026-09-14（P0-3）：本文件此前逐字复制了该模块的全部词表与 3 个候选函数
 * （8 个正则 + isGzLocalCandidate / isPolicyMarketCandidate / isGdIpoCandidate），
 * 与 enrich 侧共用却各存一份 —— 调一处不生效的典型隐患（同日实测两份逐字相同，
 * 靠人工比对才能发现）。现统一从此处 re-export，保持既有 import 路径可用；
 * 词表修改只需改 heuristics.ts 一处。
 */
export {
  GZ_ANCHOR_RE,
  GZ_BUSINESS_RE,
  isGzLocalCandidate,
  isPolicyMarketCandidate,
  FOREIGN_REGION_RE,
  POLICY_ACTION_RE,
  MARKET_SIGNAL_RE,
  IPO_PROGRESS_RE,
  IPO_CAPITAL_ACT_RE,
  IPO_FLOW_RE,
  isGdIpoCandidate,
} from "../enrich/heuristics";

/** 来源徽章（2026-08-21 重构 #12：来源降级为卡片左上角徽章，扫一眼即知可信度） */
export function srcBadgeOf(a: ArticleInput): { label: string; cls: string } {
  const sid = a.sourceId || "";
  if (a.tier === "T1") {
    if (sid === "govcn-policy") return { label: "政策", cls: "src-official" };
    if (sid === "pbc") return { label: "央行", cls: "src-official" };
    if (sid === "nfra") return { label: "监管", cls: "src-official" };
    if (sid === "fed-press") return { label: "央行", cls: "src-official" };
    if (a.category === "ipo" || a.category === "gd-ipo") return { label: "交易所", cls: "src-official" };
    return { label: "官方", cls: "src-official" };
  }
  if (a.tier === "T1.5") {
    if (a.category === "ipo" || a.category === "gd-ipo") return { label: "交易所", cls: "src-official" };
    return { label: "机构", cls: "src-official" };
  }
  if (a.subcategory === "news") return { label: "海外", cls: "src-media" };
  return { label: "媒体", cls: "src-media" };
}

export function renderArticleHtml(a: ArticleInput, showSource = false): string {
  const title = escapeHtml(a.title_cn || a.title);
  const url = escapeHtml(a.url);
  // Backwards-compat: old sidecar JSON files may carry `cnSummary` instead.
  const summaryText = a.summary ?? (a as unknown as { cnSummary?: string }).cnSummary;
  const summary = summaryText ? escapeHtml(summaryText) : "";
  const time = formatDate(a.publishedAt ?? a.fetchedAt);
  const badge = srcBadgeOf(a);
  const srcName = showSource && a.source ? escapeHtml(a.source) : "";
  // 2026-09-07 用户要求：IPO 条目同时展现东财列表链接（主 url）与交易所官方源入口
  // （officialUrl，人工核查用，交易所级栏目不做公司级反查）。仅 IPO 板块展示，其余类别忽略。
  const official =
    a.officialUrl && (a.category === "ipo" || a.category === "gd-ipo")
      ? `<p class="official-src">交易所官方源：<a href="${escapeHtml(a.officialUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(a.officialLabel || a.officialUrl)}</a></p>`
      : "";
  return `<article class="brief">
  <div class="bm"><span class="src-badge ${badge.cls}">${badge.label}</span>${srcName ? `<span>${srcName}</span>` : ""}${time ? `<span>${time}</span>` : ""}</div>
  <h3><a href="${url}" target="_blank" rel="noopener noreferrer">${title}</a></h3>
  ${summary ? `<p class="sum">${summary}</p>` : ""}
  ${official}
</article>`;
}

/**
 * 面板卡片列表（2026-08-21 重构 #13：每板块默认 Top 5 + 「展开其余 N 条」）。
 * 前 5 条直接展示；多于 5 条的隐藏于 .brief.more，底部虚线按钮点击展开（panel 加 expanded）。
 */
export function renderCardList(items: ArticleInput[], showSource = true): string {
  if (items.length === 0) return `<p class="empty">${STR.emptySource}</p>`;
  const top = items.slice(0, 5);
  const more = items.slice(5);
  let html = top.map((a) => renderArticleHtml(a, showSource)).join("\n");
  if (more.length > 0) {
    html +=
      more.map((a) => renderArticleHtml(a, showSource).replace('<article class="brief">', '<article class="brief more">')).join("\n") +
      `<button class="expand-btn" type="button">展开其余 ${more.length} 条</button>`;
  }
  return html;
}

export function renderSourceContent(
  category: Category,
  subId: string,
  source: SourceGroup,
  isActive: boolean,
): string {
  const showSource = source.merged === true;
  return `<div class="source-content${isActive ? " active" : ""}" data-source-content="${escapeHtml(source.sourceId)}" data-sub="${escapeHtml(subId)}" data-cat="${category}">
    ${source.items.length === 0 ? `<p class="empty">${STR.emptySource}</p>` : source.items.map((a) => renderArticleHtml(a, showSource)).join("\n")}
  </div>`;
}

/**
 * 合并流按权威等级拆「官方 / 媒体」两个子标签 tab（任务三 #43 改版）：
 * 官方 tab 默认展示（T1 官方一手 + T1.5 准官方·机构），媒体 tab（T2 媒体·智库）。
 * 广州商机面板（单一 gz-all 合并流）同样采用此结构（2026-08-21 用户）。
 * 拆分只在渲染层，过滤/去重逻辑不变；tab 内仍按 sortByTierAndTime 排序。
 */
function isOfficialTier(tier?: SourceTier): boolean {
  return tier === "T1" || tier === "T1.5";
}

function renderBandPanel(kind: string, items: ArticleInput[], showSource: boolean, active = false): string {
  const body =
    items.length === 0
      ? `<p class="empty">${STR.emptySource}</p>`
      : items.map((a) => renderArticleHtml(a, showSource)).join("\n");
  return `<div class="band-panel${active ? " active" : ""}" data-band-panel="${kind}">${body}</div>`;
}

export function renderBandedFeed(items: ArticleInput[], showSource = false): string {
  const official = sortByTierAndTime(items.filter((a) => isOfficialTier(a.tier)));
  const media = sortByTierAndTime(items.filter((a) => !isOfficialTier(a.tier)));
  const tabs = `<nav class="band-tabs">
    <button class="band-tab active" data-band="official">${escapeHtml(STR.bandOfficial)}<span class="count">${official.length}</span></button>
    <button class="band-tab" data-band="media">${escapeHtml(STR.bandMedia)}<span class="count">${media.length}</span></button>
  </nav>`;
  return `${tabs}${renderBandPanel("official", official, showSource, true)}${renderBandPanel("media", media, showSource)}`;
}

export function renderSourceTabs(
  category: Category,
  subId: string,
  sources: SourceGroup[],
): string {
  // L3 信息源 tabs 已停用（2026-08-21 用户要求：渲染只到子标签）：
  // 所有子标签统一构造成单一 _merged source（merged:true），此处恒返回空串，
  // 来源信息降级为卡片 meta 行的来源小字。
  if (sources.length < 2) return "";
  return `<nav class="source-tabs">${sources
    .map(
      (s, i) =>
        `<button class="source-tab${i === 0 ? " active" : ""}" data-source="${escapeHtml(s.sourceId)}" data-sub="${escapeHtml(subId)}" data-cat="${category}">${escapeHtml(s.sourceName)}<span class="count">${s.items.length}</span></button>`,
    )
    .join("")}</nav>`;
}

/**
 * 保留每个源中「最近 days 天」的条目，并按 sortByTierAndTime 排序
 * （tier 权威等级 + 发布时间，只有日期的放最后）。
 * 时间红线（2026-08-29 用户）：无真实发布时间的条目一律丢弃，不回退 fetchedAt
 * 兜底（采集时间不是发布时间）。
 */
export function filterRecentDays(sources: SourceGroup[], days = DISPLAY_WINDOW_DAYS): SourceGroup[] {
  // 日历日窗口（2026-08-31 修复）：发布日期(报告时区)∈ 最近 days 个日历日，替代 48h 滑动。
  // 与抓取/滚动窗口口径统一（今天+昨天，days=2）。
  return sources.map((s) => {
    const items = s.items.filter((a) => isWithinCalendarDays(a.publishedAt, days));
    return { ...s, items: sortByTierAndTime(items) };
  });
}

let _tzFmt: Intl.DateTimeFormat | undefined;
/** Report-timezone date string "YYYY-MM-DD" for a Date. */
export function tzDateStr(d: Date): string {
  if (!_tzFmt) {
    _tzFmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: getReportTz(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  return _tzFmt.format(d);
}


export function countItems(sources: SourceGroup[]): number {
  return sources.reduce((n, s) => n + s.items.length, 0);
}

/** 最近 N 天（默认 DISPLAY_WINDOW_DAYS）的条数合计——顶部 tab 徽标。 */
export function countItemsRecent(subs: SubGroup[], days = DISPLAY_WINDOW_DAYS): number {
  return subs.reduce((n, sg) => n + countItems(filterRecentDays(sg.sources, days)), 0);
}

export function renderSourcesBlock(
  category: Category,
  subId: string,
  sources: SourceGroup[],
): string {
  if (sources.length === 0) {
    return `<p class="empty">${STR.emptySource}</p>`;
  }
  // 合并流（子标签内单一 _merged 源）：按权威等级拆「官方 / 媒体」tab（任务三 #43 改版）
  // 广州商机面板的单一 gz-all 合并流同样走此结构（2026-08-21 用户）。
  if (sources.length === 1 && sources[0].merged === true) {
    return renderBandedFeed(sources[0].items, true);
  }
  return `${renderSourceTabs(category, subId, sources)}
  <div class="source-contents">
    ${sources.map((s, i) => renderSourceContent(category, subId, s, i === 0)).join("\n")}
  </div>`;
}

/**
 * 广东地区 IPO 各上市阶段对应的「股份行广州分行商机线索」（任务二）。
 * 静态规则提示，帮助零售条线领导从 IPO 动态中快速定位可跟进的商机动作。
 */
export const GD_IPO_STAGE_BIZ: Record<string, string> = {
  "stage-listed":
    "商机线索 · 已上市新股：可跟进 员工持股计划/股权激励理财、高管私行、募资后代发工资",
  "stage-registered":
    "商机线索 · 注册生效·过会（即将发行）：募资入账在即，可对接 机构合作、代发工资、员工财富管理",
  "stage-reviewing":
    "商机线索 · 在审·已受理：Pre-IPO 授信、投贷联动、员工持股计划储备商机",
  "stage-tutoring":
    "商机线索 · 辅导备案·Pre-IPO（最佳商机）：Pre-IPO 授信、投贷联动、代发工资、高管私行、员工持股托管",
};

export function renderSubContent(category: Category, sub: SubGroup, isActive: boolean, date: string): string {
  const activeCls = isActive ? " active" : "";
  const subAttr = `data-sub-content="${escapeHtml(sub.id)}" data-cat="${category}"`;

  // 空 sub 直接占位
  if (sub.sources.length === 0) {
    return `<div class="sub-content${activeCls}" ${subAttr}><p class="empty">${STR.emptySource}</p></div>`;
  }

  // 统一展示窗口（2026-08-19 用户调整）：所有分类展示最近 DISPLAY_WINDOW_DAYS 天
  // 发布的内容，按发布时间倒序；不再区分「当天 / 过去7天」时间拆分。
  const recent = filterRecentDays(sub.sources, DISPLAY_WINDOW_DAYS);
  // 任务二：广东地区 IPO 各阶段栏顶部注入「股份行广州分行商机线索」提示
  const bizTip = category === "gd-ipo" ? GD_IPO_STAGE_BIZ[sub.id] : undefined;
  return `<div class="sub-content${activeCls}" ${subAttr}>
    ${bizTip ? `<p class="biz-tip">${escapeHtml(bizTip)}</p>` : ""}
    ${renderSourcesBlock(category, sub.id, recent)}
  </div>`;
}

export function renderRawCategoryPanel(
  category: Category,
  subs: SubGroup[],
  date: string,
): string {
  if (subs.length === 0) {
    return `<p class="empty">${STR.emptyCategory}</p>`;
  }
  if (subs.length === 1) {
    return renderSubContent(category, subs[0], true, date);
  }
  const subTabs = subs
    .map((s, i) => {
      // 计数与内容口径一致：最近 DISPLAY_WINDOW_DAYS 天、按发布时间倒序
      const count = countItems(filterRecentDays(s.sources, DISPLAY_WINDOW_DAYS));
      return `<button class="sub-tab${i === 0 ? " active" : ""}" data-sub="${escapeHtml(s.id)}" data-cat="${category}">${escapeHtml(s.name)}<span class="count">${count}</span></button>`;
    })
    .join("");
  const panels = subs
    .map((s, i) => renderSubContent(category, s, i === 0, date))
    .join("\n");
  return `<nav class="sub-tabs">${subTabs}</nav>\n<div class="sub-contents">${panels}</div>`;
}
