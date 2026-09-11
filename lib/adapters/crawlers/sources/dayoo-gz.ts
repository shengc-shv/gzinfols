import { BaseCrawler, type CrawlerResult } from "../base-crawler";

/**
 * 广州日报·大洋网「广州」频道（news.dayoo.com/guangzhou/）爬虫
 *
 * 背景（2026-08-21 用户第一梯队：广州本地媒体解决"热点发现"）：
 * 广州本地政企发布第一落点（如 8-15 词元贷凌晨首发即来自本地媒体链），
 * 但此前源体系全是全国财经/政府源，广州本地热点常被 3 天/7 天窗口漏掉。
 *
 * 经实测（2026-08-21）：
 *   频道页 https://news.dayoo.com/guangzhou/ 服务端渲染 55KB，文章链接形如
 *     https://news.dayoo.com/guangzhou/202608/21/139995_54993415.htm
 *   日期由路径 /YYYYMM/DD/ 直接推导（北京时间，非 UTC）；标题在 <a> 内直接文本。
 *   频道页为「广州」综合（政经/产经/民生混合），v1 整频道抓取，AI 筛选兜底。
 *   （广州日报电子版 gzdaily.dayoo.com/pc/paperindex.htm 为版面导航，不抓。）
 *
 * 产物：sourceId=dayoo-gz，category=gz（经 SOURCE_ROUTE），subcategory=gz-media（广州本地媒体）。
 */
const DAYOO_GZ_URL = "https://news.dayoo.com/guangzhou/";
const DAYOO_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const DAYOO_REF = "https://news.dayoo.com/";

/**
 * 匹配文章链接并捕获标题：
 *   href="https://news.dayoo.com/guangzhou/202608/21/139995_54993415.htm" ...>标题</a>
 * 仅匹配 news.dayoo.com + guangzhou 频道（硬编码，防 [a-z]+ 误收 china 等全国频道）
 * + /YYYYMM/DD/ 路径 + .htm 结尾，排除导航/栏目页。
 */
const ARTICLE_RE =
  /<a[^>]*href="(https:\/\/news\.dayoo\.com\/guangzhou\/(\d{6})\/(\d{2})\/[^"]+\.htm)"[^>]*>([\s\S]*?)<\/a>/g;

/** 去 HTML 标签 + 折叠空白 */
function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 由 /YYYYMM/DD/ 路径推导日期（非法返回 ""） */
function dateFromPath(ym: string, d: string): string {
  const y = +ym.slice(0, 4);
  const mo = +ym.slice(4, 6);
  const dd = +d;
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || dd < 1 || dd > 31) return "";
  return `${y}-${String(mo).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

interface ParsedItem {
  title: string;
  url: string;
  date: string;
}

export class DayooGzCrawler extends BaseCrawler {
  constructor() {
    super({ name: "广州日报·大洋网(广州)", timeout: 15000, retries: 2 });
  }

  /** GET 返回 HTML 文本（带重试 + 超时 + 中文 UA/Referer） */
  private async _getHtml(url: string): Promise<string | null> {
    const maxAttempts = this.retries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = await fetch(url, {
          headers: {
            "User-Agent": DAYOO_UA,
            Referer: DAYOO_REF,
            Accept: "text/html,application/xhtml+xml",
          },
          signal: AbortSignal.timeout(this.timeout),
        });
        if (!resp.ok) {
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 800 * attempt));
            continue;
          }
          console.warn(`[${this.name}] ${url} 返回 ${resp.status}`);
          return null;
        }
        return await resp.text();
      } catch (err) {
        console.warn(
          `[${this.name}] ${url} 抓取失败（尝试 ${attempt}/${maxAttempts}）: ${(err as Error).message}`,
        );
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 800 * attempt));
          continue;
        }
        return null;
      }
    }
    return null;
  }

  /** 从频道页 HTML 解析文章链接 + 标题 + 日期（URL 去重在 run 层做） */
  private _parseList(html: string): ParsedItem[] {
    return parseDayooGzHtml(html);
  }

  async run(): Promise<CrawlerResult[]> {
    console.log(`[${this.name}] 开始抓取 (广州频道)`);
    const html = await this._getHtml(DAYOO_GZ_URL);
    if (!html) return this.results;
    const seen = new Set<string>();
    for (const it of this._parseList(html)) {
      if (seen.has(it.url)) continue;
      seen.add(it.url);
      this.results.push({
        title: it.title,
        url: it.url,
        excerpt: "",
        publishedAt: it.date,
        sourceId: "dayoo-gz",
        source: "广州日报·大洋网",
      });
    }
    console.log(`[${this.name}] 完成，共 ${this.results.length} 条`);
    return this.results;
  }
}

export function createCrawler(): DayooGzCrawler {
  return new DayooGzCrawler();
}

/** 纯解析：从大洋网广州频道 HTML 提取文章（导出供单测，与 run() 共用）。 */
export function parseDayooGzHtml(html: string): ParsedItem[] {
  const out: ParsedItem[] = [];
  ARTICLE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ARTICLE_RE.exec(html))) {
    const url = m[1];
    const date = dateFromPath(m[2], m[3]);
    const title = stripTags(m[4]);
    if (!title || title.length < 8) continue;
    if (!date) continue; // 无有效日期 → 丢弃（时间体系红线）
    out.push({ title, url, date });
  }
  return out;
}
