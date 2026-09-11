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
