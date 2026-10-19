import { BaseCrawler, type CrawlerResult } from "../base-crawler";
import { isResearchTitleWorthy } from "./research-filters";

/**
 * 东方财富·券商研报（银行/零售/财富管理方向）—— 高客前瞻参考区数据源。
 *
 * 2026-10-19 新增。数据形态是 JSON API（不是 HTML），但**刻意走爬虫腿而不是 api 型**：
 *  - config 的 `url` 是静态串，而本 API 要动态 `beginTime/endTime`（每天变）；
 *  - 通用 `fetchApi`（services/collect/providers.ts）只认 `title/url/date/summary`，
 *    东财实际是 `title/publishDate` **且无 url 字段** → url 与 publishedAt 双空，
 *    前者废掉判重/锚点，后者直接撞 R6（无真实时间即废弃）；
 *  - 只有爬虫腿能带出 `orgSName/researcher/industryName`（参考区最有价值的信息）。
 *
 * 红线：
 *  - R6 时间真实性：`publishDate` 缺失/非法 → 直接丢弃，绝不回退抓取日；
 *  - R7 业务相关性：标题白名单（零售银行术语）硬过滤，110 条/3 天里绝大多数
 *    是电气设备/农林牧渔等无关行业研报，不过滤会污染参考区。
 *
 * excerpt 契约：`机构｜研究员｜行业`（全角分隔，三者本身不含该字符），
 * 由 `side-outputs/side-research.ts` 拆回结构化字段。
 */
const API = "https://reportapi.eastmoney.com/report/list";

/**
 * 标题白名单：命中任一即视为「与零售银行相关」（宁可少收，不放进无关行业）。
 *
 * 🔴 泛化词必须配对（踩坑实录 2026-10-19 首跑）：裸词「零售」命中「批发和零售贸易行业研究」、
 * 裸词「银行」命中「非银行金融行业研究」、裸词「保险」命中「保险行业研究」——全是非零售银行内容。
 * 故：① 「零售」只以「零售银行/大零售/零售业务/零售客群/零售转型」形态出现；
 *     ② 「保险/信托」只以银保/代销/家族信托形态出现；③ 另设 TITLE_EXCLUDE 否定断言兜底。
 */
const TITLE_HIT = [
  "银行",
  "零售银行",
  "大零售",
  "零售业务",
  "零售客群",
  "零售转型",
  "财富管理",
  "私行",
  "私人银行",
  "理财",
  "信贷",
  "贷款",
  "存款",
  "中收",
  "息差",
  "客群",
  "信用卡",
  "消费金融",
  "普惠",
  "代发",
  "金融科技",
  "银保",
  "保险代销",
  "家族信托",
  // 2026-10-19 sc「内容加厚」：补宏观/策略维度（qType=2 策略报告会命中的宏观主题）
  "降准",
  "降息",
  "社融",
  "M2",
  "CPI",
  "PPI",
  "汇率",
  "货币政策",
  "宏观经济",
  "经济数据",
  "经济增速",
  "财政",
  "流动性",
  "利率",
  "资产质量",
  "净息差",
  "存款利率",
  "信贷投放",
  "房地产",
];

/** 否定断言：命中任一即排除（先于白名单判断）。 */
const TITLE_EXCLUDE = ["非银行金融", "非银金融", "批发和零售", "商贸零售", "零售贸易"];


export class EastMoneyResearchCrawler extends BaseCrawler {
  /** 回溯天数：3 天可扛周末（周一跑时周五的研报仍在窗口内）。 */
  windowDays = 3;

  constructor() {
    // keywords 必须为空：BaseCrawler 默认关键词（广州/上市/IPO/辅导备案）会把研报全杀。
    super({ name: "东方财富·银行方向研报", keywords: [], timeout: 15000, retries: 2 });
  }

  async getUrls(): Promise<string[]> {
    const fmt = (d: Date): string =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const end = new Date();
    const begin = new Date();
    begin.setDate(begin.getDate() - this.windowDays);
    // qType=1 行业研报 · qType=2 策略报告（2026-10-19 sc「加厚」：策略里含宏观/流动性/市场观点）
    // 宏观没有独立分类（qType=3~8 实测全 0）→ 宏观由新浪研报 macro 分类补（sina-research.ts）
    const common = `beginTime=${fmt(begin)}&endTime=${fmt(end)}&pageSize=50&pageNo=1&industryCode=*`;
    return [1, 2].map((qType) => `${API}?qType=${qType}&${common}`);
  }

  async parseArticle(text: string, _url: string): Promise<CrawlerResult[]> {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return [];
    }
    const data = (json as { data?: unknown })?.data;
    if (!Array.isArray(data)) return [];

    const out: CrawlerResult[] = [];
    const seen = new Set<string>();
    for (const raw of data) {
      if (!raw || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      const title = String(o.title ?? "").trim();
      const infoCode = String(o.infoCode ?? "").trim();
      const pub = String(o.publishDate ?? "").trim();

      // R6：无标题/无 infoCode/无发布时间 → 丢弃（不兜底）
      if (!title || !infoCode || !pub) continue;
      const day = pub.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;

      // R7：非银行/零售方向研报不进参考区（先否定断言，再白名单——防裸词跨语境误配）
      if (TITLE_EXCLUDE.some((k) => title.includes(k))) continue;
      // sc 2026-10-19：写了时间窗的要到季度级；纯专题/深度/点评类照留
      if (!isResearchTitleWorthy(title)) continue;
      if (!TITLE_HIT.some((k) => title.includes(k))) continue;

      const url = `https://data.eastmoney.com/report/zw_industry.jshtml?infocode=${encodeURIComponent(infoCode)}`;
      if (seen.has(url)) continue;
      seen.add(url);

      const org = String(o.orgSName ?? o.orgName ?? "").trim();
      const researchers = String(o.researcher ?? "").trim();
      const industry = String(o.industryName ?? "").trim();

      out.push({
        sourceId: "eastmoney-research",
        source: "东方财富研报",
        title,
        url,
        excerpt: [org, researchers, industry].filter(Boolean).join("｜"),
        publishedAt: day,
        category: "research",
        subcategory: "broker-report",
        region: "nation",
      });
    }
    return out;
  }
}
