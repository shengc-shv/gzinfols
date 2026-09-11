/**
 * 数据源契约（契约层 · 零逻辑）。
 */

import type { ArticleCategory } from "./article";

/** 抓取机制（对应 sources.config.json 的 type 字段；与展示用的「官方/媒体」无关）。 */
export type SourceFetchType = "rss" | "api" | "scrape";

/** 源等级（T1 官方一手 / T1.5 准官方·机构一手 / T2 媒体·智库）。 */
export type SourceTier = "T1" | "T1.5" | "T2";

export const SOURCE_TIERS: readonly SourceTier[] = ["T1", "T1.5", "T2"];

export const SOURCE_TIER_LABELS: Record<SourceTier, string> = {
  T1: "官方一手",
  "T1.5": "准官方·机构一手",
  T2: "媒体·智库",
};

/** 排序权重：T1 > T1.5 > T2。 */
export const SOURCE_TIER_ORDER: Record<SourceTier, number> = {
  T1: 3,
  "T1.5": 2,
  T2: 1,
};

export function isSourceTier(v: unknown): v is SourceTier {
  return v === "T1" || v === "T1.5" || v === "T2";
}

/** 数据源唯一真源中的单条定义（sources.config.json）。 */
export interface SourceDef {
  id: string;
  name: string;
  type: SourceFetchType;
  url: string;
  category: ArticleCategory;
  subcategory?: string;
  /** 用 curl 而非 fetch（规避 TLS 指纹挑战的主机）。 */
  useCurl?: boolean;
  enabled?: boolean;
  /** 内容语言；等于活跃 REPORT_LOCALE 时跳过摘要翻译。 */
  lang?: "zh" | "en";
  /** 参与的报告 locale；省略默认 ["zh","en"]。 */
  locales?: ("zh" | "en")[];
  /** 可选关键词白名单（命中才保留）。 */
  keywords?: string[];
  /** crawler 产物路由源（url 为 file:// 占位，数据由 providers 产出）。 */
  role?: "crawled-input" | string;
  tier?: SourceTier;
  notes?: string;
}
