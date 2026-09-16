/**
 * 筛选服务 C3：7 道过滤链（自 gzinfo lib/pipeline/filter 逐字移植）。
 *
 * 三漏斗结构（gzinfo 2026-08-31 整改定案）：
 *  - 漏斗一 业务相关性（今日新增）：single-institution + stock-single + keyword-funnel
 *  - 漏斗二 时效+去重（今日新增）：pre-window-2d(IPO 7 天豁免) + title-similarity + cross-day-dedup + global-value-cap
 *  - 漏斗三 业务价值（全窗口）：滚动并入 + execPool + applyDisplayCaps —— **不在本链**（B3 批次对齐），
 *    本链收尾的 global-value-cap 只做「打通分数排名的总量控制」，绝不是漏斗三（gzinfo stages.ts 头部红线）。
 *
 * 顺序（与 gzinfo FILTER_STAGES 一致）：
 *   1. pre-window-2d       源层前置窗口（IPO 类 7 天豁免）
 *   2. single-institution  单家非白名单金融机构新闻过滤（IPO 豁免）
 *   3. stock-single        股市单股新闻过滤（仅 stocks 类）
 *   4. keyword-funnel      关键词漏斗（L0 硬排除；全量误杀回退保底；KEYWORD_FILTER=off 旁路）
 *   5. title-similarity    标题相似度判重（IPO 豁免；DEDUP_SIMILAR=off 旁路）
 *   6. cross-day-dedup     跨天标题判重（历史先来后到；IPO 豁免）
 *   7. global-value-cap    全部候选**打通分数排名**取 Top200 + 每源软上限 20
 *      （2026-09-16 用户口径，取代旧「每源等额配额 20」—— 旧口径实测被删条目中 97%
 *        的分数高于保留组最低分，即砍的不是「最差」而是「大源的中间层」）
 *
 * B-1 语义保留：跑完 stage 链后单独再跑一次 keyword 过滤，为 pass=true 的条目建
 * url→FilterResult 表（含 opportunities/risks），供 enrich 相关性回检与 side-outputs 提取风险候选。
 */
import type { ArticleInput } from "../../contracts/article";
import type { SourceTier } from "../../contracts/source";
import type {
  FilterFlags,
  FilterResult,
  PipelineContext,
  SelectResult,
} from "../../contracts/pipeline";
import type { FileStore, Logger } from "../../contracts/pipeline";
import type { SourceStat } from "../../contracts/report";
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
import { GLOBAL_TOP_N, PER_SOURCE_SOFT_CAP, takeGlobalTopByValue } from "./filters/light-ai";

/**
 * 分行相关性评分（本文件统一出口）：
 * ⚠️ `sourceId` 传 `a.source` —— 与 select 原实现逐字一致（relevance-score 内部按源名归类），
 * 改动会影响排序结果，需连带核对 tests/select 与 light-ai 测试。
 */
function relevanceScoreOf(a: ArticleInput): number {
  return scoreBranchRelevance({
    title: a.title_cn ?? a.title ?? "",
    summary: a.summary ?? "",
    sourceId: a.source,
    category: a.category,
    subcategory: a.subcategory,
    url: a.url,
  }).score;
}

export interface SelectDeps {
  fs: FileStore;
  /** 跨天判重用的历史库（pipeline 在 select 前加载传入；缺省 = 空历史）。 */
  /** 跨天判重历史库（gzinfo HistoryStore 形状；pipeline 从持久化加载后传入）。 */
  history?: import("../memory/history").HistoryStore;
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
  /** 过滤链旁路开关（由组合根注入 ctx.config.filters，服务层不读 env）。 */
  filters: FilterFlags;
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
    // 日志里写明**窗口天数**：此前只写「超窗旧文」，读日志的人无法判断窗口到底是几天
    // （2026-09-15 用户据此误以为「采集 1503 条 = 没按两天窗口抓」）。
    const winLabel = ctx.windowDays === 2 ? "今天+昨天" : `含今天共 ${ctx.windowDays} 个日历日`;
    if (out.length !== before) {
      ctx.log.info(
        "filter",
        `🧹 源层前置窗口过滤（非 IPO 类 ${winLabel} / IPO 类 7 天窗豁免）: ${before} → ${out.length} 条（移除 ${before - out.length} 条超窗旧文）`,
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
  enabled: (ctx) => keywordFilterEnabled(ctx.filters),
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
    if (keep.length === 0 && keywordFilterFallbackEnabled(ctx.filters)) {
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
  enabled: (ctx) => dedupSimilarEnabled(ctx.filters),
  apply: (articles, ctx) => {
    const dd = loadDedupConfig(ctx.keywordConfig, ctx.filters);
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

/**
 * 收尾：**全局按分行相关性取 Top N + 每源软上限**（2026-09-16 用户口径，取代旧「每源等额配额」）。
 *
 * 旧口径（capLightAiSources）每源各自排序各留 20 —— 大源的第 21 名（分更高）被砍、
 * 小源的第 1 名（分更低）却保留，实测被删条目中 97% 的分数高于保留组最低分。
 * 新口径打通分数排名后收满 `GLOBAL_TOP_N`，让**分数**而非**源身份**决定去留。
 */
const globalValueCapStage: FilterStage = {
  name: "global-value-cap",
  apply: (articles, ctx) => {
    const before = articles.length;
    const out = takeGlobalTopByValue(articles, GLOBAL_TOP_N, PER_SOURCE_SOFT_CAP, relevanceScoreOf);
    if (out.length < before) {
      ctx.log.info(
        "filter",
        `🔻 全局相关性取 Top${GLOBAL_TOP_N}（每源软上限 ${PER_SOURCE_SOFT_CAP}）: 移除 ${before - out.length} 条（${before} → ${out.length}）`,
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
  globalValueCapStage,
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

  // 历史条目投影（gzinfo 同款：rolling store 的 Object.values → {title,url,tier}；
  // store 本身由 pruneHistory 按日历窗口裁剪到「今天+昨天」，投影无需再过滤）
  const windowDays = ctx.config.windowDays;
  const histSim: HistorySimilarEntry[] = Object.values(deps.history ?? {}).map((e) => ({
    title: e.title,
    url: e.url,
    tier: ctx.tierBySource.get(e.sourceId),
  }));

  const fctx = {
    date: ctx.date,
    tierBySource: ctx.tierBySource,
    history: histSim,
    allSourceIds: new Set(ctx.sources.map((s) => s.id)),
    windowDays,
    keywordConfig: config,
    filters: ctx.config.filters,
    startTime: () => ctx.startTime,
    log: ctx.log,
  };

  let cur = articles;
  // 每源存活率观测（2026-09-16 用户需求）：以**进入漏斗时**的每源条数为分母，
  // 漏斗全部跑完后统计每源保留量，用于评估「哪个源噪声大 / 哪个源被窗口或限额压制」。
  const inflow = new Map<string, number>();
  for (const a of articles) {
    const k = a.sourceId || "(无源)";
    inflow.set(k, (inflow.get(k) ?? 0) + 1);
  }
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

  // 每源存活率报告（进入 → 保留；供数据源质量观测与后续调参）
  const sourceStats = logPerSourceYield(ctx, inflow, cur);

  // A5：补齐「本期抓取 0 条的已启用源」——缺失源要在数据戳里可见（否则读者无法判断是否漏采）。
  const seen = new Set(sourceStats.map((s) => s.sourceId));
  for (const s of ctx.sources) {
    if (s.enabled === false || seen.has(s.id)) continue;
    sourceStats.push({ sourceId: s.id, inflow: 0, kept: 0, avgScore: null });
  }

  return { articles: cur, filterResults, sourceStats };
}

/**
 * 每源存活率日志 + 统计（plan-redchip 之外的**通用观测**，2026-09-16 用户需求）：
 * 每源「进入漏斗 N 条 → 保留 M 条（比例）+ 保留条目的平均相关性分」，
 * 按进入量降序 —— 一眼看出「哪个源贡献量大、哪个源存活率高、哪个源被压制」。
 *
 * @returns 统计数组（A5 数据戳颗粒度会带进报告落盘并渲染给读者）
 */
function logPerSourceYield(
  ctx: PipelineContext,
  inflow: Map<string, number>,
  survivors: ArticleInput[],
): SourceStat[] {
  const kept = new Map<string, number[]>();
  for (const a of survivors) {
    const k = a.sourceId || "(无源)";
    const arr = kept.get(k) ?? [];
    arr.push(relevanceScoreOf(a));
    kept.set(k, arr);
  }
  const rows = [...inflow.entries()]
    .map(([sid, n]) => {
      const scores = kept.get(sid) ?? [];
      const avg = scores.length ? scores.reduce((x, y) => x + y, 0) / scores.length : null;
      return { sid, n, m: scores.length, ratio: n ? scores.length / n : 0, avg };
    })
    .sort((a, b) => b.n - a.n);

  const lines = rows.slice(0, 20).map((r) => {
    const pct = `${Math.round(r.ratio * 100)}%`;
    return `  ${r.sid.padEnd(22)} ${String(r.n).padStart(5)} → ${String(r.m).padStart(4)}（${pct.padStart(4)}）均分 ${r.avg === null ? "-" : r.avg.toFixed(0)}`;
  });
  if (rows.length > 20) lines.push(`  … 其余 ${rows.length - 20} 个源`);
  ctx.log.info(
    "filter",
    `📊 每源存活率（进入 → 保留，按进入量降序；观察数据源质量用）：\n${lines.join("\n")}`,
  );
  return rows.map((r) => ({
    sourceId: r.sid,
    inflow: r.n,
    kept: r.m,
    avgScore: r.avg === null ? null : Math.round(r.avg),
  }));
}
