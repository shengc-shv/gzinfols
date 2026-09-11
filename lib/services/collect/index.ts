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
    enabled.map((s) => fetchOne(s, deps.http)),
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

/** 采集入口：fetchAll → 爬虫 → 合并去重（RawArticle 原样透传，加工全在 C2）。 */
export async function ingestAll(
  ctx: PipelineContext,
  deps: CollectDeps,
): Promise<IngestResult> {
  const fetched = await fetchAllSources(ctx, deps);
  const crawled = await fetchCrawlers(ctx, deps);

  // CrawledArticle 是 RawArticle 的结构子集（多出的可选字段兼容），直接并入
  const articles = dedupeByUrl([...fetched, ...crawled.ipo, ...crawled.gz, ...crawled.stocks]);

  if (articles.length === 0) throw new Error("no articles fetched — aborting");
  ctx.log.info("collect", `采集合计 ${articles.length} 条`);
  return { articles, crawled };
}
