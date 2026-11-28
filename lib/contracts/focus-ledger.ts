/**
 * 经营重点台账契约（二期 WP7 · 规格 7.3）· 零逻辑。
 *
 * 为什么必须有这个名字听起来很土的东西：线上**不存每期报告 JSON**（`build-site` 只发
 * html/audio，`daily_reports/` 只在自托管工作区），所以「近 7~30 天某重点命中了哪些资讯、
 * 哪些进了必读/商机/风险」这类跨期聚合，只能靠一份**自己累积的台账**。
 *
 * 两份文件（都入库、随 daily 提交回 main，与 `research-ledger.json` 同模式）：
 *  - `data/focus-ledger.json`   —— 每日命中（跨期聚合的唯一数据源）；
 *  - `data/focus/versions.json` —— 配置版本归档（「当时那条重点是怎么定义的」）。
 *
 * 三条口径（写在这里，避免下游各自理解）：
 *  1. **台账记数据层，不记展示口径**：全部生效重点（年度/季度/临时）都记，页面自己决定
 *     展示哪些（首页只展示年度三条，专题页可以全看）；
 *  2. **`hits` 只存 M2/M3**（实质命中），M1 只进 `count` —— 弱相关留一行没有阅读价值，
 *     但「当日相关 N 条」这个量级对判断重点热度有用，两者分开存；
 *  3. **按日期覆盖写**（同一天重跑替换整天，不追加）：日报重跑是常态，
 *     追加会立刻产生「同一天两份命中」的假增长。
 */

/**
 * 层级名（与 `services/business-focus/types.ts` 的 `FocusLayer` **同值**）。
 *
 * 这里重新声明而不 import：契约层不得依赖服务层（架构门禁的依赖方向）。
 * 两边都是字符串字面量联合，结构上直接兼容，服务侧传 `FocusItem["layer"]` 即可。
 */
export type FocusLayerName = "annual" | "quarterly" | "temporary";

/** 台账里的一条命中（一行 = 一条资讯命中一个重点）。 */
export interface FocusLedgerHit {
  /** 重点 id（配置稳定标识）。 */
  focusId: string;
  /** 匹配等级：只存 M2（高度相关）/ M3（精准命中）。 */
  level: "M2" | "M3";
  /** 该条实际获得的重点加分（封顶/衰减后）。 */
  bonus: number;
  /** 命中理由（关键词/概念/领域，回原文可核对）。 */
  reason: string;
  /** 条目 id（由 url 派生，跨期稳定；无 url 时为空串，**不得**用 `itm-0`）。 */
  itemId: string;
  url: string;
  title: string;
  source: string;
  /** 资讯自身日期（`11/28` 这类原始展示值，与首页一致）。 */
  itemDate: string;
  /** 落在哪个板块（gz_local / policy_market / ...，用于专题页按板块筛选）。 */
  section: string;
  /** 是否进了今日必读。 */
  inMustRead?: boolean;
  /** 是否进了商机。 */
  inInsights?: boolean;
  /** 是否被选为风险条目。 */
  isRisk?: boolean;
}

/** 某重点在当日的汇总（含 M1，用于「相关 N 条 / 实质 M 条」）。 */
export interface FocusLedgerFocusCount {
  id: string;
  name: string;
  layer: FocusLayerName;
  grade: string;
  /** 当日相关情报总数（M1+M2+M3）。 */
  count: number;
  /** 其中有实质关联的条数（M2/M3）。 */
  high: number;
  domains: string[];
}

/** 一天的台账。 */
export interface FocusLedgerDay {
  /** 期次日（YYYY-MM-DD，北京时区）。 */
  date: string;
  /** 当日使用的配置版本（`f-xxxxxxxx`），与 `versions.json` 对应。 */
  version: string;
  /** 当日生效重点的命中计数（按配置顺序）。 */
  focuses: FocusLedgerFocusCount[];
  /** 当日实质命中明细（M2/M3）。 */
  hits: FocusLedgerHit[];
}

export interface FocusLedger {
  version: 1;
  /** 最后一次写入的期次日（不是写盘时钟）。 */
  updatedAt: string;
  /** 按日期降序。 */
  days: FocusLedgerDay[];
}

/**
 * 版本归档里的一条重点定义（**只存定义，不存权重派生值**）。
 *
 * 存在的理由：配置会改（换词、改窗口、删重点），而历史页面/会话里出现的「本季主攻：
 * 中高端客户 AUM 提升」必须能查到当时这四个字是哪份配置、挂了哪些词。若只存版本号，
 * 改一次配置就无法复现当时口径 —— 这正是规格 7.3「历史页面天然保真」的落点。
 */
export interface FocusVersionDefinition {
  id: string;
  name: string;
  description: string;
  layer: FocusLayerName;
  grade: string;
  status: string;
  start_date: string;
  end_date: string;
  domains: string[];
  core_keywords: string[];
  keywords: string[];
  concepts: string[];
  exclude_keywords: string[];
  source: string;
}

/** 一个配置版本。 */
export interface FocusVersionEntry {
  /** 内容指纹 `f-xxxxxxxx`。 */
  version: string;
  /** 首次被某期日报使用（YYYY-MM-DD）。 */
  firstSeen: string;
  /** 最近一次被使用（YYYY-MM-DD）；与 firstSeen 相同表示只用过一天。 */
  lastSeen: string;
  /** 该版本下**全部**有效配置项（含 inactive，配置体检要看「配了没用」）。 */
  focuses: FocusVersionDefinition[];
}

export interface FocusVersionArchive {
  version: 1;
  updatedAt: string;
  /** 按首次出现顺序（旧 → 新）。 */
  versions: FocusVersionEntry[];
}
