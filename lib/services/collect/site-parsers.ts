/**
 * 站点专用解析器（C1 采集内部子模块）。
 *
 * 背景（gzinfo lib/sources/domestic-finance.ts / wealth-credit.ts / national-policy.ts，
 * 2026-09-13 移植）：4 个 enabled 的 scrape 源在 gzinfo 都有**站点专用正则解析**，
 * 能从 URL 路径 / 页面 `<span>` 提取真实发布时间；2.0 的通用 cheerio 抓取只认
 * `<time datetime>`，取不到 → 红线#1（无 publishedAt 丢弃）→ 这四个源实际产出≈0。
 *
 * 分层：本模块只做**纯解析**（html 字符串 → RawArticle[]），零 IO；
 * 抓取仍由 `providers.ts` 的 fetchScrape 经 HttpClient 端口完成（按 SITE_PLANS
 * 的 URL 清单逐个拉取）。日期全部来自 URL/页面标注（真实发布时间载体，合法兜底），
 * 与 gzinfo 逐字同口径（北京时间 08:00 显示的日期级粒度）。
 */
import type { RawArticle, ArticleCategory } from "../../contracts/article";
import type { SourceDef } from "../../contracts/source";
import { extractDateFromUrl } from "../../utils/time";

/** html 片段 → 纯文本（gzinfo clean 同款）。 */
function clean(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 日期级发布时间：北京时间零点（gzinfo 口径：`T00:00:00.000Z` 显示为京时 08:00）。 */
function dateAt(d: string): Date {
  return new Date(`${d}T00:00:00.000Z`);
}

/* ───────── 央视财经首页（cctv-finance）───────── */

export function parseCctvFinance(html: string, source: SourceDef, limit = 25): RawArticle[] {
  const re = /<a[^>]+href="(https?:\/\/finance\.cctv\.com\/[^"]+\.shtml)"[^>]*>([^<]{4,60})<\/a>/g;
  const seen = new Set<string>();
  const out: RawArticle[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < limit) {
    const url = m[1];
    const title = clean(m[2]);
    if (seen.has(url)) continue;
    if (/VIDE[A-Za-z0-9]/.test(url)) continue; // 视频专题，非新闻
    if (/index\.shtml|node_|\/2012\/|\/2013\//.test(url)) continue; // 导航/旧栏
    seen.add(url);
    const d = /(\d{4})\/(\d{2})\/(\d{2})/.exec(url);
    out.push({
      sourceId: source.id,
      title,
      url,
      category: source.category,
      // 采集元数据透传（2026-09-21 修，同 providers.ts）
      ...(source.subcategory ? { subcategory: source.subcategory } : {}),
      publishedAt: d ? new Date(`${d[1]}-${d[2]}-${d[3]}T08:00:00+08:00`) : undefined,
    });
  }
  return out;
}

/* ───────── 中国政府网·国务院政策（govcn-policy）───────── */

function parseGovCnDate(s: string): Date | undefined {
  const m = String(s || "").match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return undefined;
  return dateAt(`${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`);
}

export function parseGovCnPolicy(html: string, source: SourceDef, limit = 25): RawArticle[] {
  // 匹配 li 条目：<a href="...content_xxx.htm">标题</a> <span>2026-08-17</span>
  const re =
    /<li>\s*<a href="([^"]+)"[^>]*>\s*([^<]+?)\s*<\/a>\s*<span>\s*([^<]+?)\s*<\/span>/g;
  const out: RawArticle[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < limit) {
    const href = m[1];
    const title = clean(m[2]);
    if (!/content_\d+\.htm/.test(href) || title.length < 8) continue;
    const url = href.startsWith("http") ? href : `https://www.gov.cn${href.replace(/^\.\//, "/")}`;
    const publishedAt = parseGovCnDate(m[3]);
    out.push({
      sourceId: source.id,
      title,
      url,
      excerpt: `【国务院政策】${title}`,
      ...(publishedAt ? { publishedAt } : {}),
      category: source.category,
      // 采集元数据透传（2026-09-21 修，同 providers.ts）
      ...(source.subcategory ? { subcategory: source.subcategory } : {}),
    });
  }
  return out;
}

/* ───────── 新浪财经·理财频道（sina-money）───────── */

/** 财富业务关键词（理财/保险/基金/黄金/存款/利率） */
const WEALTH_KW =
  /理财|保险|基金|黄金|存款|利率|养老金|资管|信托|债券基金|净值|申购|赎回|寿险|财险|贵金属/;

export function parseSinaMoney(html: string, source: SourceDef, limit = 20): RawArticle[] {
  const re = /<a href="([^"]+)"[^>]*>([^<]{10,60})<\/a>/g;
  const out: RawArticle[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < limit) {
    const href = m[1];
    const title = clean(m[2]);
    if (href.startsWith("javascript:") || title.length < 10) continue;
    if (!WEALTH_KW.test(title)) continue; // 只留财富业务相关
    const url = href.startsWith("http") ? href : `https://finance.sina.com.cn${href}`;
    // 列表页无内联日期 → URL 路径含 YYYY-MM-DD（/roll/2026-08-21/doc-*.shtml）兜底
    const d = extractDateFromUrl(url);
    out.push({
      sourceId: source.id,
      title,
      url,
      excerpt: `【财富管理】${title}`,
      category: "gz",
      ...(d ? { publishedAt: dateAt(d) } : {}),
    });
  }
  return out;
}

/* ───────── 21 世纪经济报道（21jingji-finance，金融 + 粤港澳双频道）───────── */

/** 个人信贷关键词（房贷/消费贷/普惠/信贷/银行/金融） */
const CREDIT_KW =
  /房贷|消费贷|普惠|信贷|贷款|按揭|首付|利率|融资|助贷|信用卡|公积金|LPR|银行|金融|债券|存款|人民币|货币|监管/;

export function parse21jingji(
  html: string,
  channelName: string,
  source: SourceDef,
  limit = 20,
): RawArticle[] {
  const re = /<a[^>]+href="([^"]+)"[^>]*title="([^"]{10,80})"[^>]*>/g;
  const out: RawArticle[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < limit) {
    const href = m[1];
    const title = clean(m[2]);
    if (!CREDIT_KW.test(title)) continue; // 只留信贷/金融监管相关
    const url = href.startsWith("http") ? href : `https://www.21jingji.com${href}`;
    // 文章 URL 含 YYYYMMDD（m.21jingji.com/article/20260820/...）→ 兜底补日期
    const d = extractDateFromUrl(url);
    out.push({
      sourceId: source.id,
      title,
      url,
      excerpt: `【21财经·${channelName}】${title}`,
      category: "gz",
      ...(d ? { publishedAt: dateAt(d) } : {}),
    });
  }
  return out;
}

/* ───────── 站点抓取计划（fetchScrape 按此分派）───────── */

export interface SitePlan {
  /** 要抓的 URL 清单（21jingji 需要金融 + 粤港澳两个频道）。 */
  urls: string[];
  /** 请求头（gzinfo 用 curl + 浏览器 UA；这里的源多有反爬）。 */
  headers: Record<string, string>;
  /** 是否强制走 curl 子进程（WAF 站点）。 */
  useCurl?: boolean;
  parse: (html: string, url: string, source: SourceDef) => RawArticle[];
}

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

/** 源 id → 专用抓取计划（无计划的 scrape 源走通用 cheerio 解析）。 */
export const SITE_PLANS: Record<string, SitePlan> = {
  "cctv-finance": {
    urls: ["https://finance.cctv.com/"],
    headers: BROWSER_HEADERS,
    parse: (html, _url, source) => parseCctvFinance(html, source),
  },
  "govcn-policy": {
    urls: ["https://www.gov.cn/zhengce/"],
    headers: BROWSER_HEADERS,
    parse: (html, _url, source) => parseGovCnPolicy(html, source),
  },
  "sina-money": {
    urls: ["https://finance.sina.com.cn/money/"],
    headers: BROWSER_HEADERS,
    parse: (html, _url, source) => parseSinaMoney(html, source),
  },
  "21jingji-finance": {
    urls: [
      "https://www.21jingji.com/channel/finance",
      "https://www.21jingji.com/channel/GHM_GreaterBay",
    ],
    headers: BROWSER_HEADERS,
    // 双频道：按抓取的 URL 区分频道名
    parse: (html, url, source) =>
      parse21jingji(html, url.includes("GHM_GreaterBay") ? "粤港澳" : "金融", source),
  },
};

/** 类型收窄辅助（ArticleCategory 由 config 透传）。 */
export type { ArticleCategory };
