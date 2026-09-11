import { BaseCrawler, type CrawlerResult } from "../base-crawler";

/**
 * 观察者网·金融频道（guancha.cn/GuanJinRong）爬虫
 *
 * 为什么不用 type:scrape 直接抓首页：频道页是 27KB 服务端渲染列表页（SSR），
 * 真实文章在各栏目静态列表页；频道页混有 politics 等其他栏目链接，
 * 需按 /GuanJinRong/ 前缀精确过滤。
 *
 * 经实测（2026-08-20）：
 *   列表页 https://www.guancha.cn/GuanJinRong 首屏约 15 条金融深度文章
 *   （银行/理财/券商/保险/宏观，含 2026-08-19 最新）；
 *   文章链接形如 /GuanJinRong/<YYYY>_<MM>_<DD>_<id>.shtml，日期由链接直接推导；
 *   标题在 <a href="...shtml"> 内的 <h1> 标签（无 h1 时回退取 a 内纯文本）。
 *   ?page=N 实测返回与首页相同内容（分页未生效），v1 只抓首页。
 *
 * 产物：sourceId=guancha，category=finance（经 SOURCE_ROUTE），subcategory=cn-finance（国内财经新闻标签）。
 */
const GUANCHA_URL = "https://www.guancha.cn/GuanJinRong";
const GUANCHA_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const GUANCHA_REF = "https://www.guancha.cn/GuanJinRong";

/**
 * 匹配观察者网金融文章链接并捕获 a 块内容：
 *   href="/GuanJinRong/<YYYY>_<MM>_<DD>_<id>.shtml" ...>...<h1>标题</h1>...</a>
 */
const ARTICLE_RE =
  /<a[^>]*href="(\/GuanJinRong\/(\d{4})_(\d{2})_(\d{2})_(\d+)\.shtml)"[^>]*>([\s\S]*?)<\/a>/g;

/** 去 HTML 标签 + 折叠空白 */
function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 从 a 块提取标题：优先 <h1>，回退纯文本 */
function extractTitle(aHtml: string): string {
  const h1 = aHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  const t = stripTags(h1 ? h1[1] : aHtml);
  return t.slice(0, 120);
}

interface ParsedItem {
  title: string;
  url: string;
  date: string;
}

export class GuanchaCrawler extends BaseCrawler {
  constructor() {
    super({ name: "观察者网·金融", timeout: 15000, retries: 2 });
  }

  /** GET 返回 HTML 文本（带重试 + 超时 + 中文 UA/Referer，绕过反爬） */
  private async _getHtml(url: string): Promise<string | null> {
    const maxAttempts = this.retries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = await fetch(url, {
          headers: {
            "User-Agent": GUANCHA_UA,
            Referer: GUANCHA_REF,
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

  /** 从列表页 HTML 解析金融文章（链接日期 + h1 标题） */
  private _parseList(html: string): ParsedItem[] {
    const out: ParsedItem[] = [];
    ARTICLE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ARTICLE_RE.exec(html))) {
      const title = extractTitle(m[6]);
      if (!title) continue;
      const y = +m[2];
      const mo = +m[3];
      const d = +m[4];
      if (y < 2000 || mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      const date = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      out.push({ title, url: `https://www.guancha.cn${m[1]}`, date });
    }
    return out;
  }

  async run(): Promise<CrawlerResult[]> {
    console.log(`[${this.name}] 开始抓取 (SSR 列表页)`);
    const seen = new Set<string>();
    const html = await this._getHtml(GUANCHA_URL);
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
        sourceId: "guancha",
        source: "观察者网·金融",
      });
    }
    console.log(`[${this.name}] 完成，共 ${this.results.length} 条（去重后）`);
    return this.results;
  }
}

export function createCrawler(): GuanchaCrawler {
  return new GuanchaCrawler();
}
