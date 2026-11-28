/**
 * 增量三态标注（A3，2026-09-17）——「今天真正新的是什么」。
 *
 * 读者问题：连播主题（信贷利率、养老金融…）每天都会出现，读者无法判断
 * 「今天这条是**第一次说**、还是**又说了一遍**、还是**有了新进展**」。
 *
 * 做法：**复用事件记忆的判重链**，不另立规则：
 *   ① `findMatchingEvent(cand, store)` — 与记忆服务同一套匹配（URL 精确 → 锚点 Jaccard
 *      → 标题 Dice → 主题标签共享）；
 *   ② `computeNovelty(cand, record)` — 同一套信息增量量化（新事实 0.45 / 新 bigram 0.35 /
 *      阶段推进 0.20，按标题雷同度惩罚）。
 * 三态判定：
 *   - **无匹配** → `new`（首次出现）；
 *   - 匹配到**长期记忆**（昨天及更早）且增量 ≥ 阈值或发生阶段推进 → `changed`（有进展），
 *     并带上新事实锚点；
 *   - 匹配到长期记忆但增量有限 → `followup`（续报，第 N 期 = 历史播报次数 + 1）；
 *   - 匹配到**当天暂存区** → `followup`（同一次运行内重复提及，不给期号）。
 *
 * 纯函数、幂等、不 mutate 入参；时间不进函数（记忆库自带日期口径），故无隐式时钟。
 */
import type { DailyReport, DeltaMark } from "../../contracts/report";
import type { EventMemoryStore, MemoryCandidate } from "../memory/event-types";
import { computeNovelty, findMatchingEvent } from "../memory/event-decide";

/**
 * 「有实质进展」的增量阈值。
 * 与 `computeNovelty` 注释里的语义一致（≥0.35 视为有实质进展；0.15~0.35 为增量有限）。
 */
export const DELTA_PROGRESS_THRESHOLD = 0.35;

/**
 * 2026-11-28 校准（sc 定向修订任务书 · 任务四）：
 *
 * 🔴 修前实测：近 30 期 must_read 三态合计 **新增 0 / 有进展 0 / 续报 36**。
 * 根因两条，都与阈值无关：
 *   ① **时序**：上线 run 里 `side-exec-summary`（pipeline 第 69 行内）先把本次播报
 *      写进 today 暂存区并落盘，第 97 行才 loadEventMemory 做标注 → 每条命中「自己」
 *      → `source==="today"` → 无条件 followup（连期号都丢：报告里是 `{"state":"followup"}`）。
 *      修法：基线在 `buildSideOutputs` **之前**读取（pipeline 注入 `deltaBaseline`），
 *      并把当天排除出历史（`excludeDate`）。
 *   ② **当天结算**：`settleTodayIntoEvents`（微信推送后）与跨日 `beginDay` 会把当天
 *      播报并入 events（实测存在 `firstBroadcastAt=2026-11-28` 的记录）→ 即使修好时序，
 *      当天条目仍命中「当天结算的历史」。修法同 ①：`samples` 全为当天的记录不算历史。
 *   ③ **有进展必须说得出新在哪**：只有增量分高、但抽不出新事实时不再标 changed。
 */
export interface DeltaOptions {
  /** 视作「本次运行当天」的日期（YYYY-MM-DD）。当天播报不算历史（见 MatchOptions）。 */
  excludeDate?: string;
}

/** 事实锚点 → 可读文本（去掉内部前缀 `#` 数字 / `!` 阶段 / `@` 机构）。 */
function readableFact(f: string): string {
  return /^[#!@]/.test(f) ? f.slice(1) : f;
}

/** 是否存在「非当天」的历史基线（决定新增判定的置信度，避免记忆缺失时谎报高置信）。 */
function hasHistoricalBaseline(store: EventMemoryStore, excludeDate?: string): boolean {
  for (const rec of Object.values(store.events ?? {})) {
    const samples = Array.isArray(rec?.samples) ? rec.samples : [];
    if (samples.length === 0) return true; // 无留痕但存在记录：按历史处理（保守）
    if (!excludeDate || samples.some((s) => s && s.date < excludeDate)) return true;
    // 样本窗口被当天挤满、但 broadcastCount 还留着窗口外的播报日 → 基线存在（只是证据不足）
    const countedOnDate = rec?.lastBroadcastAt === excludeDate ? 1 : 0;
    if ((rec?.broadcastCount ?? 0) - countedOnDate > 0) return true;
  }
  const todayEntries = store.today?.entries ?? [];
  return todayEntries.length > 0 && store.today?.date !== excludeDate;
}

/** 单条内容 → 三态标注。 */
export function deltaOf(
  cand: MemoryCandidate,
  store: EventMemoryStore,
  opts: DeltaOptions = {},
): DeltaMark {
  const hit = findMatchingEvent(cand, store, {
    ...(opts.excludeDate ? { excludeDate: opts.excludeDate } : {}),
    // 三态还要区分「广州和珠海各出一个同主题政策」这种独立事件（任务书 4.7 第 5 条）。
    // 只在这里开（收紧），exec-guard 的判重行为不受影响。
    requireGeoCompatible: true,
  });
  if (!hit) {
    // 记忆库为空（首次运行 / 读取失败）时仍判「新增」——绝不在无依据的情况下标续报；
    // 但置信度降为 low，让日志与评估能区分「真的新」和「没有基线可比」。
    return { state: "new", confidence: hasHistoricalBaseline(store, opts.excludeDate) ? "high" : "low" };
  }
  // 命中当天暂存区：同一次运行内已播过同一事件 → 续报，不给期号（否则会谎报「第 N 期」）
  if (hit.source === "today") return { state: "followup", confidence: "medium" };

  // 历史记录存在，但样本窗口被当天占满、没有可核验的历史证据：
  // 按 sc 拍板保守降为 followup + low —— 不误报「新增」，更不强行判「有进展」；
  // 不给期号（历史次数无法从被截断的样本核对），不做 novelty（不碰当天事实）。
  if (hit.evidenceInsufficient) return { state: "followup", confidence: "low" };

  // hit.record 在 excludeDate 生效时是 buildHistoricalEventView() 的历史视图，
  // broadcastCount 已扣掉当天计入的那一播报日 → 期号不会因当天已播而过增。
  const issueNo = (hit.record.broadcastCount ?? 0) + 1;

  // 同一篇文章（URL 精确命中）再次上榜：稿件本身没变，不可能构成「新进展」。
  // 之前这里会走 novelty 计算 —— 换了标题措辞就能凑够增量分，把「重复上榜」标成「有进展」。
  const sameArticle =
    Boolean(cand.url) && (hit.record.samples ?? []).some((s) => Boolean(s) && s.url === cand.url);
  if (sameArticle) return { state: "followup", issueNo, confidence: "high" };

  const nv = computeNovelty(cand, hit.record);
  const facts = [...new Set((nv.newFacts ?? []).map(readableFact).filter(Boolean))].slice(0, 2);
  const progressed = nv.novelty >= DELTA_PROGRESS_THRESHOLD || nv.stageAdvance;

  // 🔴 changed 必须有至少 1 条可核验新事实。只有「增量分高」但抽不出新事实时，
  // 标「有进展」比标「续报」更误导读者 —— 降级为续报（任务书 4.5）。
  if (progressed && facts.length > 0) {
    return { state: "changed", issueNo, highlights: facts, confidence: "high" };
  }
  return {
    state: "followup",
    issueNo,
    confidence: hit.similarity >= 0.8 ? "medium" : "low",
  };
}

/** 把报告内 4 个「连播板块」的条目逐条标上三态（幂等；不 mutate 入参）。 */
export function annotateDeltas(
  report: DailyReport,
  store: EventMemoryStore,
  opts: DeltaOptions = {},
): DailyReport {
  const hero_line = report.hero_line?.trim();
  const heroDelta = hero_line
    ? deltaOf({ title: hero_line, text: hero_line }, store, opts)
    : report.heroDelta;

  const must_read = (report.must_read ?? []).map((m) => ({
    ...m,
    delta: deltaOf({ title: m.title ?? "", text: `${m.title ?? ""} ${m.why ?? ""}`, url: m.url }, store, opts),
  }));

  const insights = (report.insights ?? []).map((it) => ({
    ...it,
    delta: deltaOf(
      {
        title: it.topic ?? "",
        text: `${it.topic ?? ""} ${it.impact ?? ""} ${it.action ?? ""}`,
        url: it.sources?.[0]?.url,
      },
      store,
      opts,
    ),
  }));

  const risk = report.risk
    ? {
        ...report.risk,
        delta: deltaOf(
          {
            title: report.risk.topic ?? "",
            text: `${report.risk.topic ?? ""} ${report.risk.evidence ?? ""} ${report.risk.impact ?? ""}`,
            url: report.risk.sources?.[0]?.url ?? report.risk.url,
          },
          store,
          opts,
        ),
      }
    : undefined;

  return { ...report, heroDelta, must_read, insights, risk };
}

// 展示文案与徽章 HTML 在 `render/delta-badge.ts`（渲染层只读契约，不反向依赖本模块的
// 记忆判重链 —— 避免把 memory 拉进渲染依赖图）。
