import { BaseCrawler, type CrawlerResult } from "../base-crawler";

/**
 * 新浪财经·银行频道（finance.sina.com.cn/money/bank）爬虫
 *
 * 为什么不用 type:scrape 直接抓首页：频道页是 149KB 服务端渲染列表页（SSR），
 * 但仅页面首屏内容可用（列表项为 <li><a href=".../<日期>/doc-xxx.shtml">标题</a></li>），
 * 且频道页混有大量栏目导航/专题链接，需按「doc-xxx.shtml + 路径含日期」精确过滤。
 *
 * 经实测（2026-08-20）：
 *   列表页 https://finance.sina.com.cn/money/bank/ 首屏约 30+ 条银行/金融文章；
 *   文章链接形如 finance.sina.com.cn/<栏目>/<YYYY-MM-DD>/doc-<字母数字>.shtml
 *   （栏目含 jinrong/yh 银行、jjxw 经济新闻、roll 滚动、zl/bank 专栏、money/bank/bank_hydt 银行行业动态），
 *   日期由路径 /YYYY-MM-DD/ 直接推导；标题在 <a> 内直接文本。
 *   与「新浪财经·理财保险」(sina-money) 同域但为独立频道，按用户要求单独接入。
 *
 * 产物：sourceId=sina-bank，category=finance（经 SOURCE_ROUTE），subcategory=cn-finance（国内财经新闻标签）。
 */
const SINA_BANK_URL = "https://finance.sina.com.cn/money/bank/";
const SINA_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const SINA_REF = "https://finance.sina.com.cn/money/bank/";

/**
 * 匹配新浪财经文章链接并捕获标题与路径日期：
 *   href="https://finance.sina.com.cn/<栏目>/<YYYY-MM-DD>/doc-xxx.shtml" ...>标题</a>
 * 仅匹配 finance.sina.com.cn 域 + doc-xxx.shtml + 路径含日期，排除栏目导航/专题链接。
 */
const ARTICLE_RE =
  /<a[^>]*href="(https?:\/\/finance\.sina\.com\.cn\/[^"]*\/(\d{4}-\d{2}-\d{2})\/doc-[a-z0-9]+\.shtml)"[^>]*>([\s\S]*?)<\/a>/g;

/** 去 HTML 标签 + 折叠空白 */
function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 校验日期格式 YYYY-MM-DD 并返回（无效返回 ""） */
function validDate(raw: string): string {
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return "";
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

interface ParsedItem {
  title: string;
  url: string;
  date: string;
}

export class SinaBankCrawler extends BaseCrawler {
  constructor() {
    super({ name: "新浪财经·银行频道", timeout: 15000, retries: 2 });
  }

  /** GET 返回 HTML 文本（带重试 + 超时 + 中文 UA/Referer，绕过反爬） */
  private async _getHtml(url: string): Promise<string | null> {
    const maxAttempts = this.retries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = await fetch(url, {
          headers: {
            "User-Agent": SINA_UA,
            Referer: SINA_REF,
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

  /** 从列表页 HTML 解析新浪财经文章（doc 链接 + 路径日期 + 标题） */
  private _parseList(html: string): ParsedItem[] {
    const out: ParsedItem[] = [];
    ARTICLE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ARTICLE_RE.exec(html))) {
      const url = m[1].replace(/^http:/, "https:");
      const date = validDate(m[2]);
      const title = stripTags(m[3]);
      // 过滤「【详细】」等数据点链接（非完整文章标题）
      if (!title || title === "【详细】" || title.length < 4 || !date) continue;
      out.push({ title, url, date });
    }
    return out;
  }

  async run(): Promise<CrawlerResult[]> {
    console.log(`[${this.name}] 开始抓取 (SSR 列表页)`);
    const seen = new Set<string>();
    const html = await this._getHtml(SINA_BANK_URL);
    if (!html) {
      console.log(`[${this.name}] 列表页抓取失败，返回 0 条`);
      return this.results;
    }
    const items = this._parseList(html);
    for (const it of items) {
      if (seen.has(it.url)) continue;
      seen.add(it.url);
      this.results.push({
        title: it.title,
        url: it.url,
        excerpt: "",
        publishedAt: it.date,
        sourceId: "sina-bank",
        source: "新浪财经·银行频道",
      });
    }
    console.log(`[${this.name}] 完成，共 ${this.results.length} 条（去重后）`);
    return this.results;
  }
}

export function createCrawler(): SinaBankCrawler {
  return new SinaBankCrawler();
}
