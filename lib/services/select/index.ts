/**
 * 筛选服务 C3：漏斗（确定性）+ 窗口过滤 + 价值取前。
 *
 * 红线 #2（无状态源）：漏斗只看标题/正文内容，不读 sourceId/category 决定去留
 * （参考区豁免是「展示窗口」判断，非地域/相关性过滤）。
 * 时间与配置经 ctx 注入（startTime / config.windowDays），服务层不直读 process.env。
 */
import type { ArticleInput } from "../../contracts/article";
import type { FilterResult, PipelineContext, SelectResult } from "../../contracts/pipeline";
import type { FileStore } from "../../contracts/pipeline";
import { applyKeywordFilter, type KeywordConfig } from "./funnel";

export interface SelectDeps {
  fs: FileStore;
}

function withinWindow(publishedAt: Date, ctx: PipelineContext): boolean {
  const diffDays = (ctx.startTime.getTime() - publishedAt.getTime()) / 86_400_000;
  return diffDays <= ctx.config.windowDays + 1; // 含边界
}

/** 确定性价值评分（替代 gzinfo ai/relevance-score）：tier 权重 + 商机/风险命中 + 地域。 */
function scoreValue(a: ArticleInput, fr: FilterResult | undefined): number {
  const tierW = a.tier === "T1" ? 30 : a.tier === "T1.5" ? 20 : 10;
  const opp = fr?.opportunities?.length ? 1000 : 0;
  const risk = fr?.risks?.length ? 800 : 0;
  return (fr?.score ?? 0) + tierW + opp + risk;
}

/**
 * 筛选入口：① 跑关键词漏斗（L0 硬排除+维度+商机/风险）；② 窗口过滤；③ 价值取前。
 * 参考区（tech/ipo/gd-ipo/politics/stocks）漏斗直接放行（pass=true），仅做窗口过滤。
 */
export async function select(
  articles: ArticleInput[],
  ctx: PipelineContext,
  deps: SelectDeps,
): Promise<SelectResult> {
  const config = await deps.fs.readJson<KeywordConfig>("sources.keywords.json");
  if (!config) throw new Error("sources.keywords.json 缺失，无法执行漏斗");

  const filterResults = new Map<string, FilterResult>();
  const passed = articles.filter((a) => {
    const fr = applyKeywordFilter(
      { title: a.title, content: a.excerpt, category: a.category, tier: a.tier },
      config,
    );
    filterResults.set(a.url, fr);
    return fr.pass;
  });

  const windowed = passed.filter((a) => withinWindow(a.publishedAt, ctx));

  // 价值取前：按 scoreValue 降序，保留 Top N（每源/每板块上限交由 assemble 阶段控）
  const ranked = windowed
    .map((a) => ({ a, s: scoreValue(a, filterResults.get(a.url)) }))
    .sort((x, y) => y.s - x.s)
    .map((x) => x.a);

  ctx.log.info(
    "select",
    `漏斗 ${articles.length} → 命中 ${passed.length} → 窗口内 ${windowed.length} → 价值取前 ${ranked.length}`,
  );
  return { articles: ranked, filterResults };
}
