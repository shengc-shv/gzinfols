import { BaseCrawler, type CrawlerResult } from "../base-crawler";

/**
 * 央广网广东频道（www.cnr.cn/gd/）爬虫
 *
 * 背景（2026-08-21 用户第一梯队：广州本地媒体解决"热点发现"）：
 * 央广网广东频道对广东/广州热点 T+0 跟进（词元八条案例中省级频道当天跟进），
 * 官方央媒属性（tier T1.5），与中新网广东互补。
 *
 * 经实测（2026-08-21）：
 *   频道页 https://www.cnr.cn/gd/ 服务端渲染 53KB，文章链接形如
 *     https://www.cnr.cn/gd/dishidongtai/20260806/t20260806_527750982.shtml
 *   日期由路径 /YYYYMMDD/ 直接推导；标题在 <a> 内直接文本。
 *   子栏目：dishidongtai 地市动态、dwqgc 大湾区观察、fxgz 发展观察等。
 *   v1 抓频道首页（已含各子栏目最新滚动）。
 *
 * 产物：sourceId=cnr-gd，category=gz（经 SOURCE_ROUTE），subcategory=gz-media（广州本地媒体）。
 */
const CNRGD_URL = "https://www.cnr.cn/gd/";
const CNRGD_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const CNRGD_REF = "https://www.cnr.cn/gd/";

/**
 * 匹配文章链接并捕获标题：
 *   href="https://www.cnr.cn/gd/dishidongtai/20260806/t20260806_527750982.shtml" ...>标题</a>
 * 仅匹配 www.cnr.cn/gd/ + /YYYYMMDD/tYYYYMMDD_ 文章页，排除专题/栏目导航。
 */
const ARTICLE_RE =
  /<a[^>]*href="(https:\/\/www\.cnr\.cn\/gd\/[^"]*\/(\d{8})\/t\d{8}_\d+\.shtml)"[^>]*>([\s\S]*?)<\/a>/g;

/** 去 HTML 标签 + 折叠空白 */
function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 由 /YYYYMMDD/ 路径推导日期（非法返回 ""） */
function dateFromPath(raw: string): string {
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
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

export class CnrGdCrawler extends BaseCrawler {
  constructor() {
    super({ name: "央广网·广东", timeout: 15000, retries: 2 });
  }

  /** GET 返回 HTML 文本（带重试 + 超时 + 中文 UA/Referer） */
  private async _getHtml(url: string): Promise<string | null> {
    const maxAttempts = this.retries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = await fetch(url, {
          headers: {
            "User-Agent": CNRGD_UA,
            Referer: CNRGD_REF,
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
        // 页面声明 gb2312（GBK 超集）：Node 默认 UTF-8 解码会乱码，须按 gbk 解码
        const buf = new Uint8Array(await resp.arrayBuffer());
        return new TextDecoder("gbk").decode(buf);
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
    return parseCnrGdHtml(html);
  }

  async run(): Promise<CrawlerResult[]> {
    console.log(`[${this.name}] 开始抓取 (广东频道)`);
    const html = await this._getHtml(CNRGD_URL);
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
        sourceId: "cnr-gd",
        source: "央广网·广东",
      });
    }
    console.log(`[${this.name}] 完成，共 ${this.results.length} 条`);
    return this.results;
  }
}

export function createCrawler(): CnrGdCrawler {
  return new CnrGdCrawler();
}

/** 纯解析：从央广网广东 HTML 提取文章（导出供单测，与 run() 共用）。 */
export function parseCnrGdHtml(html: string): ParsedItem[] {
  const out: ParsedItem[] = [];
  ARTICLE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ARTICLE_RE.exec(html))) {
    const url = m[1];
    const date = dateFromPath(m[2]);
    const title = stripTags(m[3]);
    if (!title || title.length < 8) continue;
    if (!date) continue; // 无有效日期 → 丢弃（时间体系红线）
    out.push({ title, url, date });
  }
  return out;
}
