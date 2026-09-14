/**
 * 事件记忆 —— 修剪与摘要（2026-09-14 C-1 Phase4 纯搬移）。
 */
import type { EventAngle, EventMemoryStore, EventRecord, MemorySection } from "./event-types";
import { ANGLE_GUIDE, SECTION_POLICY } from "./event-types";
import { isUsableRecord, sanitizeEvents } from "./event-text";
import { diffDays, nextAngle } from "./event-decide";
export function pruneMemory(
  store: EventMemoryStore,
  today: string,
  opts: { retainDays?: number; maxEvents?: number } = {},
): EventMemoryStore {
  const retainDays = opts.retainDays ?? 45;
  const maxEvents = opts.maxEvents ?? 400;
  // 落盘前统一清洗：损坏记录在此丢弃、数值/日期类型在此归一化。
  // pruneMemory 是写入前必经路径（store.ts:saveEventMemory），在此兜底可确保
  // 即使调用方传入被污染的 store，落盘内容也是干净的 → 自愈。
  const src = sanitizeEvents(store.events ?? {});
  const events: Record<string, EventRecord> = {};
  for (const [id, rec] of Object.entries(src)) {
    // 日期缺失/非法时按「今天」处理（宁可保留，不误删记忆）
    const lastAt = rec.lastBroadcastAt ? rec.lastBroadcastAt : today;
    const age = Number.isFinite(diffDays(lastAt, today)) ? diffDays(lastAt, today) : 0;
    const keepFor = (rec.peakScore ?? 0) >= 60 ? retainDays * 2 : retainDays;
    if (age <= keepFor) events[id] = rec;
  }
  const list = Object.entries(events).sort(
    (a, b) => (a[1].lastBroadcastAt < b[1].lastBroadcastAt ? -1 : 1),
  );
  if (list.length > maxEvents) {
    const trimmed: Record<string, EventRecord> = {};
    for (const [id, rec] of list.slice(list.length - maxEvents)) trimmed[id] = rec;
    return { version: 1, updatedAt: today, events: trimmed, ...(store.today ? { today: store.today } : {}), ...(store.deliveries ? { deliveries: store.deliveries } : {}), ...(store.ipoVoicing ? { ipoVoicing: store.ipoVoicing } : {}) };
  }
  return { version: 1, updatedAt: today, events, ...(store.today ? { today: store.today } : {}), ...(store.deliveries ? { deliveries: store.deliveries } : {}), ...(store.ipoVoicing ? { ipoVoicing: store.ipoVoicing } : {}) };
}

/** 空记忆库。 */
export function emptyMemory(): EventMemoryStore {
  return { version: 1, events: {} };
}

/**
 * 生成给 LLM 的「记忆提示」：近期已播报事件清单 + 若必须重播应切换的角度。
 * 只取最近 lookbackDays 天内播报过的事件，按最近播报时间倒序。
 */
export function buildMemoryBrief(
  store: EventMemoryStore,
  today: string,
  opts: { lookbackDays?: number; limit?: number } = {},
): Array<{
  title: string;
  lastBroadcast: string;
  daysSince: number;
  count: number;
  suggestedAngle: EventAngle;
  angleGuide: string;
}> {
  const lookback = opts.lookbackDays ?? 10;
  const limit = opts.limit ?? 8;
  const out: Array<{
    title: string;
    lastBroadcast: string;
    daysSince: number;
    count: number;
    suggestedAngle: EventAngle;
    angleGuide: string;
  }> = [];
  for (const rec of Object.values(store.events ?? {})) {
    if (!isUsableRecord(rec)) continue;
    const lastAt = typeof rec.lastBroadcastAt === "string" ? rec.lastBroadcastAt : today;
    const days = diffDays(lastAt, today);
    if (days < 0 || days > lookback) continue;
    const last = rec.samples.filter((s) => s && s.date === lastAt)[0]
      ?? rec.samples[rec.samples.length - 1];
    if (!last) continue;
    const angle = nextAngle(rec);
    out.push({
      title: last.title,
      lastBroadcast: rec.lastBroadcastAt,
      daysSince: days,
      count: rec.broadcastCount ?? 1,
      suggestedAngle: angle,
      angleGuide: ANGLE_GUIDE[angle],
    });
  }
  out.sort((a, b) => a.daysSince - b.daysSince);
  return out.slice(0, limit);
}

/**
 * 把记忆提示渲染成注入 LLM 提示词的文本块。
 *
 * 给模型的指令是「优先选新事件；若某事件确实仍是今天最值得说的，
 * 必须换一个切入角度」——而不是「禁止提及」。
 * 硬禁会让模型在只有旧事件可说时编造内容（历史教训：LLM 宁可编也不留空），
 * 因此保留「换角度重说」的合法出口。
 */
export function formatMemoryBrief(
  brief: Array<{
    title: string;
    lastBroadcast: string;
    daysSince: number;
    count: number;
    suggestedAngle: EventAngle;
    angleGuide: string;
  }>,
): string {
  if (brief.length === 0) return "";
  const lines = brief.map((b) => {
    const when = b.daysSince === 0 ? "今天已播报过" : `${b.daysSince} 天前播报过`;
    return `- 「${b.title.slice(0, 40)}」（${when}，累计 ${b.count} 次）→ 如需再讲，请改从「${b.suggestedAngle}」切入：${b.angleGuide}`;
  });
  return [
    "",
    "【内容记忆·去重约束】以下是近期已播报过的事件，行长已经听过：",
    ...lines,
    "- 优先选择上述之外的新事件；",
    "- 若某事件确实仍是今天最值得说的（如出现实质新进展），可以再讲，但**必须换成上面指定的切入角度**，用新事实、新数据或新主体展开，严禁换汤不换药地复述；",
    "- 严禁编造新事件来规避本约束。",
  ].join("\n");
}

