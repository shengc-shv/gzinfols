/**
 * 采集服务 C1：把各源抓取结果汇合为 RawArticle[]。
 *
 * 职责边界：只做「采集 + 并发 + 源级错误隔离 + URL 去重」，透传 providers 的 RawArticle；
 * source 展示名 / tier 兜底 / excerpt 兜底 / isIpo 推导全部收敛到 C2 归一化（单一出口）。
 * 红线 #1（丢弃无 publishedAt）不在此做 —— 留给 C2 归一化集中裁决。
 * 服务内部允许调用 collect/providers（同服务子模块），但不得 import 其他服务。
 */
import type { RawArticle } from "../../contracts/article";
import type { CrawlerRegistry, HttpClient, IngestResult, PipelineContext } from "../../contracts/pipeline";
import { crawledToRaw, SOURCE_ROUTE } from "../normalize/crawl";
import { fetchOne } from "./providers";

export interface CollectDeps {
  http: HttpClient;
  crawlers?: CrawlerRegistry;
}

/** 单源并发抓取：失败非致命（仅记录，不影响其他源）。 */
async function fetchAllSources(
  ctx: PipelineContext,
  deps: CollectDeps,
): Promise<RawArticle[]> {
  const enabled = ctx.sources.filter((s) => s.enabled !== false);
  if (enabled.length === 0) return [];

  const settled = await Promise.allSettled(
    enabled.map((s) => fetchOne(s, deps.http, ctx.startTime)),
  );

  const out: RawArticle[] = [];
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < enabled.length; i++) {
    const source = enabled[i];
    const r = settled[i];
    if (r.status === "fulfilled") {
      ok++;
      out.push(...r.value);
    } else {
      fail++;
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      ctx.errors.push({ stage: "fetchAllSources", source: source.id, message: msg });
    }
  }
  ctx.log.info("collect", `并发抓取 ${ok}/${enabled.length} 源成功${fail ? `，${fail} 源失败` : ""}`);
  return out;
}

/** 爬虫产物：失败降级为空并计入错误观测（ctx.errors）。 */
async function fetchCrawlers(
  ctx: PipelineContext,
  deps: CollectDeps,
): Promise<IngestResult["crawled"]> {
  if (!deps.crawlers) return { ipo: [], gz: [], stocks: [] };
  try {
    return await deps.crawlers.fetchCrawledArticles();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.errors.push({ stage: "fetchCrawlers", message: msg });
    ctx.log.warn("collect", `爬虫产物获取失败，降级为空：${msg}`);
    return { ipo: [], gz: [], stocks: [] };
  }
}

function dedupeByUrl(articles: RawArticle[]): RawArticle[] {
  const seen = new Set<string>();
  const out: RawArticle[] = [];
  for (const a of articles) {
    if (seen.has(a.url)) continue;
    seen.add(a.url);
    out.push(a);
  }
  return out;
}

/** 采集入口：fetchAll → 爬虫 → 爬虫线格式归一化（routeRegion/时间解析）→ 去重。 */
export async function ingestAll(
  ctx: PipelineContext,
  deps: CollectDeps,
): Promise<IngestResult> {
  const fetched = await fetchAllSources(ctx, deps);
  const crawled = await fetchCrawlers(ctx, deps);

  // 爬虫产物三批次归一化（与 gzinfo mergeCrawledBatch 语义一致）：
  //  - ipo：region 三分流（gz→gz+前缀改写 / gd→gd-ipo / 其它→ipo）
  //  - gz：category 走 SOURCE_ROUTE 路由表兜底（采集元数据，非最终归属）
  //  - stocks：强制 category=stocks（昨日股市复盘输入）
  const crawledRaw = [
    ...crawled.ipo.map((c) => crawledToRaw(c, "ipo")),
    ...crawled.gz.map((c) =>
      crawledToRaw(c, "gz", { gzCategory: c.sourceId ? SOURCE_ROUTE[c.sourceId]?.category : undefined }),
    ),
    ...crawled.stocks.map((c) => crawledToRaw(c, "gz", { gzCategory: "stocks" })),
  ];
  const articles = dedupeByUrl([...fetched, ...crawledRaw]);

  if (articles.length === 0) throw new Error("no articles fetched — aborting");
  ctx.log.info(
    "collect",
    `采集合计 ${articles.length} 条（RSS/API/Scrape ${fetched.length} + 爬虫 ${crawledRaw.length}）`,
  );
  return { articles, crawled };
}
