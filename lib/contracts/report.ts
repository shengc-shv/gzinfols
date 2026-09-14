/**
 * 报告领域模型（契约层 · 零逻辑）。
 *
 * 报告以 sections 驱动渲染；AI 只负责创作，代码负责校验与落位。
 * 5 个板块对应 5 个 tab（红线 #2：最终归属由内容判定，不由 sourceId/category 决定）。
 */

/** 地域标记（gzinfo types.ts Locale 同名）：gz=广州辖区 / national=全国 / overseas=海外。 */
import type { IndexQuote, TickerAnalysis, WatchlistPick } from "./market";
export type Locale = "gz" | "national" | "overseas";

/** 报告板块键（5 个 tab）。 */
export type ReportSectionKey =
  | "gz_local"
  | "biz_insight"
  | "policy_market"
  | "tech"
  | "ipo";

/**
 * 板块顺序即 tab 顺序（渲染 tab / 口播 / 兜底必读统一消费此常量，禁止各处重复定义）。
 *
 * ⚠️ 渲染契约：**空板块自动隐藏**（`full.ts` 的 tab 过滤为 `count > 0 || alwaysShow`，
 * 仅 `gz_local` 为 alwaysShow —— 即使 0 条也常驻并显示「今日暂无…」以免被误判为漏采）。
 * 即 tab 数 = 非空板块数 + 1。2026-09-14 审计 P0-2（四主板块全空、产物只剩 3 个 tab）
 * 曾被误读为「渲染退化」—— 实为**上游数据为空**，本常量与渲染过滤本身无问题。
 * 该契约现由 tests/render-invariants.test.ts ①②③ 锁定。
 */
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
  indices?: IndexQuote[];
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
    /** 页面展示文案（仅非交易日有值：橙字警示「周末及周一休市时段…」）。 */
    note?: string;
    /** 口播专用文案（交易日也带日期：「以下行情为上一交易日，X月X日 周X的收盘情况」）。 */
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
  // SKIP_AI / LLM 失败恢复路径下字段可缺省（gzinfo types.ts 逐字；加密两字段按硬性规定不引入）
  market_overview?: string;
  watchlist?: WatchlistPick[];
  risk_caveat?: string;
  generated_at: string;
  tickers: TickerAnalysis[];
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

/**
 * 渲染注入项（2026-09-14 P0-4）。
 *
 * 服务层**不得**直读 `process.env` 与隐式时钟（架构红线）：渲染所需的分享基址、
 * Web 模式、渲染时刻一律由调用方注入 —— 管线从 `ctx.config` / `ctx.startTime` 取，
 * 脚本入口由组合根 helper 从 env 取。
 */
export interface RenderInjection {
  /**
   * 分享卡片基址（REPORT_BASE_URL），如 `https://<user>.github.io/<repo>`。
   * **空值不再回落到任何硬编码仓库地址**：缺失时直接不输出 og:image / twitter:image
   * （宁可不显示缩略图，也不指向别的仓库的 404 资源），同时记一条警告。
   */
  baseUrl?: string;
  /** Web 模式（WEB_MODE=true → 渲染「归档」链接）。缺省 = 不渲染。 */
  webMode?: boolean;
  /** 渲染时刻（页面「数据截至 HH:mm」）。缺省 = 不显示时刻，禁止服务层回落到 `new Date()`。 */
  now?: Date;
}
