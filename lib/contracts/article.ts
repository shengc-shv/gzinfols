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
  /** 注册省份（结构化地域信号；爬虫透传，IPO 板块广东判定第一优先级）。 */
  registeredProvince?: string;
  /** 已知股票代码（可选，供广东判定离线精确匹配）。 */
  stockCode?: string;
  /** 条目级子标签（昨日股市 a-share/hk/us；广州媒体 gz-media 等），采集元数据透传。 */
  subcategory?: string;
  /** 渲染层注记（gzinfo 同款）：同文多源合并时记录「另见来源」名。 */
  alsoFrom?: string[];
}

/** 归一化后条目：已通过时间红线，publishedAt 必填。 */
export interface NormalizedArticle extends RawArticle {
  publishedAt: Date;
  /** IPO 内容态（红线 #2 支撑）：归一化期一次性标注，后续过滤据此豁免去重/窗口。 */
  isIpo: boolean;
  /**
   * 源等级（gzinfo 语义：可缺省——未声明 tier 的源保持 undefined，
   * 标题相似度判重按「无等级垫底」单独成档，不与 T2 同档）。
   */
  tier?: SourceTier;
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
  /**
   * 条目级相关性判定（gzinfo ArticleInput.relevant 同名同义）：
   * PASS1 keep=true 时置 true；false = AI/打标判无关（滚动并入硬门槛）。
   * 历史库字段名 ai_relevant（entryToArticle/buildRolling 双向映射）。
   */
  relevant?: boolean;
  /** 滚动并入标记：true=当日已处理（buildRolling 标注），渲染按「当天」视图归组。 */
  fetchedToday?: boolean;
}

/**
 * 爬虫线格式（adapters/crawlers 产物 → 归一化 crawl.ts 的入参）。
 *
 * 与 gzinfo lib/ingest/merge.ts 的 CrawledArticle 同构：
 * - publishedAt 为**字符串**（裸北京时间 / ISO / 日期），由归一化层 normalizePubTime
 *   统一补 +08:00 后 parse；无发布时间的条目由 C2 归一化丢弃（红线 #1，绝不兜底抓取时间）。
 * - region（gz | gd | nation）由 routeRegion 消费做三分流 + `gd-`→`gz-` 前缀改写；
 *   category 在此仅是采集元数据兜底，不驱动最终板块归属（红线 #2）。
 */
export interface CrawledArticle {
  sourceId?: string;
  source?: string;
  title?: string;
  url?: string;
  excerpt?: string;
  publishedAt?: string;
  fetchedAt?: string;
  region?: string;
  category?: string;
  subcategory?: string;
  summary?: string;
  tier?: SourceTier;
  registeredProvince?: string;
  stockCode?: string;
  officialUrl?: string;
  officialLabel?: string;
  ipoStage?: string;
  listedDate?: string;
  gdBasis?: string;
}

import type { SourceTier } from "./source";
import type { ValueTag } from "./report";
