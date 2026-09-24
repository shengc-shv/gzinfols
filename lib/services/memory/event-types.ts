import { IPO_VOICE_WINDOW_DAYS } from "../../ipo-config";

/**
 * 事件记忆 —— 类型与参数表（**零逻辑**，2026-09-14 C-1 Phase4 自 `event-memory.ts` 纯搬移）。
 *
 * 拆分地图：types（本文件）→ text（事实/标签抽取与相似度）→ decide（匹配/新颖度/裁决）
 * → settle（结算与记账）/ brief（摘要）。依赖方向单向：types ← text ← decide ← settle/brief。
 */
export type MemorySection = "hero" | "must_read" | "insights" | "risk";

/**
 * 切入角度（去重后重播时必须轮换，避免表述雷同）。
 * 顺序即默认轮换顺序：从「政策本身」逐步推进到「客户该做什么」。
 */
export type EventAngle =
  | "政策变化"
  | "市场反应"
  | "受影响人群"
  | "数据验证"
  | "同业动作"
  | "客户行动";

/** 角度轮换顺序表（务必与 EventAngle 一致）。 */
export const ANGLE_ORDER: EventAngle[] = [
  "政策变化",
  "市场反应",
  "受影响人群",
  "数据验证",
  "同业动作",
  "客户行动",
];

/** 每个角度的写作指引（注入 LLM 提示词，让重播有明确的新视角）。 */
export const ANGLE_GUIDE: Record<EventAngle, string> = {
  政策变化: "只讲政策/规则本身变了什么、何时生效、适用范围，不评价影响",
  市场反应: "讲市场与机构的第一反应（股价、利率、报价、同业表态），少复述政策条文",
  受影响人群: "讲哪一类客户/客群被直接影响，他们的处境与需求发生了什么变化",
  数据验证: "用最新数据验证进展（规模、增速、占比、环比），用数字说话",
  同业动作: "讲同业/他行已经怎么做了（产品、定价、流程），突出竞争位次",
  客户行动: "讲分行与该客群当下可执行的动作（联系谁、推什么、什么时点）",
};

/** 事件类型 → 决定基础冷却期（重大政策类冷却更长）。 */
export type EventKind = "policy" | "enforcement" | "ipo" | "market" | "local" | "generic";

/** 判定结论。 */
export type MemoryVerdict =
  /** 记忆库中没有该事件 → 直接放行。 */
  | "new"
  /** 有实质新进展 → 放行（可不换角度）。 */
  | "progress"
  /** 增量有限、可重播，但**必须换角度**（板块拥挤时优先被降级）。 */
  | "refresh"
  /** 处于冷却期且增量不足以打破冷却 → 过滤。 */
  | "cooldown"
  /** 纯重复表述（无信息增量）→ 过滤。 */
  | "duplicate"
  /** 播报次数已达该板块上限且无重大进展 → 过滤。 */
  | "exhausted";

/** 单次判定结果（可解释：每条都带 reason，便于日志与回归测试）。 */
export interface MemoryDecision {
  section: MemorySection;
  /** 候选标题（日志/测试用）。 */
  title: string;
  verdict: MemoryVerdict;
  /** 是否放行（new/progress/refresh = 放行）。 */
  allow: boolean;
  /** 0-1 信息增量。 */
  novelty: number;
  /** 距上次播报天数；新事件为 undefined。 */
  daysSince?: number;
  /** 冷却期（天）；新事件为 undefined。 */
  cooldownDays?: number;
  /** 本次判定使用的增量门槛。 */
  threshold?: number;
  /** 匹配到的历史事件 id；新事件为 undefined。 */
  eventId?: string;
  /** 命中事件的历史播报次数（含本次前的累计）。 */
  broadcastCount?: number;
  /** refresh/progress 重播时强制要求切换到的角度。 */
  requiredAngle?: EventAngle;
  /** 人类可读原因。 */
  reason: string;
  /** 是否因「重大事件打破冷却」而放行。 */
  brokeCooldown?: boolean;
}

/** 单条播报留痕（同一事件保留最近若干条，用于增量计算与审计）。 */
export interface BroadcastSample {
  /** YYYY-MM-DD */
  date: string;
  section: MemorySection;
  title: string;
  url?: string;
  novelty?: number;
  angle?: EventAngle;
  /** 播报内容全文（标题 + 正文），用于**同日内**的信息增量计算。 */
  text?: string;
  /** 播报内容的事实锚点，用于**同日内**的信息增量计算。 */
  facts?: string[];
  /** 分行相关性分（0-100），透传给长期记忆以计算峰值分 peakScore（重大事件长期保留）。 */
  score?: number;
  /**
   * 播报时刻（ISO 8601 完整时间戳，带时区偏移，默认北京时间 +08:00）。
   *
   * 形如 `2026-09-02T23:39:47+08:00`。与 `date`（仅 YYYY-MM-DD）互补：
   * date 用于「哪天播的」的冷却计算，broadcastAt 记录「当天几点播的」。
   *
   * 2026-09-03 起仅作**溯源与人工分区**用途（partitionByHour / filterByTimeRange /
   * listBroadcasts 等工具仍可用 9:00 为界人工区分演示与测试数据）；
   * 「是否正式」的判定已交给 deliveries 交付信号（beginDay 结算闸门），
   * 不再用时刻启发式 —— 9 点前可能是测试重试、9 点后可能是人工补发，时刻无法证伪。
   *
   * 设为可选：历史记录无此字段时不影响任何既有读取逻辑（向后兼容）。
   */
  broadcastAt?: string;
}

/** 事件记忆条目。 */
export interface EventRecord {
  /** 稳定事件 id（首次创建时由锚点生成，后续不因措辞变化而改变）。 */
  id: string;
  /** 主题标签（如「住房金融」「利率流动性」），多值。 */
  topicTags: string[];
  /** 事件指纹锚点集合（关键词 + #数字锚点）。 */
  anchors: string[];
  /** 事件类型 → 冷却期。 */
  kind: EventKind;
  /** 首次播报日期 YYYY-MM-DD。 */
  firstBroadcastAt: string;
  /** 最近播报日期 YYYY-MM-DD。 */
  lastBroadcastAt: string;
  /** 累计播报次数。 */
  broadcastCount: number;
  /** 曾在哪些板块播报过。 */
  sections: MemorySection[];
  /** 已用过的切入角度（按顺序）。 */
  anglesUsed: EventAngle[];
  /** 最近播报留痕（上限 MAX_SAMPLES，FIFO）。 */
  samples: BroadcastSample[];
  /** 已播报过的内容原文（标题+摘要）集合，用于计算 bigram 增量。 */
  broadcastedTexts: string[];
  /** 已播报过的事实锚点（数字/机构/进展动词），用于计算事实增量。 */
  broadcastedFacts: string[];
  /** 历史最高分行相关性分（用于「重大事件打破冷却」）。 */
  peakScore: number;
}

/** 记忆库落盘结构。 */
export interface EventMemoryStore {
  version: 1;
  updatedAt?: string;
  /**
   * 长期记忆：**只含「昨天及更早」**的播报（今天的播报存在 today 里）。
   */
  events: Record<string, EventRecord>;
  /**
   * 当天播报暂存区（每次运行开始即清空重写）。
   *
   * 为什么要有这一层（幂等性关键）：
   * CI 一天会跑很多次（daily.yml 在北京 6-8 点每 15 分钟触发一次）。
   * 若第一次运行就把当天播报写进长期记忆，第二次运行时这些条目
   * daysSince=0，会被判定为「当日已播」而大面积过滤 → 同一天两次
   * 运行产出不一致，报告内容漂移。
   *
   * 因此当天播报只暂存在这里，**跨天时才结算进 events**（见 beginDay）。
   * 这样同一天无论跑多少次，判定输入都完全相同 → 结果稳定可复现。
   */
  today?: {
    date: string;
    entries: BroadcastSample[];
    /**
     * 该暂存区由哪个「上线 run」落盘（GITHUB_RUN_ID，persistMemory 注入）。
     * 用于结算指纹校验：与 deliveries.reportRunId 对账，证明「将结算的内容
     * 就是人工推送时 gh-pages 上的那个版本」（2026-09-03 补严，见
     * deliverySettlementGate）。可选：历史文件无此字段 → 无指纹、按信任交付结算。
     */
    runId?: string;
  };
  /**
   * 人工确认交付记录（2026-09-03 新增）：微信推送改为手动触发后，
   * 一次「人工触发推送且微信全量送达（API 全 target errcode=0）」= 当天报告
   * 正式生效。⚠️ 生效判据 = **触达**（微信侧受理并投递）——模板消息渠道无
   * 「客户已读」回执（仅企业微信应用消息有），已读不可观测，经用户 2026-09-03
   * 拍板以「触达即生效」为判据（宁严勿松：无目标 / 部分失败 → 不算交付）。
   *
   * beginDay 的结算闸门（取代 9:00 启发式）：昨天**有交付记录**才把
   * 昨天的播报结算进长期记忆（进入后续去重范围）；无交付记录（当天从未被
   * 人工推送，或全部是测试/验证运行）→ 不结算（宁漏勿误，次日同源新闻
   * 允许重播，测试内容绝不污染去重）。测试集触发与正式推送的判定边界 =
   * 是否真正 Run notify.yml 且推送全成功 —— 时刻 / run 次数 / 是否 publish
   * 到 gh-pages 均不作数。
   *
   * 写入方：notify.yml 推送成功后的 mark-delivered 步骤（appendDelivery）。
   * 可选字段：旧版本文件无此字段 → 按「无任何交付」处理（向下兼容）。
   */
  deliveries?: DeliveryRecord[];

  /**
   * IPO 口播去重命名空间（2026-09-09 新增，与 events 隔离）。
   *
   * 背景：IPO 板块是「参考/结构板块」，展示窗口独立于商机洞察（展示仍按
   * 7 天滚动窗口，见 buildGdIpo），但口播不应把同一家在审企业每天重复念——
   * 东财在审表条目会在表中停留数周，导致同一企业被日更口播。
   * 用户要求「同一企业口播 2 天就够了」。
   *
   * 设计：复用同一份 event-memory.json（共享持久化 + 交付闸门语义），但用
   * 独立的命名空间，避免与 insights/must_read/risk 的事件指纹去重逻辑纠缠。
   *  - 键：企业名（buildGdIpoSpoken 的 companyNameOf 归一化结果）
   *  - 值：该企业被口播过的日期数组（YYYY-MM-DD），只保留最近 IPO_VOICE_PRUNE_DAYS 天
   *  - 判定：滚动窗口内（最近 IPO_VOICE_WINDOW_DAYS 天，含今天）已口播 ≥
   *    IPO_VOICE_MAX_IN_WINDOW 天 → 今天跳过（自然形成「约 2 天播、1 天歇」
   *    的节奏，杜绝数周连播；展示卡面不受影响）。
   *  - 写回受 PUBLISH_RUN 闸门约束（与 events 的 persistMemory 同口径），
   *    测试/本地运行不污染正式口播记忆。
   */
  ipoVoicing?: Record<string, string[]>;
}

/** IPO 口播去重窗口（天）：统计「最近多少天内的口播天数」（值来源 lib/ipo-config.ts）。 */
export { IPO_VOICE_WINDOW_DAYS };
/** 窗口内口播天数上限：达到即今天跳过（默认 2 → 约「2 天播、1 天歇」）。 */
export const IPO_VOICE_MAX_IN_WINDOW = 2;
/** ipoVoicing 日期数组保留天数（超出丢弃，防无限膨胀）。 */
export const IPO_VOICE_PRUNE_DAYS = 7;

/**
 * 一次人工确认交付的留痕（date + 推送成功时刻 + 被推送版本指纹）。
 * 除 notify run 自身（runId）外，还记录**被推送版本**的 gh-pages 发布 run 与
 * commit（reportRunId / reportSha，mark-delivered 从 gh-pages commit message 反查），
 * 供次日结算前与 today.runId 对账 —— 防止「推的是 A 版本、结算的是 B 版本」。
 */
export interface DeliveryRecord {
  /** 被交付的报告日期 YYYY-MM-DD。 */
  date: string;
  /** 推送成功时刻（ISO 8601 带时区，与 broadcastAt 同格式）。 */
  pushedAt: string;
  /** 触发推送的 notify run id（溯源用，可选）。 */
  runId?: string;
  /** 被推送版本对应的 gh-pages 发布 run id（daily publish 步骤的 commit message 反查，可选）。 */
  reportRunId?: string;
  /** 被推送版本对应的 gh-pages commit sha（审计用，可选）。 */
  reportSha?: string;
}

/** 候选条目（由调用方从 exec 产出或两天池构造）。 */
export interface MemoryCandidate {
  title: string;
  /** 用于增量计算的正文（标题 + why/impact/摘要）。 */
  text?: string;
  url?: string;
  /** 分行相关性分（0-100），可选；用于打破冷却的重要性判定。 */
  score?: number;
  /** 是否命中评分器硬规则（如房贷40年）→ 可打破冷却。 */
  override?: boolean;
  /** 评分档位，可选。 */
  tier?: "must_read" | "insight" | "context" | "drop";
}

// ---------------------------------------------------------------------------
// 2) 板块差异化参数（要求 5）
// ---------------------------------------------------------------------------

/**
 * 四板块的重复容忍度与去重优先级（互不相同，可参数化覆盖）。
 *
 * 设计取向：
 *  - hero（今日定调）：一天只有一句话，重复最刺眼 → 最严格。
 *    不允许「换角度重播」式刷新（allowRefresh=false），必须有实质进展。
 *  - must_read（今日必读）：宏观信号，允许多次，但需进展或新角度。
 *  - insights（商机洞察）：商机本就需要持续跟进，容忍度更高。
 *  - risk（风险提示）：风险不因「说过」而消失，只要有新证据就要继续预警
 *    → 容忍度最高，但仍要求 evidence 有新事实（newFacts > 0）。
 *
 * dedupePriority：数值越小越先被保护（兜底放宽时，高优先级板块的候选
 * 先被释放）。cooldownScale：在事件基础冷却期上缩放。
 */
export interface SectionPolicy {
  /** 冷却期缩放系数（× 事件基础冷却期）。 */
  cooldownScale: number;
  /** 冷却结束后的基础增量门槛。 */
  noveltyBase: number;
  /** 门槛下限（衰减到此为止，防止时间久了无脑放行）。 */
  noveltyFloor: number;
  /** 冷却期内打破冷却所需的高增量门槛。 */
  noveltyToBreak: number;
  /** 同一事件在同一板块的累计播报上限（超出需 noveltyToBreak 才放行）。 */
  maxRepeat: number;
  /** 去重优先级（越小越优先保留）。 */
  dedupePriority: number;
  /** 是否允许「换角度重播」（refresh 级放行）。 */
  allowRefresh: boolean;
  /** 兜底时该板块的最低保底条数。 */
  minKeep: number;
}

export const SECTION_POLICY: Record<MemorySection, SectionPolicy> = {
  hero: {
    cooldownScale: 1.5,
    noveltyBase: 0.45,
    noveltyFloor: 0.22,
    noveltyToBreak: 0.6,
    maxRepeat: 2,
    dedupePriority: 1,
    allowRefresh: false,
    minKeep: 1,
  },
  must_read: {
    cooldownScale: 1.0,
    noveltyBase: 0.3,
    noveltyFloor: 0.12,
    noveltyToBreak: 0.45,
    maxRepeat: 3,
    dedupePriority: 2,
    allowRefresh: true,
    minKeep: 2,
  },
  insights: {
    cooldownScale: 0.7,
    noveltyBase: 0.22,
    noveltyFloor: 0.08,
    noveltyToBreak: 0.35,
    maxRepeat: 4,
    dedupePriority: 3,
    allowRefresh: true,
    minKeep: 1,
  },
  risk: {
    cooldownScale: 0.5,
    noveltyBase: 0.15,
    noveltyFloor: 0.05,
    noveltyToBreak: 0.25,
    maxRepeat: 5,
    dedupePriority: 4,
    allowRefresh: true,
    minKeep: 1,
  },
};

/**
 * 今日必读「候选池 / 播出目标」条数（2026-09-18 新口径）。
 *
 * - `MUST_READ_CANDIDATE_POOL`：上游（enrich / pipeline）产出的**候选条数**；
 *   自第 `MUST_READ_PLAY_TARGET + 1` 条起即备用候补，供去重命中时顺延取用。
 * - `MUST_READ_PLAY_TARGET`：实际**播出条数**（顺序判重，选满即停）。
 *
 * ⚠️ 单一真源：消费方一律从这里导入，**禁止就地写死数字** —— 历史教训
 *    `IPO_VOICE_WINDOW_DAYS` 曾在两处重复定义，改一处不生效。
 */
export const MUST_READ_CANDIDATE_POOL = 10;
export const MUST_READ_PLAY_TARGET = 5;

/**
 * 商机洞察「候选池 / 播出目标」条数（2026-09-21 新口径，与必读同构）。
 *
 * - `INSIGHT_CANDIDATE_POOL`：LLM 产出的**候选条数**；自第 `INSIGHT_PLAY_TARGET + 1` 条起为备用候补。
 * - `INSIGHT_PLAY_TARGET`：判重后**播出条数**（顺序判重，选满即停；候补用尽则按实际剩余）。
 *
 * 背景：此前洞察无候选池，判重命中即永久减员 —— 周末连跑两天后周一「8 → 3 条」。
 * ⚠️ 单一真源：消费方一律从这里导入，**禁止就地写死数字**。
 */
export const INSIGHT_CANDIDATE_POOL = 12;
export const INSIGHT_PLAY_TARGET = 6;

/**
 * 补位池「当天已用事件」的标题相似度阈值（2026-09-24 用户要求）。
 *
 * 语义：池内候选的标题与「当天其他板块已用的某条」标题的 bigram Dice ≥ 该值，
 * 即视为同一事件的多家报道（URL 不同但事是同一件）→ 补位时跳过。
 *
 * 取值 0.7 与漏斗层 `dedup-similar` 的**同一主题判定阈值同口径**（不新造刻度）。
 * 偏保守是刻意的：宁可在极少数情况下漏掉一次避让，也不误杀一条独立候选 ——
 * 池内候选本就按分行关联度降序，误杀会把定调挤到更边缘的事件上。
 * 主判据仍是 **URL 规范化后精确相等**（无阈值风险），本阈值只覆盖「多家报道」。
 */
export const USED_EVENT_TITLE_DICE = 0.7;

/** 事件类型 → 基础冷却期（天）。重大政策类最长。 */
export const BASE_COOLDOWN_DAYS: Record<EventKind, number> = {
  policy: 6,
  enforcement: 7,
  ipo: 5,
  market: 3,
  local: 5,
  generic: 4,
};

/** 冷却期上限（天）：无论重复多少次，不超过此值。 */
export const MAX_COOLDOWN_DAYS = 14;
/** 播报留痕保留条数。 */
export const MAX_SAMPLES = 6;
/** 已播报文本保留条数（用于 bigram 增量计算）。 */
export const MAX_TEXTS = 8;

// ---------------------------------------------------------------------------
// 3) 文本特征抽取
// ---------------------------------------------------------------------------

/** 归一化：只保留字母/数字（中文保留），小写化。 */
