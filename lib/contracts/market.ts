/**
 * 市场行情契约（零逻辑）：行情 API 产物与股市卡输入类型。
 *
 * 来源：gzinfo lib/sources/quote-api.ts 的 IndexQuote/MarketQuotes/QuoteResult
 * （原定义在 sources 层，2.0 上移契约层——行情数据被 services/market 与其消费方
 * 共同引用，类型归契约符合端口-适配器架构；定义逐字一致，行为不变）。
 * StockItem 来自 gzinfo lib/ai/stock-recap.ts，同理由此收敛。
 */

/** 单指数行情（收盘点位 + 涨跌幅）。 */
export interface IndexQuote {
  /** 指数中文名（硬编码，避免 GBK 解码） */
  name: string;
  /** 收盘点位（A股/港股=昨收；美股=最新收盘），保留 2 位小数 */
  value: string;
  /** 涨跌幅，带符号，如 "+0.26%" / "-0.76%"；港股指数无日 K 故可能缺失 */
  changePct?: string;
}

/** 三市场行情集合。 */
export interface MarketQuotes {
  aShare: IndexQuote[];
  hk: IndexQuote[];
  us: IndexQuote[];
}

/** 行情抓取结果（含渠道与取值日，卡脚备注用）。 */
export interface QuoteResult {
  quotes: MarketQuotes;
  /** 数据渠道（如「新浪行情」/「新浪K线」） */
  channel: string;
  /** 取值日（上一交易日，YYYY-MM-DD） */
  date: string;
  /**
   * 各市场**数据自带日期**（YYYY-MM-DD，均为北京日期口径）：
   *  - A股 = 新浪日 K 线最新一根的 `day`；
   *  - 港股 = hq 字段 f[17]（`2026/09/18`）；
   *  - 美股 = hq 字段 f[3] 的日期部分（北京时间，= 美东前一日凌晨收盘）。
   *
   * 缺失 = 该市场本次未取到数据。消费方（market-status）据此判断
   * 「该市场是否真有隔夜行情」，不再靠星期几推算。
   */
  dates?: { aShare?: string; hk?: string; us?: string };
}

/** 单条市场输入（标题 + 摘要 + 源链接 + 发布日期；gzinfo ai/stock-recap.ts StockItem 逐字）。 */
export interface StockItem {
  title: string;
  summary?: string;
  url?: string;
  source?: string;
  /** 发布日期 YYYY-MM-DD（A股/港股=爬虫标注；美股=RSS pubDate 归一化） */
  publishedAt?: string;
}

/* ───────── 交易面板（trading）契约 ─────────
 * 移植自 gzinfo lib/trading/*（2026-09-12，B6 批次）。
 * 加密资产（加密分组 / 两类加密行情指标源）按硬性规定**永久剔除**，
 * 故 AssetGroup 不含加密分组，也不引入任何加密相关类型。
 */

/** Yahoo Finance 日 K（ oldest first）。 */
export interface OHLC {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Yahoo Finance 标的原始数据包。 */
export interface TickerRawData {
  symbol: string;
  currency: string;
  exchangeName: string;
  regularMarketPrice: number;
  fiftyTwoWeekHigh: number;
  fiftyTwoWeekLow: number;
  /** 最近约 1 年的日 OHLCV，oldest first。 */
  candles: OHLC[];
}

/** 资产分组（注意：无 crypto —— 加密永久剔除）。 */
export type AssetGroup =
  | "us-equity" // 美股蓝筹 + ETF
  | "china-equity" // 中概股 / 港股
  | "commodity-fx" // 商品 + 外汇
  | "macro"; // 宏观信号（恐慌指数 / 利率 / 美元指数）

/** 监控标的（Yahoo symbol + 展示名 + 分组）。 */
export interface TickerDef {
  symbol: string;
  displayName: string;
  displayNameEn?: string;
  group: AssetGroup;
}

export type SignalType =
  | "golden-cross"
  | "death-cross"
  | "macd-bull-cross"
  | "macd-bear-cross"
  | "rsi-overbought"
  | "rsi-oversold"
  | "near-52w-high"
  | "near-52w-low"
  | "above-sma50-sma200"
  | "below-sma50-sma200";

export interface Signal {
  type: SignalType;
  /** 中文可读标签。 */
  label: string;
  /** 交叉类信号的发生天数。 */
  daysAgo?: number;
}

export interface TickerAnalysis {
  symbol: string;
  displayName: string;
  group: string;
  currency: string;
  exchangeName: string;
  currentPrice: number;
  pct1Day: number;
  pct5Day: number;
  /** 距 52 周高（负数=低于高点，如 -2.3 表示低 2.3%）。 */
  pct52WeekHigh: number;
  /** 距 52 周低（正数=高于低点）。 */
  pct52WeekLow: number;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  trend: "bullish" | "bearish" | "neutral";
  rsiState: "overbought" | "oversold" | "normal";
  signals: Signal[];
}

/** LLM 交易解读中的单标的观点（原 gzinfo ai/trading-commentary 内定义；契约化供渲染层共用）。 */
export interface WatchlistPick {
  symbol: string;
  display_name: string;
  /**
   * 当前技术面方向的标签（非价格预测）。中性技术词汇（偏上行/偏下行/中性）用于
   * 规避「不得提供投资建议」护栏误触发；旧值保留向后兼容。
   */
  stance:
    | "偏上行"
    | "偏下行"
    | "中性"
    | "看多"
    | "看空"
    | "Bullish"
    | "Bearish"
    | "Neutral";
  rationale: string;
}

