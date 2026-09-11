/**
 * 筛选服务 C3：7 道过滤链（自 gzinfo lib/pipeline/filter 逐字移植）。
 *
 * 三漏斗结构（gzinfo 2026-08-31 整改定案）：
 *  - 漏斗一 业务相关性（今日新增）：single-institution + stock-single + keyword-funnel
 *  - 漏斗二 时效+去重（今日新增）：pre-window-2d(IPO 7 天豁免) + title-similarity + cross-day-dedup + per-source-cap-20
 *  - 漏斗三 业务价值（全窗口）：滚动并入 + execPool + applyDisplayCaps —— **不在本链**（B3 批次对齐），
 *    本链收尾的 per-source-cap 只保来源多样性，绝不是漏斗三（gzinfo stages.ts 头部红线）。
 *
 * 顺序（与 gzinfo FILTER_STAGES 一致）：
 *   1. pre-window-2d       源层前置窗口（IPO 类 7 天豁免）
 *   2. single-institution  单家非白名单金融机构新闻过滤（IPO 豁免）
 *   3. stock-single        股市单股新闻过滤（仅 stocks 类）
 *   4. keyword-funnel      关键词漏斗（L0 硬排除；全量误杀回退保底；KEYWORD_FILTER=off 旁路）
 *   5. title-similarity    标题相似度判重（IPO 豁免；DEDUP_SIMILAR=off 旁路）
 *   6. cross-day-dedup     跨天标题判重（历史先来后到；IPO 豁免）
 *   7. per-source-cap-20   每源 ≤20 多样性封顶 + 源内分行相关性降序
 *
 * B-1 语义保留：跑完 stage 链后单独再跑一次 keyword 过滤，为 pass=true 的条目建
 * url→FilterResult 表（含 opportunities/risks），供 enrich 相关性回检与 side-outputs 提取风险候选。
 */
import type { ArticleInput } from "../../contracts/article";
import type { SourceTier } from "../../contracts/source";
import type { FilterResult, PipelineContext, SelectResult } from "../../contracts/pipeline";
import type { FileStore, Logger } from "../../contracts/pipeline";
import { isWithinCalendarDays } from "../../utils/time";
import { applyKeywordFilter, type KeywordConfig } from "./funnel";
import { filterSingleInstitution } from "./filters/single-institution";
import { filterStockNews } from "./filters/stock-single";
import {
  keywordFilterEnabled,
  keywordFilterFallbackEnabled,
  dedupSimilarEnabled,
  loadDedupConfig,
} from "./filters/config";
import {
  dedupeByTitleSimilarity,
  dedupeAgainstHistory,
  type HistorySimilarEntry,
} from "./filters/dedup-similar";
import { scoreBranchRelevance } from "./filters/relevance-score";
import { capLightAiSources, LIGHT_AI_MAX_PER_SOURCE } from "./filters/light-ai";

export interface SelectDeps {
  fs: FileStore;
  /** 跨天判重用的历史库（pipeline 在 select 前加载传入；缺省 = 空历史）。 */
  history?: Array<{ title: string; url: string; sourceId?: string; publishedAt?: string }>;
}

/** 过滤阶段共享上下文（gzinfo FilterContext 适配版）。 */
interface FilterContext {
  date: string;
  tierBySource: Map<string, SourceTier>;
  /** 跨天判重历史条目（title/url/tier；gzinfo 为 rolling store 的 Object.values 投影）。 */
  history: HistorySimilarEntry[];
  allSourceIds: Set<string>;
  windowDays: number;
  keywordConfig: KeywordConfig;
  startTime: () => Date;
  log: Logger;
}

/** 过滤阶段接口：纯函数，不 mutate 入参。 */
interface FilterStage {
  name: string;
  enabled?(ctx: FilterContext): boolean;
  apply(articles: ArticleInput[], ctx: FilterContext): ArticleInput[];
}

/** 日历日窗口过滤（gzinfo filterByWindow 同款：publishedAt ∈ 最近 N 个日历日）。 */
function filterByWindow<T extends { publishedAt?: Date }>(articles: T[], days: number, now: Date): T[] {
  return articles.filter((a) => isWithinCalendarDays(a.publishedAt, days, now));
}

/** Stage 1：源层前置窗口（2 天；IPO 类 7 天豁免——爬虫已按 7 天窗口预筛、更新稀疏）。 */
const preWindowStage: FilterStage = {
  name: "pre-window-2d",
  apply: (articles, ctx) => {
    const before = articles.length;
    const ipo = articles.filter((a) => a.isIpo === true);
    const others = articles.filter((a) => a.isIpo !== true);
    const out = [...filterByWindow(ipo, 7, ctx.startTime()), ...filterByWindow(others, ctx.windowDays, ctx.startTime())];
    if (out.length !== before) {
      ctx.log.info(
        "filter",
        `🧹 源层前置窗口过滤: ${before} → ${out.length} 条（移除 ${before - out.length} 条超窗旧文；IPO 类按 7 天窗口豁免）`,
      );
    }
    return out;
  },
};

/** Stage 2：单机构新闻过滤（2026-08-25 gzinfo 用户决定永久生效；IPO 类豁免——保荐机构非新闻主体）。 */
const singleInstitutionStage: FilterStage = {
  name: "single-institution",
  apply: (articles, ctx) => {
    const before = articles.length;
    const ipo = articles.filter((a) => a.isIpo === true);
    const others = articles.filter((a) => a.isIpo !== true);
    const out = [...ipo, ...filterSingleInstitution(others)];
    if (out.length !== before) {
      ctx.log.info(
        "filter",
        `🏛️ 单机构过滤: ${before} → ${out.length} 条（移除 ${before - out.length} 条非白名单单机构新闻；IPO 类豁免）`,
      );
    }
    return out;
  },
};

/** Stage 3：股市单股过滤（2026-08-25 gzinfo 用户决定永久生效；仅 stocks 类生效）。 */
const stockSingleStage: FilterStage = {
  name: "stock-single",
  apply: (articles, ctx) => {
    const before = articles.length;
    const out = filterStockNews(articles);
    if (out.length !== before) {
      ctx.log.info(
        "filter",
        `📈 股市单股过滤: ${before} → ${out.length} 条（移除 ${before - out.length} 条非巨头/非广州本地单股新闻）`,
      );
    }
    return out;
  },
};

/** Stage 4：关键词漏斗（L0 硬过滤；全量误杀回退保底；KEYWORD_FILTER=off 旁路）。 */
const keywordFunnelStage: FilterStage = {
  name: "keyword-funnel",
  enabled: () => keywordFilterEnabled(),
  apply: (articles, ctx) => {
    const kwConfig = ctx.keywordConfig;
    const before = articles.length;
    const keep: ArticleInput[] = [];
    let opp = 0;
    let weekly = 0;
    for (const a of articles) {
      const r = applyKeywordFilter(
        {
          title: a.title,
          content: a.excerpt,
          sourceId: a.sourceId,
          url: a.url,
          category: a.category, // 参考区（tech/ipo/gd-ipo/politics）豁免漏斗，仅商机扫描
        },
        kwConfig,
      );
      if (!r.pass) continue;
      keep.push(a);
      if (r.bucket === "opportunity") opp++;
      if (r.bucket === "weekly") weekly++;
    }
    if (keep.length === 0 && keywordFilterFallbackEnabled()) {
      ctx.log.warn(
        "filter",
        `⚠️ 关键词漏斗将全部 ${before} 条过滤为 0（疑似误杀/词表过严）— 回退全量保底，避免空报告`,
      );
      return articles;
    }
    ctx.log.info(
      "filter",
      `🔻 关键词漏斗: ${before} → ${keep.length} 条（商机 ${opp} / 周报 ${weekly}，其余日报池）`,
    );
    return keep;
  },
};

/** Stage 5：标题相似度判重（同主题 ≤ maxPerTheme、同 tier 只留 1；IPO 豁免；DEDUP_SIMILAR=off 旁路）。 */
const titleSimilarityStage: FilterStage = {
  name: "title-similarity",
  enabled: () => dedupSimilarEnabled(),
  apply: (articles, ctx) => {
    const dd = loadDedupConfig(ctx.keywordConfig);
    const ipo = articles.filter((a) => a.isIpo === true);
    const others = articles.filter((a) => a.isIpo !== true);
    const before = articles.length;
    const { kept, removed } = dedupeByTitleSimilarity(others, {
      threshold: dd.threshold,
      maxPerTheme: dd.maxPerTheme,
    });
    const out = [...ipo, ...kept];
    if (removed.length > 0) {
      ctx.log.info(
        "filter",
        `🔁 标题相似度判重: ${before} → ${out.length} 条（阈值 ${dd.threshold}、每主题 ≤${dd.maxPerTheme}、同 tier 只留 1；移除 ${removed.length} 条重复报道；IPO 类豁免）`,
      );
    }
    return out;
  },
};

/** Stage 6：跨天标题判重（先来后到；历史库已覆盖的重复主题丢弃；IPO 豁免——7 天滚动视图）。 */
const crossDayDedupStage: FilterStage = {
  name: "cross-day-dedup",
  apply: (articles, ctx) => {
    const histSim = ctx.history;
    const ipo = articles.filter((a) => a.isIpo === true);
    const others = articles.filter((a) => a.isIpo !== true);
    const before = articles.length;
    const { kept, removed } = dedupeAgainstHistory(others, histSim, { maxPerTheme: 2 });
    const out = [...ipo, ...kept];
    if (removed.length > 0) {
      ctx.log.info(
        "filter",
        `🔄 跨天标题判重: ${before} → ${out.length} 条（历史库已覆盖 ${removed.length} 条重复主题；IPO 类豁免）`,
      );
    }
    return out;
  },
};

/** 收尾：每源 ≤20 多样性封顶 + 源内分行相关性降序（⚠️ 漏斗一/二收尾，非漏斗三）。 */
const perSourceCapStage: FilterStage = {
  name: "per-source-cap-20",
  apply: (articles, ctx) => {
    const before = articles.length;
    const out = capLightAiSources(
      articles,
      ctx.allSourceIds,
      LIGHT_AI_MAX_PER_SOURCE,
      (a) =>
        scoreBranchRelevance({
          title: a.title_cn ?? a.title ?? "",
          summary: a.summary ?? "",
          sourceId: a.source,
          category: a.category,
          subcategory: a.subcategory,
          url: a.url,
        }).score,
    );
    if (out.length < before) {
      ctx.log.info(
        "filter",
        `🔻 每源限额: 移除 ${before - out.length} 条（全部媒体源每源≤${LIGHT_AI_MAX_PER_SOURCE} 条进 LLM 分析/展示）`,
      );
    }
    return out;
  },
};

const FILTER_STAGES: FilterStage[] = [
  preWindowStage,
  singleInstitutionStage,
  stockSingleStage,
  keywordFunnelStage,
  titleSimilarityStage,
  crossDayDedupStage,
  perSourceCapStage,
];

/**
 * 筛选入口：顺序执行 7 道过滤 → B-1 补跑 keyword 建 url→FilterResult 表（含 opp/risks）。
 * gzinfo 语义：filterResults 原本仅存「有 risks」的条目（side-outputs 提取风险候选）；
 * 2.0 因 enrich 相关性回检还需读 opportunities，故存「opp 或 risks 命中」的超集（差异已在核对报告标注）。
 */
export async function select(
  articles: ArticleInput[],
  ctx: PipelineContext,
  deps: SelectDeps,
): Promise<SelectResult> {
  const config = await deps.fs.readJson<KeywordConfig>("sources.keywords.json");
  if (!config) throw new Error("sources.keywords.json 缺失，无法执行漏斗");

  // 历史条目投影（gzinfo：rolling store 的 Object.values → {title,url,tier}；
  // 2.0 近似：仅取发布日落在抓取窗口内的条目——gzinfo 的 store 由 lastSeenAt 裁剪到同窗口，H1 批次对齐存储形状）
  const windowDays = ctx.config.windowDays;
  const histSim: HistorySimilarEntry[] = (deps.history ?? [])
    .filter((it) => isWithinCalendarDays(it.publishedAt, windowDays + 1, ctx.startTime))
    .map((it) => ({
      title: it.title,
      url: it.url,
      tier: it.sourceId ? ctx.tierBySource.get(it.sourceId) : undefined,
    }));

  const fctx = {
    date: ctx.date,
    tierBySource: ctx.tierBySource,
    history: histSim,
    allSourceIds: new Set(ctx.sources.map((s) => s.id)),
    windowDays,
    keywordConfig: config,
    startTime: () => ctx.startTime,
    log: ctx.log,
  };

  let cur = articles;
  for (const stage of FILTER_STAGES) {
    if (stage.enabled && !stage.enabled(fctx)) {
      ctx.log.info("filter", `⏭ ${stage.name} (disabled)`);
      continue;
    }
    cur = stage.apply(cur, fctx);
  }

  // B-1：单独再跑 keyword 过滤，建 url→FilterResult（仅存 opp/risks 命中者）
  const filterResults = new Map<string, FilterResult>();
  for (const a of cur) {
    const r = applyKeywordFilter(
      {
        title: a.title ?? "",
        content: a.excerpt,
        sourceId: a.sourceId ?? "",
        url: a.url,
        category: a.category,
      },
      config,
    );
    if ((r.risks && r.risks.length > 0) || (r.opportunities && r.opportunities.length > 0)) {
      filterResults.set(a.url, r);
    }
  }

  ctx.log.info("select", `过滤链完成：${articles.length} → ${cur.length} 条（7 道）`);
  return { articles: cur, filterResults };
}
