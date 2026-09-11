/**
 * 关键词漏斗（C3 内部）：零成本确定性过滤，移植自 gzinfo lib/filters/keyword-filter.ts。
 *
 * 行为口径严格保持：
 *  - L0 全局硬排除：仅标题，命中即丢（finance/gz 主战场唯一硬闸）。
 *  - 地域分 → 维度命中 → 商机/风险追踪器。
 *  - 参考区（tech/ipo/gd-ipo/politics/stocks）豁免银行零售漏斗，仅扫商机/风险追踪器。
 *  - 漏斗只做 L0 明显噪声硬排除，真正的「相关性准度」交给 AI 回检（宁花 AI 成本换准确）。
 */
import type { FilterResult } from "../../contracts/pipeline";

export interface DimensionRule {
  label?: string;
  tier?: string;
  weekly?: boolean;
  strong_keywords?: string[];
  weak_keywords?: string[];
  cooccurrence_for_weak?: Record<string, string[]>;
  exclude?: string[];
}
export interface OpportunityTracker {
  label?: string;
  priority?: "S" | "A" | "B";
  strong_triggers?: string[];
  triggers?: string[];
  geo_lock?: boolean;
  exclude_if_in_title?: string[];
  action?: string;
  fields?: string[];
}
export interface RiskTracker {
  label?: string;
  priority?: "S" | "A" | "B";
  strong_triggers?: string[];
  triggers?: string[];
  geo_lock?: boolean;
  exclude_if_in_title?: string[];
  action?: string;
  fields?: string[];
}
export interface KeywordConfig {
  version?: number;
  note?: string;
  global_exclude?: Record<string, string[]>;
  /** 判重参数（标题相似度判重消费）：threshold 默认 0.7 / max_per_theme 默认 2。 */
  filter_rules?: {
    deduplication?: { threshold?: number; max_per_theme?: number };
    [k: string]: unknown;
  };
  geo_filter?: {
    tier1_exact?: string[];
    tier2_risky?: string[];
    weight?: { tier1_hit?: number; tier2_only?: number };
  };
  dimensions?: Record<string, DimensionRule>;
  opportunity_tracker?: Record<string, OpportunityTracker>;
  risk_tracker?: Record<string, RiskTracker>;
}
export interface FunnelInput {
  title: string;
  content?: string;
  sourceId?: string;
  url?: string;
  /** 归一化 region 分流结果（gz / gd / …），当前过滤以文本地域判定为准，此字段仅透传。 */
  region?: string;
  category?: string;
  tier?: string;
}
/** gzinfo 兼容别名（tests/keyword-filter.test.ts 使用同名）。 */
export type RawArticleInput = FunnelInput;

const REGEX_META = /[.*+?^${}()|[\]\\]/;
function matchToken(token: string, text: string): boolean {
  if (REGEX_META.test(token)) {
    try {
      return new RegExp(token).test(text);
    } catch {
      return text.includes(token);
    }
  }
  return text.includes(token);
}
function anyTokenMatch(tokens: string[] | undefined, text: string): boolean {
  return !!tokens?.some((t) => matchToken(t, text));
}
function matchGeo(config: KeywordConfig, text: string) {
  const g = config.geo_filter;
  if (!g) return { score: 0, hit: false };
  if (anyTokenMatch(g.tier1_exact, text)) return { score: g.weight?.tier1_hit ?? 100, hit: true };
  if (anyTokenMatch(g.tier2_risky, text)) return { score: g.weight?.tier2_only ?? 60, hit: false };
  return { score: 0, hit: false };
}
function matchDimension(d: DimensionRule, text: string) {
  const matched: string[] = [];
  if (d.exclude?.some((w) => text.includes(w))) return { hit: false, strong: false, weak: false, matched };
  for (const w of d.strong_keywords ?? []) {
    if (text.includes(w)) return { hit: true, strong: true, weak: false, matched: [w] };
  }
  for (const [weak, coWords] of Object.entries(d.cooccurrence_for_weak ?? {})) {
    if (!(d.weak_keywords ?? []).includes(weak)) continue;
    if (text.includes(weak) && coWords.some((c) => text.includes(c)))
      return { hit: true, strong: false, weak: false, matched: [weak] };
  }
  for (const w of d.weak_keywords ?? []) {
    if (text.includes(w)) {
      const coWords = d.cooccurrence_for_weak?.[w];
      if (coWords && coWords.length > 0) continue;
      return { hit: false, strong: false, weak: true, matched: [w] };
    }
  }
  return { hit: false, strong: false, weak: false, matched };
}
function matchTracker(t: OpportunityTracker | RiskTracker, text: string, geoHit: boolean) {
  if ("geo_lock" in t && t.geo_lock && !geoHit) return { hit: false, matched: [] };
  if (t.exclude_if_in_title?.some((c) => text.includes(c))) return { hit: false, matched: [] };
  for (const tok of [...(t.strong_triggers ?? []), ...(t.triggers ?? [])]) {
    if (matchToken(tok, text)) return { hit: true, matched: [tok] };
  }
  return { hit: false, matched: [] };
}

const REFERENCE_CATEGORIES = new Set(["tech", "ipo", "gd-ipo", "politics", "stocks"]);

/** 对单条文章执行关键词漏斗。pass=false 表示未命中，应直接丢弃、不进 AI。 */
export function applyKeywordFilter(article: FunnelInput, config: KeywordConfig): FilterResult {
  const title = article.title ?? "";
  const full = `${title}\n${article.content ?? ""}`;
  const matched: string[] = [];

  if (article.category && REFERENCE_CATEGORIES.has(article.category)) {
    const geo = matchGeo(config, full);
    const opportunities = scan("opportunity", config, full, geo.hit, matched);
    const risks = scan("risk", config, full, geo.hit, matched);
    return {
      pass: true,
      score: geo.score + (opportunities.length > 0 ? 1000 : 0),
      dimensions: [],
      ...(opportunities.length > 0 ? { opportunities } : {}),
      ...(risks.length > 0 ? { risks } : {}),
      matched,
      bucket: opportunities.length > 0 ? "opportunity" : "daily",
    };
  }

  for (const group of Object.values(config.global_exclude ?? {})) {
    if (!Array.isArray(group)) continue;
    for (const w of group) {
      if (title.includes(w)) {
        matched.push(w);
        return { pass: false, score: 0, dimensions: [], matched, bucket: "dropped" };
      }
    }
  }

  const geo = matchGeo(config, full);
  const hitDims: string[] = [];
  let dimScore = 0;
  let weekly = false;
  let gray = false;
  for (const [key, d] of Object.entries(config.dimensions ?? {})) {
    const r = matchDimension(d, full);
    if (r.hit) {
      hitDims.push(key);
      dimScore += r.strong ? 2 : 1;
      if (d.weekly) weekly = true;
      matched.push(...r.matched);
    } else if (r.weak) {
      gray = true;
      matched.push(...r.matched);
    }
  }
  const opportunities = scan("opportunity", config, full, geo.hit, matched);
  const risks = scan("risk", config, full, geo.hit, matched);

  let bucket: FilterResult["bucket"] = "daily";
  if (opportunities.length > 0) bucket = "opportunity";
  else if (weekly) bucket = "weekly";

  return {
    pass: true,
    score: geo.score + dimScore + (opportunities.length > 0 ? 1000 : 0),
    dimensions: hitDims,
    ...(opportunities.length > 0 ? { opportunities } : {}),
    ...(risks.length > 0 ? { risks } : {}),
    ...(gray ? { gray: true } : {}),
    matched,
    bucket,
  };
}

function scan(
  kind: "opportunity" | "risk",
  config: KeywordConfig,
  text: string,
  geoHit: boolean,
  matched: string[],
) {
  const PRIORITY: Record<"S" | "A" | "B", number> = { S: 0, A: 1, B: 2 };
  const table = kind === "opportunity" ? config.opportunity_tracker : config.risk_tracker;
  const out: NonNullable<FilterResult["opportunities"]> = [];
  for (const [key, t] of Object.entries(table ?? {})) {
    if (!t || typeof t !== "object" || Array.isArray(t)) continue;
    if (t.priority !== "S" && t.priority !== "A" && t.priority !== "B") continue;
    const r = matchTracker(t, text, geoHit);
    if (r.hit) {
      out.push({ tracker: key, priority: t.priority, label: t.label ?? key, fields: t.fields ?? [], action: t.action ?? "" });
      matched.push(...r.matched);
    }
  }
  out.sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority]);
  return out;
}
