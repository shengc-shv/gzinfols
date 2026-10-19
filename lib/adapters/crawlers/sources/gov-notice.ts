/**
 * 政府「通知公告」爬虫（2026-10-19 接入）。
 *
 * 为什么加这两个源（sc 口径：商机偏科，缺可落地的本地经营线索）：
 *  - 广州市商务局 → 消费环境试点、汽车/零售/批发业奖励、出口许可、餐饮纳统资金
 *    → 商户收单 / 消费信贷 / 跨境结算 / 外贸客群，条条能落到具体客户；
 *  - 广东省工信厅 → 产业技术平台申报、创客广东、专精特新、绿色/零碳工厂
 *    → 普惠小微 / 科技金融，可作为客户经理跟进的申报名单。
 *  实测 10 月：商务局 8 条（0.4 条/天）、工信厅 18 条（0.9 条/天）—— 小增量、高浓度。
 *
 * 🔴 只抓「通知公告」栏目，**不抓首页**：政府站首页大量是「某厅召开学习会」这类会议报道，
 *    对分行没有执行关联（R7）。栏目选择属采集范围，不是业务判断（R5 仍由展示层做）。
 *
 * 🔴 时间真实性（R6）：publishedAt 必须来自**同一列表块内**的日期文本。
 *    实测工信厅首屏混有 2026-01 的旧文（列表非纯时间序）→ 若按「a 后面最近的日期」松配，
 *    会把旧文串成新日期。故按 </li> / </tr> 切块，块内同时有标题与日期才收，否则丢弃。
 */
import { BaseCrawler, type CrawlerResult } from "../base-crawler";

/** 只抓前 N 页（每页约 20 条，3 页足够覆盖窗口；政府站更新慢）。 */
const LIST_PAGES = 3;
/**
 * 采集窗口（天）。政府「通知公告」的生命周期比新闻长（申报期常 1~2 周），
 * 抓 7 天是为了不让仍有效的申报通知在 2 天窗内消失；
 * 实际进不进日报由下游漏斗/评分决定（采集层只做机械采集，判断在展示层）。
 */
const WINDOW_DAYS = 7;
/** 正文最多取多少字（够 PASS1 判断即可）。 */
const EXCERPT_MAX = 500;

export interface GovNoticeSite {
  sourceId: string;
  name: string;
  /** 栏目目录，分页为 index.html / index_2.html … */
  baseDir: string;
  region: string;
  subcategory: string;
}

const SITES: GovNoticeSite[] = [
  {
    sourceId: "gz-sw",
    name: "广州市商务局·通知公告",
    baseDir: "http://sw.gz.gov.cn/xxgk/tzgg/",
    region: "gz",
    subcategory: "gz-gov",
  },
  {
    sourceId: "gd-gii",
    name: "广东省工信厅·通知公告",
    baseDir: "https://gdii.gd.gov.cn/zwgk/tzgg1011/",
    region: "gd",
    subcategory: "gd-gov",
  },
];

/** 导航/栏目类链接，不是文章。 */
const NAV_TITLE_RE = /^(更多|查看更多|下一页|上一页|首页|尾页|政府信息公开|网站地图|无障碍)/;
/** 文章链接特征（两站详情页都是 content/post_XXX.html）。 */
const ARTICLE_HREF_RE = /content\/post_|\/post_|\.htm(l)?$/i;

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 「2026-10-15」「2026年10月15日」「2026/10/15」→ YYYY-MM-DD（非法返回 ""）。 */
function normDate(raw: string): string {
  const m = raw.match(/(20\d{2})[-年/.](\d{1,2})[-月/.](\d{1,2})/);
  if (!m) return "";
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return "";
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function cutoffDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 从详情页提取正文（政府站正文都在 `<p>` 段落里；容器 class 各站不一，按段落取更稳）。
 * 取不到就返回空串 —— 绝不拿标题或整页导航凑数（会让 PASS1 判断失真）。
 */
function extractBody(html: string): string {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const paras = [...cleaned.matchAll(/<p[^>]*>([\s\S]{10,600}?)<\/p>/gi)]
    .map((m) => stripTags(m[1]))
    .filter((t) => t.length > 12 && !/版权所有|主办单位|网站标识|ICP|公安机关|无障碍|扫一扫/.test(t));
  const joined = paras.join(" ");
  if (joined.length >= 60) return joined.slice(0, EXCERPT_MAX);

  // 回退：常见正文容器
  const zone =
    html.match(/<div[^>]+id="zoom"[^>]*>([\s\S]{80,20000}?)<\/div>/i) ||
    html.match(/<div[^>]+class="[^"]*(?:article|content|TRS_Editor)[^"]*"[^>]*>([\s\S]{80,20000}?)<\/div>/i);
  return zone ? stripTags(zone[1]).slice(0, EXCERPT_MAX) : "";
}

export class GovNoticeCrawler extends BaseCrawler {
  readonly site: GovNoticeSite;
  readonly windowDays = WINDOW_DAYS;
  override sourceIds: string[];

  constructor(site: GovNoticeSite) {
    super({ name: site.name, timeout: 18000, retries: 2 });
    this.site = site;
    this.sourceIds = [site.sourceId];
  }

  async getUrls(): Promise<string[]> {
    return Array.from({ length: LIST_PAGES }, (_, i) =>
      i === 0 ? `${this.site.baseDir}index.html` : `${this.site.baseDir}index_${i + 1}.html`,
    );
  }

  /**
   * 列表页解析：按 </li> / </tr> 切块，块内同时有「文章链接」与「日期」才收。
   * ⚠️ 不跨块取日期 —— 列表里混有旧文时，跨块配日期会把旧文串成新日期（R6）。
   */
  async parseArticle(html: string, url: string): Promise<CrawlerResult[]> {
    const cutoff = cutoffDate(WINDOW_DAYS);
    const blocks = html.split(/<\/li>|<\/tr>/i);
    const out: CrawlerResult[] = [];
    const seen = new Set<string>();

    for (const block of blocks) {
      const dateM = block.match(/20\d{2}[-年/.]\d{1,2}[-月/.]\d{1,2}/);
      if (!dateM) continue;
      const publishedAt = normDate(dateM[0]);
      if (!publishedAt || publishedAt < cutoff) continue;

      // 块内取「最长且像标题」的链接（同块可能夹着导航链接）
      let best: { href: string; title: string } | null = null;
      for (const m of block.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]{4,200}?)<\/a>/gi)) {
        const href = m[1];
        if (!ARTICLE_HREF_RE.test(href) || /index_\d*\.html?$/i.test(href)) continue;
        const title = stripTags(m[2]);
        if (title.length < 8 || !/[\u4e00-\u9fa5]/.test(title) || NAV_TITLE_RE.test(title)) continue;
        if (!best || title.length > best.title.length) best = { href, title };
      }
      if (!best) continue;

      const abs = (() => {
        try {
          return new URL(best.href, url).toString();
        } catch {
          return "";
        }
      })();
      if (!abs || seen.has(abs)) continue;
      seen.add(abs);

      out.push({
        sourceId: this.site.sourceId,
        source: this.site.name,
        title: best.title,
        url: abs,
        publishedAt,
        region: this.site.region,
        subcategory: this.site.subcategory,
      });
    }
    return out;
  }

  /** 列表抓完后：窗口过滤（按 URL 去重）+ 逐条补正文（正文取不到就留空，不编）。 */
  async run(): Promise<CrawlerResult[]> {
    await super.run();
    const cutoff = cutoffDate(WINDOW_DAYS);
    const byUrl = new Map<string, CrawlerResult>();
    for (const r of this.results) {
      if (!r.publishedAt || r.publishedAt < cutoff || !r.url) continue;
      if (!byUrl.has(r.url)) byUrl.set(r.url, r);
    }
    const kept = [...byUrl.values()].sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));

    for (const item of kept) {
      try {
        const resp = await fetch(item.url as string, {
          headers: { "User-Agent": this.userAgent },
          signal: AbortSignal.timeout(12000),
        });
        if (!resp.ok) continue;
        item.excerpt = extractBody(await resp.text());
      } catch {
        /* 详情页失败不影响条目本身（标题+日期+链接已够下游判断），excerpt 留空 */
      }
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 400));
    }

    this.results = kept;
    console.log(`[${this.name}] 窗口内 ${kept.length} 条（cutoff ${cutoff}，已补正文）`);
    return this.results;
  }
}

/** 两个站点实例（注册表与验证脚本共用）。 */
export function buildGovNoticeCrawlers(): GovNoticeCrawler[] {
  return SITES.map((s) => new GovNoticeCrawler(s));
}

export { SITES as GOV_NOTICE_SITES };
