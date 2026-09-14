/**
 * 限额表与内容过滤（**业务规则**，2026-09-14 C-1 Phase2 自 `render/full.ts` 纯搬移）。
 *
 * 为什么在 assemble 而不是 render：这些常量决定「每条源/子标签保留多少条」「哪些
 * 条目先被剔除」，是**业务判定**而非呈现；此前住在渲染服务里，导致「改渲染要动业务判定」。
 * 搬移后 `render/full.ts` 只消费它们，不再定义。
 *
 * ⚠️ 残留耦合（Phase 2b 待办）：本文件与 `group.ts` 仍 import `render/cards`（标签词表 /
 * `sortByTierAndTime`）、`render/i18n`（`SUBCATEGORY_LABELS/ORDER`，随 locale 切换）与
 * `render/site-filters`（V2EX 正则）。彻底解耦需先把这批**共享词表**下沉到
 * contracts/ 或 enrich/，属独立一轮（涉及 locale 机制，不宜与本次搬移混提）。
 */
import type { ArticleInput } from "../../contracts/article";
import type { Category } from "../../contracts/source";



/**
 * Per-source item caps in the raw display, keyed by "category:subcategory".
 * Each source inside the subcategory shows up to N items. Missing keys = no cap.
 *
 * Default 20 across all L3-tabbed subcategories keeps each tab a single
 * comfortable scroll instead of 25-30 items. Merged subgroups (blog-weekly,
 * finance:news, politics:world) ignore this — they use MERGED_SUBGROUP_LIMITS.
 */
export const SOURCE_DISPLAY_LIMITS: Record<string, number> = {
  "tech:github-trending": 10,
  "tech:cn-community": 10,
};

/**
 * Sources whose fetcher returns items already sorted by an engagement/heat
 * algorithm we want to preserve. groupRaw skips its default date-desc sort
 * for these so the final render reflects the source's own ranking.
 * （2026-08-20：attentionvc-ai / huggingface-papers 已随 X/论文类清理禁用）
 */
export const PRESERVE_FETCH_ORDER_SOURCES = new Set<string>([]);

export function displayLimitFor(
  category: Category,
  subId: string | undefined,
): number | undefined {
  if (!subId) return undefined;
  return SOURCE_DISPLAY_LIMITS[`${category}:${subId}`];
}

/**
 * Take the first `n` items of `list`, but always put today's freshly-fetched
 * items first (preserving relative order inside each group). The renderer
 * only shows `fetchedToday` items under "当天", so slicing a mixed rolling
 * list naively lets older history entries crowd out today's items — e.g.
 * trending papers whose history copy sorts before today's fetch, leaving
 * the sub-tab empty.
 */
export function takeFirstToday(list: ArticleInput[], n: number): ArticleInput[] {
  if (list.length <= n) return list;
  const today: ArticleInput[] = [];
  const past: ArticleInput[] = [];
  for (const a of list) (a.fetchedToday === true ? today : past).push(a);
  return today.concat(past).slice(0, n);
}

/**
 * Cheap local heuristic for cross-source story dedup (no LLM cost):
 * normalize a title to lowercase alphanumeric tokens, then compare either
 * by exact normalized equality or by token Jaccard similarity.
 */
/**
 * Subcategories that should collapse their sources into a single flat
 * time-sorted list (no L3 source tabs), keyed by "category:subcategory".
 * Value = number of items kept after merging. Each rendered article
 * will display its `source` label inline since the per-source tab row
 * is suppressed.
 *
 * Used when:
 *  - sources are heterogeneous but each publishes few items (blog-weekly)
 *  - the user explicitly wants a curated time-sorted feed rather than
 *    per-source browsing (finance:news, only authoritative sources)
 *
 * Exported so daily.ts can read the cap to keep enrichment in sync.
 */
export const MERGED_SUBGROUP_LIMITS: Record<string, number> = {
  // 技术动态 / 财经要点 合并流：每数据源≤5、子标签整体≤10
  // （省钱 + 避免单一源霸屏）。典型子标签：国外技术 / 国内技术 / 国际财经。
  "tech:overseas-tech": 10,
  "tech:cn-tech": 10,
  "finance:news": 10,
  // 国内财经：上限 20，按接入的信息源平摊（见 groupRaw 的 cn-finance 逻辑）
  "finance:cn-finance": 20,
  // 时政不在本次范围，保留原整体上限
  "politics:world": 15,
};

/**
 * 合并流中单源最多贡献的条数。避免某一源条目过多、按时间降序时把同子标签下
 * 其他源整屏挤出（例如国内财经若某源日期较新、10 条上限会被它独占）。
 * 技术动态 / 财经要点 合并子标签统一为 5（典型：AI媒体 / 国内技术 / 国际财经）。
 * 国内财经（cn-finance）不在此表——它按「子标签上限 / 接入源数量」平摊（20/源数）。
 * 缺省不限制（undefined）即沿用旧行为。
 */
export const MERGE_PER_SOURCE_CAP: Record<string, number> = {
  "tech:overseas-tech": 5,
  "tech:cn-tech": 5,
  "finance:news": 5,
};

/**
 * Politics sources (especially Al Jazeera / BBC / The Diplomat) regularly
 * mix in World Cup / Olympic / football coverage. Filter at the title level
 * so the merged "国际要闻" stream stays politics-only.
 *
 * Pattern is intentionally specific — avoid generic words like "team" or
 * "match" that overlap with diplomacy headlines.
 */
const POLITICS_SPORTS_RE =
  /\b(World\s*Cup|Olympics?|UEFA|FIFA|NBA|NFL|NHL|MLB|ATP|WTA|Premier\s*League|Bundesliga|La\s*Liga|Serie\s*A|Champions\s*League|Eurovision|Wimbledon|Grand\s*Slam|F1|Formula\s*1|Ronaldo|Messi|Mbappe|Beckham|Lukaku|Mitoma|sportsman|footballer|squad)\b|世界杯|奥运|残奥|冬奥|欧冠|英超|西甲|意甲|德甲|网球|足球|篮球|高尔夫|棒球|板球|橄榄球/i;

export function isSportsArticle(title: string): boolean {
  return POLITICS_SPORTS_RE.test(title);
}

export function mergedLimitFor(
  category: Category,
  subId: string,
): number | undefined {
  return MERGED_SUBGROUP_LIMITS[`${category}:${subId}`];
}

// ----- grouping -----
