import { BaseCrawler, type CrawlerResult } from "../base-crawler";
import { isResearchTitleWorthy } from "./research-filters";

/**
 * 新浪财经·研报中心（宏观 / 策略）—— 高客前瞻参考区数据源（2026-10-19 新增）。
 *
 * 为什么加它：东财研报 API 只有个股/行业/策略三类，**没有宏观分类**
 * （实测 qType=3~8 全 0，宏观页为纯 JS 渲染抓不到接口）；新浪研报中心有独立
 * `kind/macro` 分类，且字段齐全（标题/链接/分类/日期/机构/研究员）。
 *
 * 实测（2026-10-19）：macro 21 条 · strategy 19 条（首页即覆盖近几日，无需翻页）。
 *
 * 🔴 编码是 **GBK** —— 必须传 `encoding: "gbk"`，否则 `resp.text()` 按 UTF-8 解码全乱码。
 * 红线：R6 无日期丢弃；策略类只收宏观/配置向（滤掉「北交所跟踪」这类细分专题）。
 */
const KINDS: Array<{ kind: string; label: string }> = [
  // 2026-10-19 sc 口径：研报要「银行 + 宏观」两层。新浪只取 macro 分类；
  // strategy 类实测噪音大（北交所跟踪/细分专题/晨报），价值密度低，暂不接。
  { kind: "macro", label: "宏观" },
];

const listUrl = (kind: string): string =>
  `https://stock.finance.sina.com.cn/stock/go.php/vReport_List/kind/${kind}/index.phtml`;

/** 策略类白名单：只收宏观/配置/流动性向（细分专题对零售银行价值低）。 */
const STRATEGY_HIT = ["策略", "大类资产", "流动", "宏观", "配置", "市场"];

/**
 * 排除：明显非财经/跑题项（实测「国际时政周评：中期选举前关注地缘冲突变量」这类混在宏观分类里）。
 * 只排「纯时政/地缘」——贸易、财政、产业政策等仍保留（与跨境结算/信贷相关）。
 */
const TITLE_EXCLUDE = ["时政", "地缘", "国际关系", "外交", "军事", "战争"];


/** 单行：序号 | 标题(a) | 分类 | 日期 | 机构(fname05) | 研究员(fname) */
const ROW_RE =
  /<tr>\s*<td>\d+<\/td>\s*<td class="tal f14">\s*<a[^>]*?title="([^"]+)"[^>]*?href="([^"]*vReport_Show[^"]+)"[\s\S]*?<td>([^<]{1,8})<\/td>\s*<td>(\d{4}-\d{2}-\d{2})<\/td>[\s\S]*?class="fname05"><span>([^<]*)<\/span>[\s\S]*?class="fname"><span>([^<]*)<\/span>/g;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&ldquo;|&rdquo;/g, "”");
}

export class SinaResearchCrawler extends BaseCrawler {
  /** 回溯天数：3 天扛周末（与东财研报同口径）。 */
  windowDays = 3;

  constructor() {
    super({
      name: "新浪财经·研报中心（宏观/策略）",
      keywords: [],
      timeout: 15000,
      retries: 2,
      encoding: "gbk", // 🔴 必需：新浪老站 GBK
    });
  }

  async getUrls(): Promise<string[]> {
    return KINDS.map((k) => listUrl(k.kind));
  }

  async parseArticle(html: string, url: string): Promise<CrawlerResult[]> {
    // 分类从 URL 反推（macro / strategy），用于策略类过滤与展示
    const kind = /\/kind\/([a-z]+)\//.exec(url)?.[1] ?? "";
    const label = KINDS.find((k) => k.kind === kind)?.label ?? "研报";

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.windowDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const out: CrawlerResult[] = [];
    const seen = new Set<string>();
    for (const m of html.matchAll(ROW_RE)) {
      const [, titleRaw, hrefRaw, , date, orgRaw, researchersRaw] = m;
      const title = decodeEntities(titleRaw).trim();
      const href = decodeEntities(hrefRaw).trim();
      if (!title || !href || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

      // R6：窗口外的旧研报丢弃（不靠下游兜底）
      if (date < cutoffStr) continue;

      // 跑题排除（纯时政/地缘）
      if (TITLE_EXCLUDE.some((k) => title.includes(k))) continue;

      // sc 口径：写了时间窗的要到季度级；纯专题/深度/点评类照留（见 research-filters.ts）
      if (!isResearchTitleWorthy(title)) continue;

      // 策略类只收宏观/配置向；宏观类全收
      if (kind === "strategy" && !STRATEGY_HIT.some((k) => title.includes(k))) continue;

      // 协议相对 → 绝对
      const url2 = href.startsWith("//") ? `https:${href}` : href;
      if (seen.has(url2)) continue;
      seen.add(url2);

      const org = orgRaw.trim();
      const researchers = researchersRaw.trim();

      out.push({
        sourceId: "sina-research",
        source: "新浪财经研报",
        title,
        url: url2,
        excerpt: [org, researchers, label].filter(Boolean).join("｜"),
        publishedAt: date,
        category: "research",
        subcategory: kind === "macro" ? "macro-research" : "strategy-research",
        region: "nation",
      });
    }
    return out;
  }
}
