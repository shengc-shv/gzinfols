/**
 * 报告领域模型（契约层 · 零逻辑）。
 *
 * 报告以 sections 驱动渲染；AI 只负责创作，代码负责校验与落位。
 * 5 个板块对应 5 个 tab（红线 #2：最终归属由内容判定，不由 sourceId/category 决定）。
 */

/** 地域标记（gzinfo types.ts Locale 同名）：gz=广州辖区 / national=全国 / overseas=海外。 */
import type { IndexQuote, TickerAnalysis, WatchlistPick } from "./market";
import type { RedchipBadge, RedchipPanel } from "./redchip";
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
  /**
   * 稳定条目 ID（A2 地基，**跨期可比、可寻址**）。
   * 由 url 确定性派生（`utils/item-id.ts::itemIdOf`），同一 url 在任何一期得到同一值。
   * 二期依赖它的能力：B1 检索落点 / A3 增量三态 / B2 主题时间线 / C1 客群视图 / E2 导出。
   * 老报告（无此字段）在渲染前由 `assemble/item-id.assignItemIds` 补齐，幂等。
   */
  id?: string;
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
  /**
   * 红筹线索徽章（2026-09-15 · plan-redchip-crawl-push §2.2）。
   *
   * ⚠️ 无状态源红线：**只由实体匹配产出**（港交所申请编号 / 归一化企业名 / 股票代码），
   * 绝不因为「条目来自红筹数据源」而打标；匹配失败则不打标（T7）。
   */
  redchip?: RedchipBadge;
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
  /** A3 增量三态标注。 */
  delta?: DeltaMark;
  /** C2 商机成熟度（阶段 + 依据词 + 按阶段给出的下一步动作）。 */
  maturity?: MaturityMark;
}

/**
 * 增量三态（A3，2026-09-17）：这条内容相对**昨日及更早**是新增、续报还是有了新进展。
 *
 * 由 `services/assemble/delta.ts` 复用**事件记忆判重链**（`findMatchingEvent` +
 * `computeNovelty`）算出并写进契约；渲染层只读不判定（保持渲染零业务判定）。
 */
export type DeltaState = "new" | "followup" | "changed";

export interface DeltaMark {
  state: DeltaState;
  /** 续报时为「第几期」（= 历史播报次数 + 1）；新增时不填。 */
  issueNo?: number;
  /** 变更时列出的新进展锚点（≤2 个，让读者一眼看出「新在哪」）。 */
  highlights?: string[];
}

/**
 * 商机成熟度（C2，2026-09-17）—— 公开信息的**演进阶段**，不是行内跟进状态。
 *
 * 三档：`clue` 线索（仅规划/意向）→ `progress` 推进（已进入程序：招标/获批/签约/开工）
 * → `landed` 落地（已完成：开业/投产/上线/竣工/交付）。
 *
 * ⚠️ 「落地」只表示**公开信息显示动作已完成**，不代表本行已介入 ——
 * 行内跟进状态属另外的合规议题，本项目不采集、不呈现。
 */
export type MaturityStage = "clue" | "progress" | "landed";

export interface MaturityMark {
  stage: MaturityStage;
  /** 判定依据词（命中的原词，供读者回原文核对；无把握时缺省）。 */
  evidence?: string;
  /**
   * 下一步动作（确定性「阶段 × 客群」动作库给出，零 LLM、可测、可追溯）。
   *
   * 与 LLM 写的 `action` **并列而非替代**：`action` 是业务建议（面向机会本身），
   * 本字段是按阶段推进的**即时可执行动作**（面向「现在该做什么」）。
   */
  nextStep?: string;
}

export interface ReportMustRead {
  url: string;
  why: string;
  title?: string;
  /** A3 增量三态标注（渲染为卡片上的小徽章）。 */
  delta?: DeltaMark;
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
    reportDate: string;
    /**
     * 各市场「隔夜新鲜度」（2026-09-20 重构）：`fresh=true` = 该市场有隔夜行情
     * （数据自带日期距报告日 ≤ 1 天）→ 口播才播；否则口播不播、页面仅展示日期。
     * 「部分开市」由各市场独立判定自然得出，不需特判。
     */
    markets: {
      aShare: { fresh: boolean; dataDate?: string; reason?: string };
      hk: { fresh: boolean; dataDate?: string; reason?: string };
      us: { fresh: boolean; dataDate?: string; reason?: string };
    };
    /** 三市场均无隔夜行情。 */
    allStale: boolean;
    /** 页面展示文案（仅在有市场非新鲜时有值：橙字警示）。 */
    note?: string;
    /** 口播文案（含各市场数据日期；供 voice 决定播/不播）。 */
    spokenNote?: string;
    /** @deprecated 旧字段（按星期几判休市时代）；保留以兼容旧 store.json 渲染。 */
    isMarketClosed?: boolean;
    /** @deprecated 旧字段；保留以兼容旧 store.json 渲染。 */
    dataDate?: string;
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
  /** A3 增量三态标注。 */
  delta?: DeltaMark;
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
  /** 今日定调的增量三态（A3；hero 是字符串字段，故单列）。 */
  heroDelta?: DeltaMark;
  must_read: ReportMustRead[];
  insights: ReportInsight[];
  sections: ReportSections;
  trading?: TradingSection;
  stock_recap?: StockRecap;
  stock_news?: StockNewsItem[];
  risk?: RiskItem;
  /** 红筹线索面板（plan-redchip-crawl-push §5.1；渲染期派生，不入库）。 */
  redchipPanel?: RedchipPanel;
  /**
   * 产品条线覆盖（C4，2026-09-17）：按揭 / 信用卡 / 代发 三条线的命中情况。
   * 由 `assemble/product-coverage.ts` 纯函数统计（零 LLM）；`count = 0` 即「本期无」，
   * 页面显式标注而不是留白 —— 让读者知道是「真没有」而非「系统漏了」。
   */
  productCoverage?: ProductLineCoverage[];
  /**
   * 每源存活统计（2026-09-16 A5：数据戳颗粒度与覆盖度透明）。
   *
   * 由 select 的漏斗一次算出（进入 → 保留 + 均分），随报告落盘，供页面「数据戳」
   * 展开显示「各源抓取/收录条数」，让读者能判断内容覆盖是否完整、哪个源本期偏弱。
   */
  sourceStats?: SourceStat[];
}

/**
 * 产品条线覆盖（C4）。
 * 与客群段位（零售AUM / 中高端 / 普惠小微）**正交**：段位答「服务谁」，产品线答「卖什么」。
 */
export interface ProductLineCoverage {
  line: "按揭" | "信用卡" | "代发";
  /** 命中条数（0 = 本期无，页面须显式标注） */
  count: number;
  /** 命中的前 2 条标题（读者可快速核对覆盖到了什么） */
  examples: string[];
}

/** 单源存活统计（A5）。 */
export interface SourceStat {
  sourceId: string;
  /** 进入漏斗时的条数。 */
  inflow: number;
  /** 漏斗结束后保留的条数（渲染可见口径）。 */
  kept: number;
  /** 保留条目的平均分行相关性分（保留数为 0 时为 null）。 */
  avgScore: number | null;
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
