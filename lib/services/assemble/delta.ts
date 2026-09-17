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

/** 单条内容 → 三态标注。 */
export function deltaOf(cand: MemoryCandidate, store: EventMemoryStore): DeltaMark {
  const hit = findMatchingEvent(cand, store);
  if (!hit) return { state: "new" };
  if (hit.source === "today") return { state: "followup" }; // 同日重复提及：不算新增、不给期号

  const nv = computeNovelty(cand, hit.record);
  const issueNo = (hit.record.broadcastCount ?? 0) + 1;
  if (nv.novelty >= DELTA_PROGRESS_THRESHOLD || nv.stageAdvance) {
    return { state: "changed", issueNo, highlights: (nv.newFacts ?? []).slice(0, 2) };
  }
  return { state: "followup", issueNo };
}

/** 把报告内 4 个「连播板块」的条目逐条标上三态（幂等；不 mutate 入参）。 */
export function annotateDeltas(report: DailyReport, store: EventMemoryStore): DailyReport {
  const hero_line = report.hero_line?.trim();
  const heroDelta = hero_line ? deltaOf({ title: hero_line, text: hero_line }, store) : report.heroDelta;

  const must_read = (report.must_read ?? []).map((m) => ({
    ...m,
    delta: deltaOf({ title: m.title ?? "", text: `${m.title ?? ""} ${m.why ?? ""}`, url: m.url }, store),
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
        ),
      }
    : undefined;

  return { ...report, heroDelta, must_read, insights, risk };
}

// 展示文案与徽章 HTML 在 `render/delta-badge.ts`（渲染层只读契约，不反向依赖本模块的
// 记忆判重链 —— 避免把 memory 拉进渲染依赖图）。
