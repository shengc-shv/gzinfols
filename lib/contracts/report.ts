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

/** 业务红线 #2/#3 的落地：板块归属、客户群、风险全部由内容判定产出。 */

export interface ReportItem {
  url: string;
  title_cn: string;
  title_orig?: string;
  source: string;
  source_type: "official" | "media";
  /** MM/DD。 */
  date: string;
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

/** 漏斗三价值标签（确定性、免费、可解释），供口播直接消费。 */
export interface ValueTag {
  tier: import("./source").SourceTier;
  score: number;
  businessLines: string[];
  vertical: "retail" | "wealth" | "credit" | "risk";
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
