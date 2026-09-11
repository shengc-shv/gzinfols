/**
 * 文章领域模型（契约层 · 零逻辑）。
 *
 * 设计要点：用类型阶（Raw → Normalized → Input）把「时间真实性红线」固化进编译器。
 * - RawArticle：抓取层产物，publishedAt 可能缺失（红线：缺失即丢弃）。
 * - NormalizedArticle：归一化后产物，publishedAt 必填（缺失条目已被丢弃，进不来）。
 *   这是红线 #1（无真实发布时间一律丢弃）的类型级保证，而非仅靠注释约束。
 * - ArticleInput：归一化 + 运行时展示字段，贯穿管道下游。
 */

/** 数据源业务分类。注意：分类只是采集元数据，最终板块归属一律由内容判定（红线 #2）。 */
export type ArticleCategory =
  | "tech"
  | "finance"
  | "politics"
  | "gd-ipo"
  | "ipo"
  | "gz"
  | "stocks";

/** 来源性质：官方一手 | 媒体智库。 */
export type SourceType = "official" | "media";

/** 抓取层原始条目（publishedAt 可能缺失）。 */
export interface RawArticle {
  sourceId: string;
  title: string;
  url: string;
  excerpt?: string;
  publishedAt?: Date;
  fetchedAt?: Date;
  category: ArticleCategory;
  summary?: string;
  meta?: string;
  officialUrl?: string;
  officialLabel?: string;
  tier?: SourceTier;
  /** IPO 内容态 hint（采集期可先标，最终以归一化 C2 的必填标注为准）。 */
  isIpo?: boolean;
  /** IPO 阶段（官方审核状态），仅作分栏/排序 hint，不驱动地域/相关性过滤。 */
  ipoStage?: string;
  listedDate?: string;
  gdBasis?: string;
  subcategories?: string[];
}

/** 归一化后条目：已通过时间红线，publishedAt 必填。 */
export interface NormalizedArticle extends RawArticle {
  publishedAt: Date;
  /** IPO 内容态（红线 #2 支撑）：归一化期一次性标注，后续过滤据此豁免去重/窗口。 */
  isIpo: boolean;
  /** 源等级，归一化期补齐。 */
  tier: SourceTier;
  /** 保证非空（无 excerpt 时回退标题前 90 字），避免历史库写入后被判空踢出。 */
  excerpt: string;
}

/** 贯穿管道下游的运行时条目。 */
export interface ArticleInput extends NormalizedArticle {
  /** 展示用来源名（来自 SourceDef.name）。 */
  source: string;
  /** 外文标题中文化（仅商机洞察/必读选中的条目回写）。 */
  title_cn?: string;
  /** 漏斗三价值标签（确定性评分写回，供口播直接消费）。 */
  valueTag?: ValueTag;
}

/** TS 爬虫产物（providers 进程内调用，归一化接入）。 */
export interface CrawledArticle {
  sourceId: string;
  title: string;
  url: string;
  excerpt?: string;
  publishedAt?: Date;
  fetchedAt: Date;
  category: ArticleCategory;
  tier?: SourceTier;
  ipoStage?: string;
  listedDate?: string;
  gdBasis?: string;
  subcategories?: string[];
}

import type { SourceTier } from "./source";
import type { ValueTag } from "./report";
