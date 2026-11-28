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
  candidateCoverage,
  candidateFacts,
  candidateText,
  classifyKind,
  extractTopicTags,
  geoCompatible,
  isUsableRecord,
  normText,
  sharedSubjectAnchors,
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
/**
 * **主题路**（「主体 × 主题」身份）命中时的相似度。
 *
 * 2026-10-03 sc 口径：**事件身份应由「主体 + 主题」承担，数值与时点只作「增量证据」**。
 * 锚点相似度（Jaccard / 覆盖率）会被措辞差异打败 —— 同一件事换个说法、少写一个数字，
 * 就可能从「老事件」变成「全新事件」，绕过冷却原样重播（10-03「公募 40 万亿」实证）。
 *
 * 取值**恰为合并阈**：主题路是**兜底** —— 一旦有真硬信号（Jaccard / 覆盖率 / 标题 Dice）
 * 命中，分数必然严格高于它，从而优先匹配「更像的那一条」。
 */
const THEME_LINE_SCORE = MATCH_THRESHOLD;
/**
 * 真硬信号相对主题路的排序优势（极小值）。
 *
 * 为什么需要：Jaccard 恰好 = 0.5（如 `{按揭}` vs `{按揭,购房}`）时，硬信号与主题路同分，
 * 而「选最高分」在同分时取先遍历到的那条 → **匹配结果取决于对象键顺序**（实测 10-03
 * 「多地出台预售现房新规」因此在 `按揭|购房` 与 `信贷|按揭|消费贷` 之间抖动）。
 * 加一个极小优势值，保证「有真证据的」永远严格优于「只有主题一致的」。
 */
const HARD_EPS = 0.01;
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
 * 扣掉「当天已计入的那一播报日」后的历史播报次数。
 *
 * 🔴 `broadcastCount` 的语义是**播报天数**（`upsertEvent` 里同一天重复呈现加 0），
 * 不是样本条数 —— 所以只能扣 1（当 `lastBroadcastAt === date` 时），
 * ⛔ 不能按「当天样本有几条」扣，否则当天跨板块播了 3 条就会把历史次数扣成 0。
 * 样本窗口（MAX_SAMPLES=6）被当天挤满时，这个差值也是「窗口外还有历史」的唯一证据。
 */
export function historicalBroadcastCount(rec: EventRecord, date: string): number {
  const countedOnDate = rec.lastBroadcastAt === date ? 1 : 0;
  return Math.max(0, (rec.broadcastCount ?? 0) - countedOnDate);
}

/**
 * 该记录是否「整条只在某一天播报过」——即当天刚结算进长期记忆的新记录。
 *
 * 用途：增量三态标注时把它排除出「历史」（见 `MatchOptions.excludeDate`）。
 * `samples` 为空时不判（没有播报留痕 → 不能断言它只属于当天，按历史处理更保守）。
 * 2026-11-28 校准：若样本窗口已被当天占满、但 `broadcastCount` 还有窗口外的历史，
 * 就不能整条排除（那是「证据不足」，见 `buildHistoricalEventView` 的弱身份兜底）。
 */
function isSettledOn(rec: EventRecord, date: string): boolean {
  const samples = Array.isArray(rec.samples) ? rec.samples : [];
  if (samples.length === 0) return false;
  if (!samples.every((s) => Boolean(s) && s.date === date)) return false;
  return historicalBroadcastCount(rec, date) === 0;
}

/**
 * 只保留 `excludeDate` 之前证据的**历史事件视图**（2026-11-28 · 第二轮修订任务书 4.3/4.4）。
 *
 * 为什么必须重建、不能沿用原记录的聚合字段：
 * 当天样本一旦被 `settleTodayIntoEvents` / `beginDay` 结算进 events，
 * `anchors` / `topicTags` / `broadcastedTexts` / `broadcastedFacts` 就全是**并集**，
 * 里面混着当天已播的新事实；继续拿它算 novelty，今天的新进展会被提前吞掉。
 *
 * 视图只从 `date < excludeDate` 的 `BroadcastSample` 重建，且**逐条按写入时同一口径**
 * 重算 anchor / tag / fact（`candidateAnchors` / `candidateFacts` / `extractTopicTags`），
 * 保证「写进去的」与「拿来比的」同源。纯函数，不改入参。
 *
 * @returns 没有可用历史样本时返回 `null`（调用方按「证据不足」保守降级，不拿当天充数）。
 */
export function buildHistoricalEventView(rec: EventRecord, excludeDate: string): EventRecord | null {
  const samples = (Array.isArray(rec.samples) ? rec.samples : []).filter(
    (s): s is BroadcastSample => Boolean(s) && s.date < excludeDate,
  );
  if (samples.length === 0) return null;

  const toCandidate = (s: BroadcastSample) => ({ title: s.title, text: s.text ?? "" });
  // 与 event-settle/upsertEvent 写入时完全同口径：text = candidateText(cand) = 标题 + 正文。
  const textOf = (s: BroadcastSample) => candidateText(toCandidate(s));
  const anchors = [
    ...new Set(samples.flatMap((s) => candidateAnchors(toCandidate(s)))),
  ];
  const topicTags = [...new Set(samples.flatMap((s) => extractTopicTags(textOf(s))))];
  const broadcastedTexts = samples.map(textOf);
  const broadcastedFacts = [
    ...new Set(
      samples.flatMap((s) =>
        Array.isArray(s.facts) && s.facts.length ? s.facts : candidateFacts(toCandidate(s)),
      ),
    ),
  ];
  const last = samples.map((s) => s.date).sort().at(-1) ?? rec.firstBroadcastAt;

  return {
    ...rec,
    anchors,
    topicTags,
    samples,
    broadcastedTexts,
    broadcastedFacts,
    broadcastCount: historicalBroadcastCount(rec, excludeDate),
    lastBroadcastAt: last,
  };
}

/**
 * 匹配选项（2026-11-28 新增）。
 *
 * `excludeDate`：把「这一天的播报」排除在**历史**之外，只用于增量三态标注
 * （`assemble/delta.ts` 传当天日期）。起因见 `assemble/delta.ts` 顶部注释：
 * 上线 run 里 `side-exec-summary` 会**先**把本次播报写进 today 暂存区并落盘，
 * 随后 delta 标注再读记忆库 —— 若不排除，每条都会命中「自己」→ 全站恒为续报
 * （实测近 30 期 must_read：新增 0 / 有进展 0 / 续报 36）。
 *
 * ⚠️ 只影响匹配的**候选集**，不改任何阈值；不传该选项时行为与历史完全一致
 * （exec-guard / 记忆去重链的调用一律不传）。
 */
export interface MatchOptions {
  /**
   * 视作「本次运行当天」的日期（YYYY-MM-DD）。当天的暂存条目与当天结算的记录不算历史。
   * 生效时**事件记录也只以 `buildHistoricalEventView()` 的历史视图参与匹配**，
   * 不读原记录的聚合字段（其中可能含当天事实）。
   */
  excludeDate?: string;
  /**
   * 地域互斥（2026-11-28）：两侧都指向明确城市且无交集 → 不认为是同一事件。
   *
   * 只用于**增量三态**标注（`assemble/delta.ts`），**默认关闭** → exec-guard 的判重
   * 行为一字不变。理由：判重（去重）宁可保守合并，三态（新增/续报）则必须区分
   * 「广州和珠海各出一个购房补贴政策」这类「同主题不同地区」的独立事件。
   * 这是**收紧**匹配，不放宽任何阈值。
   */
  requireGeoCompatible?: boolean;
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
 *  3. **候选覆盖率**（2026-10-03 新增）—— `|A∩B| / |A|`。补住「历史 anchors 只增不减 →
 *     Jaccard 分母膨胀 → 老事件越"丰富"越难被匹配」的自恶化：同一件事讲得越多，
 *     历史锚点越全，反而越难认出它。实测 10-03「公募规模近40万亿」vs 09-28 事件：
 *     Jaccard 仅 0.143（被 6 个历史锚稀释），覆盖率 0.5（恰好达标）。
 *  4. 主题标签共享 ≥2 —— 弱辅助信号：仅当硬信号已具一定置信（≥ HARD_CORROB）时
 *     才抬到合并阈（兜底「同一主题不同切入」）；单独出现不触发合并，防误并。
 */
export function findMatchingEvent(
  cand: MemoryCandidate,
  store: EventMemoryStore,
  opts: MatchOptions = {},
): {
  id: string;
  record: EventRecord;
  similarity: number;
  source: "today" | "events";
  /** 历史记录存在但样本窗口被当天占满 → 只有弱身份证据，三态必须降为 followup + low。 */
  evidenceInsufficient?: boolean;
} | null {
  const anchors = candidateAnchors(cand);
  const candText = candidateText(cand);
  const tags = extractTopicTags(candText);
  const url = cand.url;
  const excludeDate = opts.excludeDate;
  // 记录侧文本（仅 requireGeoCompatible 时用到）：缓存一次，避免逐条重拼。
  const recTextCache = new WeakMap<EventRecord, string>();
  const recordTextOf = (rec: EventRecord): string => {
    const cached = recTextCache.get(rec);
    if (cached !== undefined) return cached;
    const t = [
      (Array.isArray(rec.samples) ? rec.samples : []).map((s) => s?.title ?? "").join(" "),
      (rec.broadcastedTexts ?? []).join(" "),
    ]
      .filter(Boolean)
      .join(" ");
    recTextCache.set(rec, t);
    return t;
  };
  const score = (
    rec: EventRecord,
  ): number => {
    const samples = Array.isArray(rec.samples) ? rec.samples : [];
    if (url && samples.some((s) => s && s.url && s.url === url)) return 1;
    // 地域互斥（收紧）：明确指向不同城市 → 不是同一事件。
    // 放在 URL 判等之后：同一篇文章必然同地域，不该被地域规则推翻。
    if (opts.requireGeoCompatible && !geoCompatible(candText, recordTextOf(rec))) return 0;
    const recAnchors = Array.isArray(rec.anchors) ? rec.anchors : [];
    const aj = anchorJaccard(anchors, recAnchors);
    const td = bestTitleDice(cand.title, rec);
    const st = sharedTags(tags, rec.topicTags);
    // 候选覆盖率：与 Jaccard 并列的硬信号（防历史锚点膨胀导致的漏召回，2026-10-03）
    //
    // 🔴 守卫（2026-10-03 实测追加）：**只在锚点分布不过分悬殊时生效**。
    // 覆盖率 `|A∩B|/|A|` 在历史事件是「锚点大杂烩」（`|B|` 很大）时必然趋近 1 ——
    // 因为大杂烩里"什么锚都有"，候选的锚总能被"覆盖"，**信息量归零**。
    // 10-03 实证三例误召回（`cov=1.00` 而 `aj` 仅 0.15~0.20、标题 Dice = 0）：
    //   ①「房贷贴息细则落地」→ 匹配到 `按揭`（10 锚 / 9 次，样本是外贸结算、金融城、
    //      社区零售、东莞购房补贴、城市合伙人等**毫不相干**的内容）；
    //   ②「30年国债持仓创新高」→ 匹配到 `保险|利率|存款`（10 锚，样本全是**美元**存款话题）；
    //   ③「民营项目公开推介」→ 匹配到 `信贷|利率|客群`（13 锚，样本含粤芯半导体、大北农）。
    // 加 `aj ≥ HARD_CORROB` 后三例全部失效，而真正该命中的「公募规模近40万亿」（aj 0.40）
    // 与「公募规模逼近40万亿」（aj 0.33）**照常命中** —— 因为同事件的锚点分布本就集中。
    const cov = aj >= HARD_CORROB ? candidateCoverage(anchors, recAnchors) : 0;
    // 主体锚共享数：主题路的「主体」一半（2026-10-03）
    const subj = sharedSubjectAnchors(anchors, recAnchors);
    const hard = Math.max(aj, td, cov);
    // 合并判定（按证据强度从高到低）：
    //  - 硬信号达合并阈 → 直接合并；
    //  - **主题路**：硬信号已有基本置信（≥ HARD_CORROB）、**主体锚**（在谈基金？还是房贷？）
    //    与**主题标签**（财富管理 / 住房金融…）双一致 → 合并。补住「措辞一变、锚点一少
    //    就认不出老事件」的漏召回；「主体锚」这一半是守卫：只有地域/机构锚（广州、央行）
    //    凑巧相同、业务主体毫不相干的，不算同一条主题线。
    //  - 硬信号达 HARD_CORROB 且共享 ≥2 主题标签 → 软命中合并（同一主题不同切入兜底）；
    //  - 否则标签共享只给弱辅助值（TAG_SOFT_BOOST），不触发合并，防不同事件误并。
    if (hard >= MATCH_THRESHOLD) return Math.max(hard, MATCH_THRESHOLD + HARD_EPS);
    if (hard >= HARD_CORROB && subj >= 1 && st >= 1) return THEME_LINE_SCORE;
    if (hard >= HARD_CORROB && st >= 2) return MATCH_THRESHOLD;
    return Math.max(hard, st >= 2 ? TAG_SOFT_BOOST : 0);
  };

  // 1) 当天暂存区（同一次运行内已播报）
  // 🔴 excludeDate 生效时跳过：「今天」的暂存条目不算历史（否则本次播报命中自己）。
  let bestToday: { id: string; record: EventRecord; similarity: number } | null = null;
  const todayExcluded = Boolean(excludeDate && store.today?.date === excludeDate);
  if (!todayExcluded) {
    for (const p of todayPseudoRecords(store)) {
      const sim = score(p.record);
      if (sim >= MATCH_THRESHOLD && (!bestToday || sim > bestToday.similarity)) {
        bestToday = { id: p.id, record: p.record, similarity: sim };
      }
    }
  }
  if (bestToday) return { ...bestToday, source: "today" };

  // 2) 长期记忆（昨天及更早）—— 只用「按日期隔离后的历史视图」匹配
  let best: {
    id: string;
    record: EventRecord;
    similarity: number;
    evidenceInsufficient: boolean;
  } | null = null;
  for (const [id, rec] of Object.entries(store.events ?? {})) {
    // 损坏记录跳过（不使整体匹配失效）；落盘时会被 sanitizeEvents 清除 → 自愈
    if (!isUsableRecord(rec)) continue;
    // 当天已结算进长期记忆的记录（微信推送后 settleTodayIntoEvents / 跨日 beginDay）
    // 同样不算历史 —— 否则当天这一期永远判不出「新增」。
    if (excludeDate && isSettledOn(rec, excludeDate)) continue;

    let view = rec;
    let evidenceInsufficient = false;
    if (excludeDate) {
      const usable = buildHistoricalEventView(rec, excludeDate);
      if (usable) {
        view = usable;
      } else {
        // 有历史但样本窗口被当天挤满（MAX_SAMPLES 截断）：没有可核验的历史证据。
        // 只做一次弱身份识别，目的仅是**不把已经播过的事件误报成「新增」**；
        // 绝不用这份视图算 novelty（三态层见 deltaOf 的 evidenceInsufficient 分支）。
        const histCount = historicalBroadcastCount(rec, excludeDate);
        if (histCount === 0) continue;
        view = { ...rec, broadcastCount: histCount, lastBroadcastAt: rec.firstBroadcastAt };
        evidenceInsufficient = true;
      }
    }
    const sim = score(view);
    if (
      sim >= MATCH_THRESHOLD &&
      (!best ||
        (best.evidenceInsufficient && !evidenceInsufficient) ||
        (best.evidenceInsufficient === evidenceInsufficient && sim > best.similarity))
    ) {
      best = { id, record: view, similarity: sim, evidenceInsufficient };
    }
  }
  return best
    ? {
        id: best.id,
        record: best.record,
        similarity: best.similarity,
        source: "events",
        ...(best.evidenceInsufficient ? { evidenceInsufficient: true } : {}),
      }
    : null;
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
  const facts = candidateFacts(cand);
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
