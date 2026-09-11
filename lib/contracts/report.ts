/**
 * 报告领域模型（契约层 · 零逻辑）。
 *
 * 报告以 sections 驱动渲染；AI 只负责创作，代码负责校验与落位。
 * 5 个板块对应 5 个 tab（红线 #2：最终归属由内容判定，不由 sourceId/category 决定）。
 */

/** 报告板块键（5 个 tab）。 */
export type ReportSectionKey =
  | "gz_local"
  | "biz_insight"
  | "policy_market"
  | "tech"
  | "ipo";

/** 板块顺序即 tab 顺序（渲染 tab / 口播 / 兜底必读统一消费此常量，禁止各处重复定义）。 */
export const SECTION_ORDER: ReportSectionKey[] = [
  "gz_local",
  "biz_insight",
  "policy_market",
  "tech",
  "ipo",
];

/** 板块中文标签（契约层单一真源）。 */
export const SECTION_LABELS: Record<ReportSectionKey, string> = {
  gz_local: "广州本地",
  biz_insight: "业务启示",
  policy_market: "政策与市场",
  tech: "科技前沿",
  ipo: "IPO 动态",
};

/** 业务红线 #2/#3 的落地：板块归属、客户群、风险全部由内容判定产出。 */

export interface ReportItem {
  url: string;
  title_cn: string;
  title_orig?: string;
  source: string;
  source_type: "official" | "media";
  /** MM/DD（展示格式）。 */
  date: string;
  /** 完整 ISO 发布时间（enrich 期填充；展示层继续用 MM/DD）。 */
  published_at?: string;
  /** ≤90 字，结构 = 发生了什么 + 关键数字 + 所以呢。 */
  summary: string;
  /** 3=今日必知 / 2=默认 / 1=折叠。 */
  importance: 1 | 2 | 3;
  /** 板块内排序，由代码生成。 */
  rank: number;
  tags: string[];
  /** gz | national | overseas。 */
  locale: "gz" | "national" | "overseas";
  locale_evidence?: string;
  tier?: import("./source").SourceTier;
  market?: "a-share" | "hk" | "us";
  ipoStage?: string;
  listedDate?: string;
  officialUrl?: string;
  officialLabel?: string;
  gdBasis?: string;
  ipoMeta?: string;
  ipoCity?: string;
}

export interface ReportInsight {
  topic: string;
  tags: string[];
  impact: string;
  action: string;
  /** 客户群细分（零售AUM / 中高端客群 / 普惠小微）；缺省归其他业务线。 */
  segments?: string[];
  sources?: Array<{ title: string; url: string }>;
  related_url?: string;
}

export interface ReportMustRead {
  url: string;
  why: string;
  title?: string;
}

/** 股市解读单卡（口播友好）。 */
export interface MarketCard {
  overview: string;
  sectors: string[];
  spoken?: string;
  indices?: { name: string; value: string; changePct?: string }[];
  meta?: { source: string; date: string; crossCheck: string };
  sourceReport?: { title: string; url: string };
}

/** 昨日股市复盘三卡。 */
export interface StockRecap {
  us: MarketCard;
  aShare: MarketCard;
  hk: MarketCard;
  quoteChannel?: string;
  quoteDate?: string;
  marketStatus?: {
    isMarketClosed: boolean;
    reportDate: string;
    dataDate: string;
    spokenNote?: string;
  };
}

export interface StockNewsItem extends ReportItem {
  market: "a-share" | "hk" | "us";
}

/** 今日风险：1 条最值得警惕（影响按部门拆解）。 */
export interface RiskItem {
  topic: string;
  evidence: string;
  impact: string;
  action: string;
  url?: string;
  source?: "T1" | "T1.5" | "T2";
  sources?: Array<{ title: string; url: string }>;
}

export interface ReportSections {
  gz_local: ReportItem[];
  biz_insight: ReportItem[];
  policy_market: ReportItem[];
  tech: ReportItem[];
  ipo: ReportItem[];
}

/**
 * 漏斗三价值标签（自 gzinfo lib/types.ts ValueTag 移植；写回条目，供口播/排序直接消费）。
 * Tier/Vertical 与 relevance-score 评分器同口径（评分器实现于 services，类型词汇表归契约层）。
 */
export type RelevanceTier = "must_read" | "insight" | "context" | "drop";
export type RelevanceVertical = "must_read" | "insight" | "risk" | "context" | "drop";

export interface ValueTag {
  /** 优先级档位（与 scoreBranchRelevance 同口径） */
  tier: RelevanceTier;
  /** 0-100 综合分行相关性分 */
  score: number;
  /** 命中的业务线（按权重降序，取前 3） */
  businessLines: string[];
  /** 落位建议：risk = 威胁/合规向（进风险卡） */
  vertical: RelevanceVertical;
  /** 是否风险/合规向 */
  risk: boolean;
}

export interface TradingSection {
  market_overview?: string;
  watchlist?: Array<{ symbol: string; note: string }>;
  risk_caveat?: string;
  generated_at: string;
  tickers: unknown[];
}

export interface DailyReport {
  date: string;
  hero_line?: string;
  must_read: ReportMustRead[];
  insights: ReportInsight[];
  sections: ReportSections;
  trading?: TradingSection;
  stock_recap?: StockRecap;
  stock_news?: StockNewsItem[];
  risk?: RiskItem;
}
