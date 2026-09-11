/**
 * 过滤链配置与旁路开关（自 gzinfo lib/filters/config.ts 移植适配）。
 *
 * 配置：sources.keywords.json（由调用方经 FileStore 端口加载后传入，2.0 服务层不直读 fs）。
 * 旁路：开关由组合根读 KEYWORD_FILTER / KEYWORD_FILTER_FALLBACK / DEDUP_SIMILAR（=off 关闭）
 *      注入 `ctx.config.filters`，本模块只做纯判定，不读 env。
 */
import type { FilterFlags } from "../../../contracts/pipeline";
import type { KeywordConfig } from "../funnel";

/** 漏斗是否启用（KEYWORD_FILTER）。 */
export function keywordFilterEnabled(flags: FilterFlags): boolean {
  return flags.keyword;
}

/** 全量被误杀时是否回退保底（默认回退，避免空报告；KEYWORD_FILTER_FALLBACK）。 */
export function keywordFilterFallbackEnabled(flags: FilterFlags): boolean {
  return flags.keywordFallback;
}

/** 标题相似度判重是否启用（DEDUP_SIMILAR）。 */
export function dedupSimilarEnabled(flags: FilterFlags): boolean {
  return flags.dedupSimilar;
}

export interface DedupConfig {
  enabled: boolean;
  threshold: number;
  maxPerTheme: number;
}

/**
 * 读取判重参数：优先 sources.keywords.json 的 filter_rules.deduplication
 * （threshold / max_per_theme），缺省 threshold=0.7、max_per_theme=2。
 */
export function loadDedupConfig(config: KeywordConfig | null, flags: FilterFlags): DedupConfig {
  const cfg: DedupConfig = {
    enabled: dedupSimilarEnabled(flags),
    threshold: 0.7,
    maxPerTheme: 2,
  };
  try {
    const d = (config as { filter_rules?: { deduplication?: { threshold?: number; max_per_theme?: number } } } | null)
      ?.filter_rules?.deduplication;
    if (d) {
      if (typeof d.threshold === "number") cfg.threshold = d.threshold;
      if (typeof d.max_per_theme === "number") cfg.maxPerTheme = d.max_per_theme;
    }
  } catch {
    // 配置缺失时用默认参数
  }
  return cfg;
}
