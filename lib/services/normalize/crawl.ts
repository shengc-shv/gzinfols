/**
 * 爬虫产物归一化（C2 内部子模块）—— 自 gzinfo lib/ingest/merge.ts 逐字移植。
 *
 * 归一化纪律（与 gzinfo 一致）：本模块是**唯一**允许做以下事情的地方——
 *  1. region 三分流 + `gd-`→`gz-` 前缀改写（routeRegion / rewriteGzPrefix）
 *  2. 裸北京时间补 +08:00（normalizePubTime，2026-08-31 时区偏移 bug 修复）
 *  3. URL 日期兜底 publishedAt（extractDateFromUrl——URL 日期是真实发布时间的载体）
 *
 * 时间红线：无 publishedAt 的条目在此**不造时间**（publishedAt 留 undefined），
 * 由 normalizeOne（红线 #1 唯一裁决点）丢弃；绝不回退 fetchedAt。
 * 本模块全部为纯函数、无 IO，便于单测。
 */
import type { ArticleCategory, CrawledArticle, RawArticle } from "../../contracts/article";
import { extractDateFromUrl, isWithinCalendarDays } from "../../utils/time";
import { IPO_SOURCE_WINDOW_DAYS } from "../../ipo-config";

/** 爬虫产物 sourceId 前缀：gd-（广东全省）/ gz-（广州辖区，股份行广州分行重点）。 */
export const GD_PREFIX = "gd-";
export const GZ_PREFIX = "gz-";

/** 爬虫条目缺省 sourceId（条目未带 sourceId 时的兜底，与 gzinfo 常量一致）。 */
export const DEFAULT_SCRAPER_SOURCE_ID = "gd-local-scraper";
export const DEFAULT_GZ_SOURCE_ID = "gz-local";

/** 归一化 region 分流的目标分类。 */
export const REGION_GZ: ArticleCategory = "gz";
/** 广东（非广州辖区）企业 → 「广东地区IPO」板块。 */
export const REGION_GD_IPO: ArticleCategory = "gd-ipo";
export const REGION_IPO: ArticleCategory = "ipo";

/** 爬虫产物源的路由元数据（采集元数据兜底；最终板块归属一律由内容判定，红线 #2）。
 *  自 gzinfo lib/sources/constants.ts SOURCE_ROUTE 逐字移植。 */
export const SOURCE_ROUTE: Record<string, { category: ArticleCategory; subcategory?: string }> = {
  "gz-stats": { category: "gz", subcategory: "gz-customer" },
  "gz-gov": { category: "finance", subcategory: "gz-policy" },
  "nfra": { category: "finance", subcategory: "cn-policy" },
  "pbc": { category: "finance", subcategory: "cn-policy" },
  "cnfin": { category: "finance", subcategory: "cn-finance" },
  "stcn": { category: "finance", subcategory: "cn-finance" },
  "sina-bank": { category: "finance", subcategory: "cn-finance" },
  "cls": { category: "finance", subcategory: "cn-finance" },
  "guancha": { category: "finance", subcategory: "cn-finance" },
  "dayoo-gz": { category: "gz", subcategory: "gz-media" },
  "southcn": { category: "gz", subcategory: "gz-media" },
  "chinanews-gd": { category: "gz", subcategory: "gz-media" },
  "cnr-gd": { category: "gz", subcategory: "gz-media" },
  "gz-sse": { category: "gz", subcategory: "gz-ipo" },
  "gz-szse": { category: "gz", subcategory: "gz-ipo" },
  "gz-bse": { category: "gz", subcategory: "gz-ipo" },
  "gz-hkex": { category: "gz", subcategory: "gz-ipo" },
  "gz-em-ipo": { category: "gz", subcategory: "gz-ipo" },
  "gd-local-scraper": { category: "ipo", subcategory: "news" },
  "szse": { category: "ipo", subcategory: "szse" },
  "hkex": { category: "ipo", subcategory: "hkex" },
  "hk-filing": { category: "ipo", subcategory: "hkex" },
  "sse": { category: "ipo", subcategory: "sse" },
  "bse": { category: "ipo", subcategory: "bse" },
  "gd-csrc-tutoring": { category: "gd-ipo", subcategory: "ipo-tutoring" },
  "gd-sse-audit": { category: "gd-ipo", subcategory: "ipo-audit" },
  "gd-szse-audit": { category: "gd-ipo", subcategory: "ipo-audit" },
  "gd-bse-audit": { category: "gd-ipo", subcategory: "ipo-audit" },
  "gd-listed-check": { category: "gd-ipo", subcategory: "stage-listed" },
  "hk-filing-gd": { category: "gd-ipo", subcategory: "ipo-hk" },
};

/**
 * 国内/香港源（+08:00）的裸时间字符串按北京时间解释（2026-08-31 时区偏移修复）。
 * 裸时间（含 HH:MM 且无时区后缀）强制补 `+08:00`；已有 `Z`/`±HH:MM` 后缀的不动；
 * 纯日期（无时间）不动。
 */
export function normalizePubTime(s: string | undefined): string | undefined {
  if (!s) return s;
  const t = s.trim();
  if (
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(t) &&
    !/[Zz]|[+-]\d{2}:?\d{2}$/.test(t)
  ) {
    return t.replace(" ", "T") + "+08:00";
  }
  return t;
}

/** 把爬虫产物的 sourceId 改写为 gz- 前缀（仅广州辖区条目）。 */
export function rewriteGzPrefix(sourceId: string): string {
  if (sourceId.startsWith(GZ_PREFIX)) return sourceId;
  return sourceId.startsWith(GD_PREFIX)
    ? `${GZ_PREFIX}${sourceId.slice(GD_PREFIX.length)}`
    : `${GZ_PREFIX}${sourceId}`;
}

export interface RouteOpts {
  /** gz 模式下的 category 兜底（SOURCE_ROUTE 查表值 / stocks 批次强制 "stocks"）。 */
  gzCategory?: ArticleCategory;
  /** ipo 模式下爬虫条目的 region 标记（'gz' → 归入广州辖区并改写 gz- 前缀）。 */
  region?: string;
}

/**
 * region 分流 + 前缀改写（gzinfo merge.ts routeRegion 逐字移植）。
 * - ipo 模式：region==='gz' → category='gz' 且 sourceId `gd-`→`gz-` 改写；
 *   region==='gd' → category='gd-ipo'；否则 category='ipo'。
 * - gz 模式：sourceId 原样保留，category 用 gzCategory ?? 'gz'。
 */
export function routeRegion(
  srcId: string,
  mode: "ipo" | "gz",
  opts: RouteOpts = {},
): { sourceId: string; category: ArticleCategory } {
  if (mode === "ipo") {
    const category =
      opts.region === "gz" ? REGION_GZ : opts.region === "gd" ? REGION_GD_IPO : REGION_IPO;
    const sourceId = category === REGION_GZ ? rewriteGzPrefix(srcId) : srcId;
    return { sourceId, category };
  }
  return { sourceId: srcId, category: opts.gzCategory ?? REGION_GZ };
}

/** 爬虫线格式 → RawArticle（publishedAt 可为 undefined，红线 #1 由 normalizeOne 裁决）。 */
export function crawledToRaw(
  item: CrawledArticle,
  mode: "ipo" | "gz",
  opts: RouteOpts = {},
): RawArticle {
  const srcId = item.sourceId || (mode === "ipo" ? DEFAULT_SCRAPER_SOURCE_ID : DEFAULT_GZ_SOURCE_ID);
  const { sourceId, category } = routeRegion(srcId, mode, {
    gzCategory: opts.gzCategory,
    region: item.region,
  });
  const resolvedPub = item.publishedAt || extractDateFromUrl(item.url);
  const parsed = resolvedPub ? new Date(normalizePubTime(resolvedPub)!) : undefined;
  return {
    sourceId,
    title: item.title || "无标题",
    url: item.url || "",
    excerpt: item.excerpt?.trim() || item.title?.slice(0, 90) || "",
    ...(parsed && !Number.isNaN(parsed.getTime()) ? { publishedAt: parsed } : {}),
    category,
    summary: item.summary || "",
    ...(item.tier ? { tier: item.tier } : {}),
    ...(item.officialUrl ? { officialUrl: item.officialUrl } : {}),
    ...(item.officialLabel ? { officialLabel: item.officialLabel } : {}),
    ...(item.ipoStage ? { ipoStage: item.ipoStage } : {}),
    ...(item.listedDate ? { listedDate: item.listedDate } : {}),
    ...(item.gdBasis ? { gdBasis: item.gdBasis } : {}),
    ...(item.registeredProvince ? { registeredProvince: item.registeredProvince } : {}),
    ...(item.stockCode ? { stockCode: item.stockCode } : {}),
    ...(item.subcategory ? { subcategory: item.subcategory } : {}),
  };
}

/**
 * 本地专供 IPO 条目的统一后处理（gzinfo normalizeLocalIpoItems 逐字移植）。
 * 1. 时间红线：无 publishedAt 一律丢弃；2. 窗口裁剪（日历日）；3. URL 去重
 * （无 URL 退化为 sourceId|title 内容键）。纯函数（now 可注入）。
 */
export function normalizeLocalIpoItems(
  items: CrawledArticle[],
  opts: { windowDays?: number; now?: Date } = {},
): {
  items: CrawledArticle[];
  droppedNoDate: number;
  droppedOutOfWindow: number;
  droppedDuplicate: number;
} {
  const days = opts.windowDays ?? IPO_SOURCE_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  let droppedNoDate = 0;
  let droppedOutOfWindow = 0;
  let droppedDuplicate = 0;
  const seen = new Set<string>();
  const out: CrawledArticle[] = [];
  for (const it of items) {
    if (!it.publishedAt) {
      droppedNoDate++;
      continue;
    }
    if (!isWithinCalendarDays(it.publishedAt, days, now)) {
      droppedOutOfWindow++;
      continue;
    }
    const key = it.url?.trim() || `${it.sourceId ?? ""}|${it.title ?? ""}`;
    if (seen.has(key)) {
      droppedDuplicate++;
      continue;
    }
    seen.add(key);
    out.push(it);
  }
  return { items: out, droppedNoDate, droppedOutOfWindow, droppedDuplicate };
}
