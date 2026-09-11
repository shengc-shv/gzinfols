/**
 * 爬虫 runner 入口（自 gzinfo lib/sources/crawlers/index.ts 移植，仅保留活跃源）。
 *
 * 双采集系统的爬虫腿：由管线经 CrawlerRegistry 端口进程内调用（不 shell、不写 JSON 中间文件）。
 * 每个爬虫独立 try/catch 隔离（单源失败不连坐），结果按 URL 去重。
 *
 * 源集合（与 gzinfo 2026-09-11 状态对齐）：
 * - IPO 在线源：上交所/北交所审核动态 + 港交所递表（CI 可达）
 * - IPO 本地专供源：证监会辅导 csrcfd + 深交所审核动态（WAF 拦海外 IP，CI 跳过，
 *   由 data/local-ipo.json 补数，见 lib/adapters/local-ipo.ts）
 * - 广州商机/财经媒体：新华财经/证券时报/新浪银行/观察者网 + 大洋网/南方经济/央广网广东
 * - 昨日股市：东方财富A股 + 新浪A股（交叉验证）+ 新浪港股解读
 * （gz-gov/gz-stats/hkex-stock/chinanews-gd 等已停用源未移植；退役源需要时自 gzinfo 取回）
 */
import type { CrawledArticle } from "../../contracts/article";
import { BaseCrawler } from "./base-crawler";
import { CsrcCoachCrawler } from "./sources/csrcfd";
import { SzseAuditCrawler } from "./sources/szse-audit";
import { SseAuditCrawler } from "./sources/sse-audit";
import { BseAuditCrawler } from "./sources/bse-audit";
import { ListedChecker } from "./sources/listed-check";
import { HkFilingCrawler } from "./sources/hk-filing";
import { selectLocalIpoItems } from "../local-ipo";
import { CnfinCrawler } from "./sources/cnfin-web";
import { StcnCrawler } from "./sources/stcn-web";
import { SinaBankCrawler } from "./sources/sina-bank-web";
import { GuanchaCrawler } from "./sources/guancha-web";
import { DayooGzCrawler } from "./sources/dayoo-gz";
import { SouthcnEconomyCrawler } from "./sources/southcn-economy";
import { CnrGdCrawler } from "./sources/cnr-gd";
import { EastMoneyStockCrawler } from "./sources/eastmoney-stock";
import { SinaHkStockCrawler } from "./sources/sina-hk-stock";
import { SinaAStockCrawler } from "./sources/sina-a-stock";

export interface CrawledBundle {
  ipo: CrawledArticle[];
  gz: CrawledArticle[];
  stocks: CrawledArticle[];
}

/** 按 URL 去重（保留首次出现）。 */
function dedupeByUrl<T extends { url?: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const key = it.url || "";
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(it);
  }
  return out;
}

/** 全量 IPO 爬虫清单（注册一致性测试遍历 sourceIds 用；恒返回全量，不随环境变化）。 */
export function buildIpoCrawlers(): BaseCrawler[] {
  return [...buildLocalOnlyIpoCrawlers(), ...buildOnlineIpoCrawlers()];
}

/** 只能本地抓取的官方 IPO 源（WAF 拦海外 IP，CI 恒失败；数据由 data/local-ipo.json 补齐）。 */
export function buildLocalOnlyIpoCrawlers(): BaseCrawler[] {
  return [new CsrcCoachCrawler(), new SzseAuditCrawler()];
}

/** CI 可达的在线 IPO 源（与本地专供源互补；两集合互斥且并集 = buildIpoCrawlers()）。 */
export function buildOnlineIpoCrawlers(): BaseCrawler[] {
  return [new SseAuditCrawler(), new BseAuditCrawler(), new HkFilingCrawler()];
}

/** 本次 run 实际要跑的 IPO 源 = 在线源 +（非 CI 环境才跑本地专供源）。逃生口 IPO_LOCAL_ONLY_IN_REMOTE=1。 */
export function selectIpoCrawlersForRun(): BaseCrawler[] {
  const forceRemoteTry = process.env.IPO_LOCAL_ONLY_IN_REMOTE === "1";
  const isCi = process.env.CI === "true" || process.env.CI === "1";
  const online = buildOnlineIpoCrawlers();
  if (isCi && !forceRemoteTry) {
    const names = buildLocalOnlyIpoCrawlers()
      .map((c) => c.name)
      .join(" / ");
    console.log(
      `[daily] ⏭ CI 环境跳过本地专供 IPO 源（${names}）→ 由 data/local-ipo.json 补数`,
    );
    return online;
  }
  return [...buildLocalOnlyIpoCrawlers(), ...online];
}

/** listed-check 是 IPO 候选的 post-process（非 BaseCrawler 子类），单独导出供测试遍历。 */
export function buildListedChecker(): ListedChecker {
  return new ListedChecker();
}

/** 爬虫采集（CrawlerRegistry 端口实现）：三类爬虫 + 本地补数 + 上市复核，逐源隔离。 */
export async function fetchCrawledArticles(): Promise<CrawledBundle> {
  const ipoCrawlers = selectIpoCrawlersForRun();

  const ipo: CrawledArticle[] = [];
  for (const crawler of ipoCrawlers) {
    try {
      await crawler.run();
      ipo.push(...(crawler.toGzcmbdf3Format() as CrawledArticle[]));
    } catch (err) {
      console.error(`[${crawler.name}] 爬虫异常:`, (err as Error).message);
    }
  }

  // 本地专供源补数：与在线产物汇入同一 ipo 批次，下游归一化完全不区分来源。
  ipo.push(...selectLocalIpoItems(ipo));

  // P3 listed-check（候选复核）：发现广东近期上市企业卡片 + 候选升级 stage-listed。
  try {
    const listed = await buildListedChecker().run(ipo);
    if (listed.length) ipo.push(...(listed as unknown as CrawledArticle[]));
  } catch (err) {
    console.error(`[listed-check] 复核异常:`, (err as Error).message);
  }

  // 广州商机 + 财经媒体（取原始 results，保留 category/subcategory/region/sourceId）
  const gzCrawlers: BaseCrawler[] = [
    new CnfinCrawler(),
    new StcnCrawler(),
    new SinaBankCrawler(),
    new GuanchaCrawler(),
    new DayooGzCrawler(),
    new SouthcnEconomyCrawler(),
    new CnrGdCrawler(),
  ];

  const gz: CrawledArticle[] = [];
  for (const crawler of gzCrawlers) {
    try {
      await crawler.run();
      gz.push(...(crawler.results as unknown as CrawledArticle[]));
    } catch (err) {
      console.error(`[${crawler.name}] 异常:`, (err as Error).message);
    }
  }

  // 昨日股市：A股（东财 + 新浪交叉验证）+ 港股解读（新浪主源；hkex-stock 已停用）
  const stocksCrawlers: BaseCrawler[] = [
    new EastMoneyStockCrawler(),
    new SinaAStockCrawler(),
    new SinaHkStockCrawler(),
  ];

  const stocks: CrawledArticle[] = [];
  for (const crawler of stocksCrawlers) {
    try {
      await crawler.run();
      stocks.push(...(crawler.results as unknown as CrawledArticle[]));
    } catch (err) {
      console.error(`[${crawler.name}] 异常:`, (err as Error).message);
    }
  }

  return { ipo: dedupeByUrl(ipo), gz: dedupeByUrl(gz), stocks: dedupeByUrl(stocks) };
}
