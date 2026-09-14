/**
 * 滚动历史库（纯函数层；自 gzinfo lib/output/history.ts 移植，IO 拆至 adapters/persistence）。
 *
 * 职责（与 gzinfo 语义一致）：
 *  1. **滚动 backlog** — 抓取窗口（今天+昨天，日历日口径）内的条目保留在库中，
 *     供渲染层滚动并入近 7 天历史（mergeRollingIntoReport）；
 *  2. **AI 解读缓存** — url 已有 summary 的条目，SKIP_AI / 重跑时直接复用，省 LLM。
 *
 * 文件为公开提交（data/article-history.json，随 CI 归档提交回 main），跨运行生效。
 *
 * 架构调整（2.0 端口架构）：gzinfo 的 saveHistory 为「merge+写盘」一体；此处拆为
 * mergeHistory 纯函数（本文件）+ persistHistory（adapters），写盘时机不变。
 */

import type { ArticleInput } from "../../contracts/article";
import type { SourceDef } from "../../contracts/source";
import { todayKey, isWithinCalendarDays } from "../../utils/time";

/** 抓取窗口（天）：源层前置窗口过滤 + 滚动历史均以此为准（用户 2026-08-22 要求：抓 2 天）。 */
export const FETCH_WINDOW_DAYS = 2;

export interface HistoryEntry {
  title: string;
  url: string;
  sourceId: string;
  source: string;
  category: string;
  /** 条目级子标签：AI/启发式逐条分类结果（覆盖注册表源级）；由分析脚本写入。 */
  subcategory?: string;
  /** 条目级多标签（AI 分类，多值）：非空时渲染多归桶；subcategories 优先于 subcategory。 */
  subcategories?: string[];
  excerpt?: string;
  /** ISO string (from article.publishedAt). */
  publishedAt?: string;
  /** AI-generated summary in the active REPORT_LOCALE, if analyzed before. */
  summary?: string;
  /** 条目级相关性：false = 与银行业务无关，渲染时过滤；由分析脚本写入。 */
  ai_relevant?: boolean;
  /** ISO — first time we saw this URL. */
  firstSeenAt: string;
  /** ISO — most recent run that carried this URL. Used for 7-day pruning by occurrence time. */
  lastSeenAt: string;
}

export type HistoryStore = Record<string, HistoryEntry>;

/**
 * 滚动窗口判定（gzinfo 2026-08-31 由 48h 滑动窗口改为**日历日窗口**）。
 *
 * 条目的发布日期在报告时区(REPORT_TZ)下 ∈ {今天, 昨天}（FETCH_WINDOW_DAYS=2）即在窗口内，
 * 严格对应漏斗三「今天新增 + 昨天有效」语义（用户 2026-08-29 拍板）。
 * 以**发生时间** publishedAt 为准，非分析时间 lastSeenAt。
 * 时间红线：**无真实发布时间的条目一律剔除**。
 * 例外：发布时间为未来（源站时区错误）→ 回退 lastSeenAt 日历日判定（必要容错，2026-08-20）。
 */
function isFreshEntry(e: HistoryEntry, now: Date): boolean {
  // 时间红线：无真实发布时间 → 直接剔除
  if (!e.publishedAt) return false;
  const pubKey = todayKey(new Date(e.publishedAt));
  const todayKeyStr = todayKey(now);
  // 发布时间为未来（异常/源站时区错误）→ 不按发布时间判新鲜，回退 lastSeenAt
  if (pubKey > todayKeyStr) {
    return e.lastSeenAt ? isWithinCalendarDays(e.lastSeenAt, FETCH_WINDOW_DAYS, now) : false;
  }
  return isWithinCalendarDays(e.publishedAt, FETCH_WINDOW_DAYS, now);
}

/** Drop entries outside the rolling window — measured by occurrence time (publishedAt). */
export function pruneHistory(store: HistoryStore, now: Date): HistoryStore {
  const out: HistoryStore = {};
  for (const [url, e] of Object.entries(store)) {
    if (isFreshEntry(e, now)) out[url] = e;
  }
  return out;
}

function entryToArticle(e: HistoryEntry, fetchedToday: boolean): ArticleInput {
  return {
    sourceId: e.sourceId,
    title: e.title,
    url: e.url,
    excerpt: e.excerpt,
    publishedAt: e.publishedAt ? new Date(e.publishedAt) : undefined,
    // 2026-08-27 核心规则：无发布时间直接 undefined — history 中无 publishedAt 的
    // 条目在 buildRolling 时被 no-date-fallback 阶段丢弃，不再写 fetchedAt 兜底。
    category: e.category as ArticleInput["category"],
    summary: e.summary,
    source: e.source,
    fetchedToday,
    // 条目级 AI/启发式分类透传
    ...(e.subcategory ? { subcategory: e.subcategory } : {}),
    ...(e.subcategories ? { subcategories: e.subcategories } : {}),
    ...(e.ai_relevant !== undefined ? { relevant: e.ai_relevant } : {}),
  } as ArticleInput;
}

/**
 * Merge today's freshly-fetched articles with the rolling history into a
 * single list, tagging each with `fetchedToday`. Today's items win on URL
 * collision (so an updated title/excerpt/summary for a recurring URL shows
 * under "当天"). History entries outside the window (by occurrence time) are dropped.
 */
export function buildRolling(
  today: ArticleInput[],
  history: HistoryStore,
  now: Date,
): ArticleInput[] {
  const map = new Map<string, ArticleInput>();
  // 当天已处理的内容（lastSeenAt=今天，含预 AI 分析写入的当日条目）标记为
  // fetchedToday=true 参与「当天」视图——否则预分析/当天早跑写入的条目当天不展示，
  // 而新抓同主题又被跨天判重挡掉，导致当天面板空洞（gzinfo 2026-08-19 用户反馈）。
  const todayStr = todayKey(now);
  for (const e of Object.values(history)) {
    if (!isFreshEntry(e, now)) continue;
    const isToday = typeof e.lastSeenAt === "string" && e.lastSeenAt.startsWith(todayStr);
    map.set(e.url, entryToArticle(e, isToday));
  }
  for (const a of today) {
    // 当天抓到的旧链接（publishedAt 不在日历窗口 今天+昨天 内）：不属于「今天/昨天」
    // 简报，直接丢弃不进渲染。无 publishedAt 的条目不受此限制（无法判断发文时间，
    // 靠 fetchedToday 归属——上游 no-date 阶段已丢弃，此处防御）。
    if (a.publishedAt && !isWithinCalendarDays(a.publishedAt, FETCH_WINDOW_DAYS, now)) continue;
    // Today's items win on URL collision, but keep the history's per-item
    // AI analysis (subcategory / relevance / summary) when today's fetch
    // didn't carry one — otherwise real-time fetches would wipe it.
    // 注意：直接查 history 原对象（而非 map）——超窗口条目会被 isFreshEntry 排除出
    // rolling map，但 AI 解读仍需继承。
    const h = history[a.url];
    const merged = { ...a } as ArticleInput & { fetchedToday?: boolean };
    merged.fetchedToday = true;
    if (h?.subcategory && !merged.subcategory) merged.subcategory = h.subcategory;
    if (h?.subcategories && !merged.subcategories) merged.subcategories = h.subcategories;
    if (h?.ai_relevant !== undefined && merged.relevant === undefined) {
      merged.relevant = h.ai_relevant;
    }
    if (h?.summary && !merged.summary) merged.summary = h.summary;
    map.set(a.url, merged as ArticleInput);
  }
  return Array.from(map.values());
}

/**
 * 把今日条目（含本轮携带的摘要/打标）并入历史库，bump lastSeenAt，返回新 store。
 * 纯函数（gzinfo saveHistory 的 merge 部分；写盘由 adapters/persistence.persistHistory 负责）。
 *
 * 相关性保留语义：本轮有判定用本轮（AI 重跑可更新），本轮无判定（SKIP_AI/dry-run）
 * 保留历史打标——避免预分析回的 ai_relevant=false 被 SKIP_AI 覆盖丢失。
 */
export function mergeHistory(
  today: ArticleInput[],
  history: HistoryStore,
  nowIso: string,
  subcatBySource: Map<string, string | undefined> = new Map(),
  now: Date,
): HistoryStore {
  const store = pruneHistory(history, now);
  for (const a of today) {
    const prev = store[a.url];
    // 条目级 AI 分类优先，注册表源级兜底（gzinfo subcatOf：SOURCE_ROUTE 优先、注册表兜底；
    // 2.0 用 ctx.sources 构建的 subcatBySource 查注册表，同一数据源）
    const subcat = a.subcategory ?? subcatBySource.get(a.sourceId);
    store[a.url] = {
      title: a.title,
      url: a.url,
      sourceId: a.sourceId,
      source: a.source ?? "",
      category: a.category as string,
      ...(subcat ? { subcategory: subcat } : {}),
      ...(a.subcategories ? { subcategories: a.subcategories } : {}),
      ...(a.relevant !== undefined
        ? { ai_relevant: a.relevant }
        : prev?.ai_relevant !== undefined
          ? { ai_relevant: prev.ai_relevant }
          : {}),
      excerpt: a.excerpt,
      publishedAt: a.publishedAt?.toISOString(),
      // Keep a previously-cached summary if this run produced none
      // (e.g. dry-run has no AI — don't clobber good history).
      summary: a.summary || prev?.summary,
      firstSeenAt: prev?.firstSeenAt ?? nowIso,
      lastSeenAt: nowIso,
    };
  }
  return store;
}

/** sourceId → subcategory 索引（组合根从 ctx.sources 构建，供 mergeHistory 兜底查询）。 */
export function buildSubcatIndex(sources: SourceDef[]): Map<string, string | undefined> {
  return new Map(sources.map((s) => [s.id, s.subcategory]));
}
