/**
 * 事件记忆 —— 匹配 / 新颖度 / 冷却与衰减 / 角度轮换 / 候选裁决
 * （纯函数，2026-09-14 C-1 Phase4 纯搬移）。
 */
import { dice, eventFingerprint, titleBigrams } from "../select/filters/dedup-similar";
import { IPO_VOICE_WINDOW_DAYS } from "../../ipo-config";
import {
  ANGLE_ORDER,
  BASE_COOLDOWN_DAYS,
  MAX_COOLDOWN_DAYS,
  SECTION_POLICY,
} from "./event-types";
import type {
  BroadcastSample,
  MemoryDecision,
  EventAngle,
  EventKind,
  EventMemoryStore,
  EventRecord,
  MemoryCandidate,
  MemorySection,
  MemoryVerdict,
} from "./event-types";
import {
  anchorJaccard,
  bestTitleDice,
  candidateAnchors,
  candidateText,
  classifyKind,
  extractFacts,
  extractTopicTags,
  isUsableRecord,
  normText,
  sharedTags,
} from "./event-text";
const MATCH_THRESHOLD = 0.5;
/**
 * 硬信号软命中置信线：锚点/标题相似度落在区间 [HARD_CORROB, MATCH_THRESHOLD)
 * 且共享 ≥2 个主题标签时，才升格为合并（兜底「同一主题不同切入」的软重复）。
 */
const HARD_CORROB = 0.3;
/**
 * 标签软命中辅助值：仅共享 ≥2 个主题标签、无硬信号支撑时给出的相似度，
 * 低于合并阈 → 不单独触发合并，避免把不同事件（如「存量房贷利率下调」vs
 * 「公积金贷款额度上调」）按宽泛标签串味误并。
 */
const TAG_SOFT_BOOST = 0.35;
/** 历史无事实锚点时，newFactRatio 封顶值（防 novelty 虚高误判 progress）。 */
const NO_FACT_BASELINE_CAP = 0.5;

/**
 * 把「当天暂存区」的播报聚类成伪事件记录，供判定期统一匹配。
 *
 * 用途：同一次运行内的板块内去重（如 LLM 把同一事件拆成两条必读）——
 * 第二条必须能匹配到第一条，否则会出现「同一天、同一板块、同一事件两条」。
 */
function todayPseudoRecords(store: EventMemoryStore): Array<{ id: string; record: EventRecord }> {
  const entries = store.today?.entries ?? [];
  if (entries.length === 0) return [];
  const clusters: BroadcastSample[][] = [];
  const reps: string[][] = []; // 每簇代表条目的锚点集合
  for (const e of entries) {
    const text = e.text || e.title;
    const anchors = [...eventFingerprint(text)];
    let placed = false;
    for (let i = 0; i < clusters.length; i++) {
      const aj = anchorJaccard(anchors, reps[i]);
      const td = dice(titleBigrams(e.title), titleBigrams(clusters[i][0].title));
      if (aj >= MATCH_THRESHOLD || td >= MATCH_THRESHOLD) {
        clusters[i].push(e);
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.push([e]);
      reps.push(anchors);
    }
  }
  return clusters.map((c, i) => {
    const texts = c.map((s) => s.text || s.title);
    const facts = [...new Set(c.flatMap((s) => s.facts ?? []))];
    const angles = [...new Set(c.map((s) => s.angle).filter(Boolean) as EventAngle[])];
    const first = c[0];
    const rec: EventRecord = {
      id: `today#${i}`,
      topicTags: [...new Set(c.flatMap((s) => extractTopicTags(s.text || s.title)))],
      anchors: [...new Set(c.flatMap((s) => [...eventFingerprint(s.text || s.title)]))],
      kind: classifyKind(texts.join(" ")),
      firstBroadcastAt: first.date,
      lastBroadcastAt: first.date,
      broadcastCount: 1,
      sections: [...new Set(c.map((s) => s.section))],
      anglesUsed: angles,
      samples: c,
      broadcastedTexts: texts,
      broadcastedFacts: facts,
      peakScore: 0,
    };
    return { id: rec.id, record: rec };
  });
}

/**
 * 在记忆库中查找与候选匹配的事件。
 *
 * 查找顺序：**当天暂存区优先 → 长期记忆**。
 * 当天优先是为了让「同一次运行内已播过」成为最强信号（板块内去重）。
 *
 * 匹配规则（硬信号优先，标签仅作辅助）：
 *  1. 锚点 Jaccard —— 抓「同事件不同措辞」（如「住房贷款…40年」vs「房贷…40年」）
 *  2. 标题 Dice    —— 抓「媒体改写通稿」这类措辞近似的重复
 *  3. 主题标签共享 ≥2 —— 弱辅助信号：仅当硬信号已具一定置信（≥ HARD_CORROB）时
 *     才抬到合并阈（兜底「同一主题不同切入」）；单独出现不触发合并，防误并。
 */
export function findMatchingEvent(
  cand: MemoryCandidate,
  store: EventMemoryStore,
): { id: string; record: EventRecord; similarity: number; source: "today" | "events" } | null {
  const anchors = candidateAnchors(cand);
  const tags = extractTopicTags(candidateText(cand));
  const url = cand.url;
  const score = (
    rec: EventRecord,
  ): number => {
    const samples = Array.isArray(rec.samples) ? rec.samples : [];
    if (url && samples.some((s) => s && s.url && s.url === url)) return 1;
    const aj = anchorJaccard(anchors, Array.isArray(rec.anchors) ? rec.anchors : []);
    const td = bestTitleDice(cand.title, rec);
    const st = sharedTags(tags, rec.topicTags);
    const hard = Math.max(aj, td);
    // 合并判定：
    //  - 硬信号达合并阈 → 直接合并；
    //  - 硬信号达 HARD_CORROB 且共享 ≥2 主题标签 → 软命中合并（同一主题不同切入兜底）；
    //  - 否则标签共享只给弱辅助值（TAG_SOFT_BOOST），不触发合并，防不同事件误并。
    if (hard >= MATCH_THRESHOLD) return hard;
    if (hard >= HARD_CORROB && st >= 2) return MATCH_THRESHOLD;
    return Math.max(hard, st >= 2 ? TAG_SOFT_BOOST : 0);
  };

  // 1) 当天暂存区（同一次运行内已播报）
  let bestToday: { id: string; record: EventRecord; similarity: number } | null = null;
  for (const p of todayPseudoRecords(store)) {
    const sim = score(p.record);
    if (sim >= MATCH_THRESHOLD && (!bestToday || sim > bestToday.similarity)) {
      bestToday = { id: p.id, record: p.record, similarity: sim };
    }
  }
  if (bestToday) return { ...bestToday, source: "today" };

  // 2) 长期记忆（昨天及更早）
  let best: { id: string; record: EventRecord; similarity: number } | null = null;
  for (const [id, rec] of Object.entries(store.events ?? {})) {
    // 损坏记录跳过（不使整体匹配失效）；落盘时会被 sanitizeEvents 清除 → 自愈
    if (!isUsableRecord(rec)) continue;
    const sim = score(rec);
    if (sim >= MATCH_THRESHOLD && (!best || sim > best.similarity)) {
      best = { id, record: rec, similarity: sim };
    }
  }
  return best ? { ...best, source: "events" } : null;
}

// ---------------------------------------------------------------------------
// 5) 信息增量的量化标准（要求 2）
// ---------------------------------------------------------------------------

export interface NoveltyResult {
  /** 0-1 综合信息增量。 */
  novelty: number;
  /** 新增事实锚点（相对历史已播报内容）。 */
  newFacts: string[];
  /** 新增 bigram 占比（0-1）：历史内容中未出现的二元组比例。 */
  newBigramRatio: number;
  /** 是否发生「阶段推进」（如 受理 → 过会、传闻 → 正式印发）。 */
  stageAdvance: boolean;
  /**
   * 是否出现「新时点」（候选带记录里没有的月份/年度/季度事实）。
   *
   * 语义：**对周期性事件（议息、LPR 报价、月度数据），新的一期就是实质进展**，
   * 哪怕措辞与上一期高度雷同。典型：记录是「9月加息落地」，候选是「10月加息概率七成」——
   * 两者同为「美联储/利率」，但**月份是事件标识本身**，不是可忽略的数量差异
   * （用户 2026-09-24 明确指出的核心差异）。
   */
  newPeriod: boolean;
  /** 与历史内容的标题重复度（0-1，越高越雷同）。 */
  titleOverlap: number;
}

/**
 * 时点类事实（**带 `#` 前缀的月份/年度/季度**）。
 *
 * 为什么要单独识别：`extractFacts` 的 `NUM_RE` 把「10月」和「25基点」「7.2%」一并抽成
 * `#数字锚点` —— 但二者语义不同：
 *   - `#25基点` 是**量级**（同一件事的强弱变化）；
 *   - `#10月`  是**时点**（事件落到哪一期）→ 对周期性事件是新旧事件的判别键。
 * 词法上刻意区分：`#10个月`（时长，非时点）不匹配本式（`年` 也要求 4 位年份）。
 */
const PERIOD_FACT_RE = /^#(?:\d{4}年|\d{1,2}月(?:\d{1,2}日)?|\d{1,2}季度|Q[1-4])$/;

/** 取事实集合里的时点子集。 */
function periodsOf(facts: readonly string[]): Set<string> {
  return new Set(facts.filter((f) => PERIOD_FACT_RE.test(f)));
}

/** 「新时点」的增量权重（与 stageAdvance 同量级：都是「事件往前走了一期/一步」）。 */
const PERIOD_ADVANCE_WEIGHT = 0.2;

/**
 * 量化信息增量。
 *
 * 综合四项（加权）：
 *  - 新事实占比（权重 0.45）：数字/阶段/主体的新增 —— 最能代表「有进展」
 *  - 新 bigram 占比（权重 0.35）：表述层面的新增内容量
 *  - 阶段推进（权重 0.20）：事件生命周期往前走了一步
 *  - **新时点（权重 0.20）**：本轮是周期性事件的**新一期**（见 `newPeriod`）
 * 最后按标题重复度做惩罚（措辞越雷同，增量越被压低）。
 *
 * ⚠️ 新时点与「新事实占比」存在**刻意的重叠计权**：新月份既计入新事实（0.45 项），
 * 又额外拿时点权重 —— 这是有意为之。用户口径（2026-09-24）：「9月加息」与「10月加息」
 * 里**月份是最核心的差异之一**，若只按「众多数字里的一个」分摊权重，会被稀释到门槛之下
 * （实测 09-24 定调：0.383 vs 门槛 0.43，仅差 0.047 被误拦）。
 *
 * 阈值语义（在 evaluateCandidate 中消费）：
 *  - ≥ 0.35 视为「有实质进展」
 *  - 0.15 ~ 0.35 视为「增量有限」（可重播但需换角度）
 *  - < 0.15 视为「重复表述」
 */
export function computeNovelty(cand: MemoryCandidate, record: EventRecord): NoveltyResult {
  const text = candidateText(cand);
  const facts = extractFacts(text);
  const histFacts = new Set(record.broadcastedFacts ?? []);
  const newFacts = facts.filter((f) => !histFacts.has(f));
  // 历史无事实锚点时：无基线可比对，「全部为新」不可置信——封顶到 NO_FACT_BASELINE_CAP
  // （默认 0.5），避免首播纯政策表述（抽不出事实）后，后续带事实报道的 novelty 被事实项拉满、
  // 误判 progress 放行。有基线时按真实新增占比计算（分母取 max(候选事实数, 历史事实数)）。
  const newFactRatio =
    facts.length === 0
      ? 0
      : Math.min(
          newFacts.length / Math.max(facts.length, histFacts.size, 1),
          histFacts.size === 0 ? NO_FACT_BASELINE_CAP : 1,
        );

  // bigram 增量
  const g = titleBigrams(normText(text));
  const histGrams = new Set<string>();
  for (const t of record.broadcastedTexts ?? []) {
    for (const x of titleBigrams(normText(t))) histGrams.add(x);
  }
  let novel = 0;
  for (const x of g) if (!histGrams.has(x)) novel++;
  const newBigramRatio = g.size === 0 ? 0 : novel / g.size;

  // 阶段推进：候选含进展动词，且该动词未在历史事实中出现
  const histStages = new Set([...(record.broadcastedFacts ?? [])].filter((f) => f.startsWith("!")));
  const candStages = facts.filter((f) => f.startsWith("!"));
  const stageAdvance = candStages.some((s) => !histStages.has(s));

  // 新时点：候选带记录里没有的月份/年度/季度事实 → 周期性事件的新一期
  const histPeriods = periodsOf(record.broadcastedFacts ?? []);
  const newPeriod = [...periodsOf(facts)].some((p) => !histPeriods.has(p));

  // 标题重复度惩罚
  const titleOverlap = bestTitleDice(cand.title, record);

  const raw =
    0.45 * clamp01(newFactRatio) +
    0.35 * clamp01(newBigramRatio) +
    (stageAdvance ? 0.2 : 0) +
    (newPeriod ? PERIOD_ADVANCE_WEIGHT : 0);
  // 措辞高度雷同（Dice ≥ 0.6）时按超出部分线性压低，最低压到 55%
  const penalty = titleOverlap > 0.6 ? Math.min((titleOverlap - 0.6) / 0.4, 1) * 0.45 : 0;
  const novelty = clamp01(raw * (1 - penalty));

  return { novelty, newFacts, newBigramRatio, stageAdvance, newPeriod, titleOverlap };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// ---------------------------------------------------------------------------
// 6) 冷却期与衰减（要求 3）
// ---------------------------------------------------------------------------

/** YYYY-MM-DD 相差天数（b - a，纯字符串运算，规避时区）。 */
export function diffDays(a: string, b: string): number {
  const pa = a.split("-").map(Number);
  const pb = b.split("-").map(Number);
  const da = Date.UTC(pa[0], pa[1] - 1, pa[2]);
  const db = Date.UTC(pb[0], pb[1] - 1, pb[2]);
  return Math.round((db - da) / 86_400_000);
}

/**
 * 有效冷却期（天）。
 *
 * = 事件类型基础冷却期 × 板块缩放系数 × (1 + 0.5 × (播报次数 - 1))，上限 14 天。
 * 语义：同一件事说得越多，越要隔久一点才能再说（避免连日刷屏）。
 */
export function effectiveCooldownDays(
  record: EventRecord,
  section: MemorySection,
): number {
  const base = BASE_COOLDOWN_DAYS[record.kind] ?? BASE_COOLDOWN_DAYS.generic;
  const scale = SECTION_POLICY[section].cooldownScale;
  const repeat = Math.max(1, record.broadcastCount ?? 1);
  const grown = base * scale * (1 + 0.5 * (repeat - 1));
  return Math.min(Math.round(grown), MAX_COOLDOWN_DAYS);
}

/**
 * 衰减后的增量门槛。
 *
 * 冷却期内用 noveltyToBreak（高门槛，需足够进展才打破）；
 * 冷却结束后，门槛随「超出冷却期的天数」线性衰减，14 天后降到
 * noveltyBase 的 30%，但不低于板块下限 noveltyFloor
 * —— 即「时间越久，重播越容易被接受」，但绝不无脑放行。
 */
export function decayedThreshold(
  section: MemorySection,
  daysSince: number,
  cooldownDays: number,
): number {
  const p = SECTION_POLICY[section];
  if (daysSince < cooldownDays) return p.noveltyToBreak;
  const overdue = daysSince - cooldownDays;
  const relief = clamp01(overdue / 14);
  const relaxed = p.noveltyBase * (1 - 0.7 * relief);
  return Math.max(relaxed, p.noveltyFloor);
}

/**
 * 是否允许「打破冷却」（高重要性突发事件）。
 *
 * 三类放行：
 *  1. 命中评分器硬规则（override，如房贷40年这类必然置顶的条目）
 *  2. 档位 must_read 且相关性分 ≥ 80（重大事件）
 *  3. 风险板块：出现了新事实（风险不因「说过」而消失，有新证据就要继续预警）
 * 且统一要求 novelty ≥ 0.25 —— 纯重复不构成「突发」。
 */
export function canBreakCooldown(
  cand: MemoryCandidate,
  section: MemorySection,
  novelty: number,
  newFactsCount: number,
): boolean {
  if (novelty < 0.25) return false;
  if (cand.override === true) return true;
  if (cand.tier === "must_read" && (cand.score ?? 0) >= 80) return true;
  if (section === "risk" && newFactsCount > 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 7) 角度轮换（要求 4）
// ---------------------------------------------------------------------------

/**
 * 选择下一个切入角度：优先取「尚未用过」的角度（按 ANGLE_ORDER）；
 * 全部用完后，从最早使用的角度重新开始第二轮（避免永久封死）。
 */
export function nextAngle(record: EventRecord): EventAngle {
  const used = new Set(record.anglesUsed ?? []);
  for (const a of ANGLE_ORDER) if (!used.has(a)) return a;
  // 全部用过 → 重新从最早使用的开始轮
  const first = (record.anglesUsed ?? [])[0];
  return first ?? ANGLE_ORDER[0];
}

// ---------------------------------------------------------------------------
// 8) 核心判定流程（要求 2/3/4）
// ---------------------------------------------------------------------------

/*
 * 完整判定流程（伪代码）：
 *
 *   function evaluateCandidate(cand, section, today, store):
 *     match = findMatchingEvent(cand, store)
 *     if match == null:
 *         return { verdict: "new", allow: true }              # 记忆库没有 → 放行
 *
 *     n = computeNovelty(cand, match.record)                  # 信息增量
 *     daysSince = today - record.lastBroadcastAt
 *     cooldown = effectiveCooldownDays(record, section)       # 类型 × 板块 × 次数
 *     policy   = SECTION_POLICY[section]
 *
 *     # ① 次数上限：同一板块说得太多，必须有重大进展才能再说
 *     sectionCount = 该事件在本板块的历史播报次数
 *     if sectionCount >= policy.maxRepeat and n.novelty < policy.noveltyToBreak:
 *         return { verdict: "exhausted", allow: false }
 *
 *     # ② 当日已播（跨板块共享）：定调与必读常常指向同一事件，
 *     #    这是合理呈现（一句话定调 + 展开说为什么重要），不按冷却处理；
 *     #    只要求有基本增量，否则判为同一天内的重复表述
 *     if daysSince == 0:
 *         if n.novelty >= policy.noveltyBase:
 *             return { verdict: "progress", allow: true, requiredAngle: nextAngle }
 *         if n.novelty >= policy.noveltyFloor and policy.allowRefresh:
 *             return { verdict: "refresh", allow: true, requiredAngle: nextAngle }
 *         return { verdict: "duplicate", allow: false }
 *
 *     # ③ 冷却期内：需打破冷却
 *     if daysSince < cooldown:
 *         if canBreakCooldown(cand, section, n.novelty, n.newFacts.length):
 *             return { verdict: "progress", allow: true, brokeCooldown: true }
 *         threshold = policy.noveltyToBreak
 *         if n.novelty >= threshold:
 *             return { verdict: "progress", allow: true }
 *         if n.novelty < policy.noveltyFloor:
 *             return { verdict: "duplicate", allow: false }
 *         return { verdict: "cooldown", allow: false }
 *
 *     # ④ 冷却已结束：门槛随时间衰减
 *     threshold = decayedThreshold(section, daysSince, cooldown)
 *     if n.novelty >= policy.noveltyBase:
 *         return { verdict: "progress", allow: true }         # 有实质进展
 *     if n.novelty >= threshold:
 *         if not policy.allowRefresh:
 *             return { verdict: "cooldown", allow: false }    # 定调不接受"换角度重播"
 *         return { verdict: "refresh", allow: true, requiredAngle: nextAngle(record) }
 *     if n.novelty < policy.noveltyFloor:
 *         return { verdict: "duplicate", allow: false }
 *     return { verdict: "cooldown", allow: false }
 */

export function evaluateCandidate(opts: {
  cand: MemoryCandidate;
  section: MemorySection;
  /** 今天 YYYY-MM-DD。 */
  today: string;
  store: EventMemoryStore;
}): MemoryDecision {
  const { cand, section, today, store } = opts;
  const policy = SECTION_POLICY[section];
  const match = findMatchingEvent(cand, store);

  if (!match) {
    return {
      section,
      title: cand.title,
      verdict: "new",
      allow: true,
      novelty: 1,
      reason: "记忆库中无匹配事件（新事件）",
    };
  }

  const rec = match.record;
  const n = computeNovelty(cand, rec);
  const daysSince = diffDays(rec.lastBroadcastAt, today);
  const cooldownDays = effectiveCooldownDays(rec, section);
  const sectionCount = (rec.samples ?? []).filter((s) => s.section === section).length;

  // ① 板块内播报次数上限
  if (sectionCount >= policy.maxRepeat && n.novelty < policy.noveltyToBreak) {
    return {
      section,
      title: cand.title,
      verdict: "exhausted",
      allow: false,
      novelty: n.novelty,
      daysSince,
      cooldownDays,
      eventId: match.id,
      broadcastCount: rec.broadcastCount,
      reason: `该事件在本板块已播报 ${sectionCount} 次（上限 ${policy.maxRepeat}），增量 ${fmt(n.novelty)} 未达重大进展线 ${fmt(policy.noveltyToBreak)}`,
    };
  }

  // ② 当日已播（跨板块共享）：定调与必读指向同一事件属合理呈现
  //    （一句话定调 + 展开讲为什么重要），不按冷却处理，只要求基本增量。
  if (daysSince <= 0) {
    const angle = nextAngle(rec);
    if (n.novelty >= policy.noveltyBase) {
      return {
        section,
        title: cand.title,
        verdict: "progress",
        allow: true,
        novelty: n.novelty,
        daysSince: 0,
        cooldownDays,
        threshold: policy.noveltyBase,
        eventId: match.id,
        broadcastCount: rec.broadcastCount,
        requiredAngle: angle,
        reason: `当日已播（跨板块），增量 ${fmt(n.novelty)} ≥ 基础线 ${fmt(policy.noveltyBase)} → 换角度「${angle}」呈现`,
      };
    }
    if (n.novelty >= policy.noveltyFloor && policy.allowRefresh) {
      return {
        section,
        title: cand.title,
        verdict: "refresh",
        allow: true,
        novelty: n.novelty,
        daysSince: 0,
        cooldownDays,
        threshold: policy.noveltyFloor,
        eventId: match.id,
        broadcastCount: rec.broadcastCount,
        requiredAngle: angle,
        reason: `当日已播（跨板块），增量有限（${fmt(n.novelty)}）→ 强制换角度「${angle}」`,
      };
    }
    return {
      section,
      title: cand.title,
      verdict: "duplicate",
      allow: false,
      novelty: n.novelty,
      daysSince: 0,
      cooldownDays,
      eventId: match.id,
      broadcastCount: rec.broadcastCount,
      reason: `当日已播且增量 ${fmt(n.novelty)} < 下限 ${fmt(policy.noveltyFloor)}（同一天内的重复表述）`,
    };
  }

  // ③ 冷却期内
  if (daysSince < cooldownDays) {
    if (canBreakCooldown(cand, section, n.novelty, n.newFacts.length)) {
      return {
        section,
        title: cand.title,
        verdict: "progress",
        allow: true,
        novelty: n.novelty,
        daysSince,
        cooldownDays,
        threshold: policy.noveltyToBreak,
        eventId: match.id,
        broadcastCount: rec.broadcastCount,
        requiredAngle: nextAngle(rec),
        brokeCooldown: true,
        reason: `重大事件打破冷却（${daysSince}/${cooldownDays} 天，增量 ${fmt(n.novelty)}，新事实 ${n.newFacts.length} 项）`,
      };
    }
    if (n.novelty >= policy.noveltyToBreak) {
      return {
        section,
        title: cand.title,
        verdict: "progress",
        allow: true,
        novelty: n.novelty,
        daysSince,
        cooldownDays,
        threshold: policy.noveltyToBreak,
        eventId: match.id,
        broadcastCount: rec.broadcastCount,
        requiredAngle: nextAngle(rec),
        reason: `冷却期内但增量 ${fmt(n.novelty)} ≥ 打破线 ${fmt(policy.noveltyToBreak)}（有实质进展）`,
      };
    }
    if (n.novelty < policy.noveltyFloor) {
      return {
        section,
        title: cand.title,
        verdict: "duplicate",
        allow: false,
        novelty: n.novelty,
        daysSince,
        cooldownDays,
        eventId: match.id,
        broadcastCount: rec.broadcastCount,
        reason: `冷却期内（${daysSince}/${cooldownDays} 天）且增量 ${fmt(n.novelty)} < 下限 ${fmt(policy.noveltyFloor)}（重复表述）`,
      };
    }
    return {
      section,
      title: cand.title,
      verdict: "cooldown",
      allow: false,
      novelty: n.novelty,
      daysSince,
      cooldownDays,
      threshold: policy.noveltyToBreak,
      eventId: match.id,
      broadcastCount: rec.broadcastCount,
      reason: `冷却期内（${daysSince}/${cooldownDays} 天），增量 ${fmt(n.novelty)} 不足以打破（需 ≥ ${fmt(policy.noveltyToBreak)}）`,
    };
  }

  // ③ 冷却已结束：门槛随时间衰减
  const threshold = decayedThreshold(section, daysSince, cooldownDays);
  if (n.novelty >= policy.noveltyBase) {
    return {
      section,
      title: cand.title,
      verdict: "progress",
      allow: true,
      novelty: n.novelty,
      daysSince,
      cooldownDays,
      threshold,
      eventId: match.id,
      broadcastCount: rec.broadcastCount,
      requiredAngle: nextAngle(rec),
      reason: `冷却结束（${daysSince} 天）且增量 ${fmt(n.novelty)} ≥ 基础线 ${fmt(policy.noveltyBase)}（新进展）`,
    };
  }
  if (n.novelty >= threshold) {
    if (!policy.allowRefresh) {
      return {
        section,
        title: cand.title,
        verdict: "cooldown",
        allow: false,
        novelty: n.novelty,
        daysSince,
        cooldownDays,
        threshold,
        eventId: match.id,
        broadcastCount: rec.broadcastCount,
        reason: `板块不接受「换角度重播」（增量 ${fmt(n.novelty)} 仅达刷新线 ${fmt(threshold)}，未达基础线 ${fmt(policy.noveltyBase)}）`,
      };
    }
    return {
      section,
      title: cand.title,
      verdict: "refresh",
      allow: true,
      novelty: n.novelty,
      daysSince,
      cooldownDays,
      threshold,
      eventId: match.id,
      broadcastCount: rec.broadcastCount,
      requiredAngle: nextAngle(rec),
      reason: `冷却结束（${daysSince} 天）但增量有限（${fmt(n.novelty)} ≥ 衰减门槛 ${fmt(threshold)}）→ 强制换角度「${nextAngle(rec)}」`,
    };
  }
  if (n.novelty < policy.noveltyFloor) {
    return {
      section,
      title: cand.title,
      verdict: "duplicate",
      allow: false,
      novelty: n.novelty,
      daysSince,
      cooldownDays,
      threshold,
      eventId: match.id,
      broadcastCount: rec.broadcastCount,
      reason: `增量 ${fmt(n.novelty)} < 下限 ${fmt(policy.noveltyFloor)}（重复表述）`,
    };
  }
  return {
    section,
    title: cand.title,
    verdict: "cooldown",
    allow: false,
    novelty: n.novelty,
    daysSince,
    cooldownDays,
    threshold,
    eventId: match.id,
    broadcastCount: rec.broadcastCount,
    reason: `增量 ${fmt(n.novelty)} < 衰减门槛 ${fmt(threshold)}（距上次 ${daysSince} 天）`,
  };
}

function fmt(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

// ---------------------------------------------------------------------------
// 9) 记忆写入（纯函数，返回新 store）
// ---------------------------------------------------------------------------

/**
 * 开启新的一天：先把「昨天及更早」的暂存播报结算进长期记忆，再清空当天暂存区。
 *
 * 必须在每次判定前调用一次。幂等的关键：
 *  - 同一天重复运行 → 暂存区被清空重写，长期记忆不变 → 判定结果完全一致；
 *  - 跨天 → 昨天的播报结算进长期记忆 → 冷却期开始生效。
 */
/**
 * 结算闸门判定（2026-09-03，取代 9:00 启发式）：
 *  - 昨天**有人工确认推送**（deliveries 含昨天）→ 昨天的播报是客户真正收到的
 *    版本 → 全量结算进长期记忆（broadcastAt 仅溯源，不再按 9 点过滤——9 点前
 *    的测试重试与 9 点后的人工补发都可能是正式，时刻无法证伪）。
 *  - 昨天无交付记录 → 昨天从未正式交付（纯 build/测试/忘了推）→ 不结算，
 *    宁漏勿误：次日同源新闻允许重播，也不让没发出去的内容冷却掉真实发布。
 *  - 版本指纹校验（2026-09-03 补严）：deliveries.reportRunId（被推送版本的
 *    gh-pages 发布 run）与 today.runId（暂存区落盘 run）双侧都有且不一致 →
 *    推送的版本 ≠ 将结算的暂存内容 → 不结算（宁漏勿误）。任一侧缺指纹
 *    （旧记录 / mark-delivered 反查失败）→ 无法证伪，按信任交付结算。
 *
 * 必须在 beginDay 重置 today **之前**调用（依赖 store.today 仍是「昨天」）。
 */
