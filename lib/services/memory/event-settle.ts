/**
 * 事件记忆 —— 结算与记账（2026-09-14 C-1 Phase4 纯搬移）：
 * 交付闸门 / beginDay / 事件落库 / 播报记录 / 交付记录 / IPO 口播窗。
 */
import { IPO_VOICE_WINDOW_DAYS } from "../../ipo-config";
import {
  IPO_VOICE_MAX_IN_WINDOW,
  IPO_VOICE_PRUNE_DAYS,
} from "./event-types";
import type {
  BroadcastSample,
  DeliveryRecord,
  EventAngle,
  EventMemoryStore,
  EventRecord,
  MemoryCandidate,
  MemorySection,
} from "./event-types";
import { MAX_SAMPLES, MAX_TEXTS, SECTION_POLICY } from "./event-types";
import {
  candidateAnchors,
  candidateText,
  classifyKind,
  extractFacts,
  extractTopicTags,
  makeEventId,
  normText,
} from "./event-text";
import { findMatchingEvent } from "./event-decide";
import { diffDays, evaluateCandidate } from "./event-decide";
export function deliverySettlementGate(
  store: EventMemoryStore,
  prevDate: string,
): { settle: boolean; reason: "delivered" | "no-delivery" | "fingerprint-mismatch" } {
  const rec = (store.deliveries ?? []).find((d) => d && d.date === prevDate);
  if (!rec) return { settle: false, reason: "no-delivery" };
  const pushedRun = rec.reportRunId;
  const stagedRun = store.today && store.today.date === prevDate ? store.today.runId : undefined;
  if (pushedRun && stagedRun && pushedRun !== stagedRun) {
    return { settle: false, reason: "fingerprint-mismatch" };
  }
  return { settle: true, reason: "delivered" };
}

export function beginDay(store: EventMemoryStore, today: string): EventMemoryStore {
  let events = { ...(store.events ?? {}) };
  const prev = store.today;
  if (prev && prev.date && prev.date !== today && prev.entries.length > 0) {
    const gate = deliverySettlementGate(store, prev.date);
    if (gate.settle) events = settleIntoEvents(events, prev.entries);
  }
  return {
    version: 1,
    updatedAt: today,
    events,
    today: { date: today, entries: [] },
    ...(store.deliveries ? { deliveries: store.deliveries } : {}),
    ...(store.ipoVoicing ? { ipoVoicing: store.ipoVoicing } : {}),
  };
}

/**
 * 把当日「暂存区」直接结算进长期记忆（Fix A，2026-09-10）。
 *
 * 取代「次日跨天 beginDay + deliverySettlementGate 指纹对账」旧链路：旧链路在
 * 「同日重推终版」这种正常操作下，会因暂存 runId ≠ 推送 runId 而误杀已发微信内容
 * （2026-09-09 / 09-10 复盘：这两天口播因此从未进长期记忆，09-08 已彻底丢失）。
 *
 * 新语义：**微信推送成功即结算**——发微信本身就是最权威的「已交付」信号，
 * 不再做二次版本对账。结算后清空当日暂存区，避免次日 beginDay 重复结算
 * （beginDay 仍保留为兜底：若某天跳过了 mark-delivered，次日 run 的 beginDay
 * 仍会按 deliveries 闸门结算）。
 *
 * @param store 当前记忆库
 * @param date  目标日期（默认取 store.today.date）。仅当 store.today.date === date 时才结算。
 * @returns 新 store；无可结算内容时返回原引用（便于调用方用 `===` 判等跳过写盘）。
 */
export function settleTodayIntoEvents(
  store: EventMemoryStore,
  date?: string,
): EventMemoryStore {
  const today = store.today;
  if (!today || today.entries.length === 0) return store;
  if (date && today.date !== date) return store;
  const events = settleIntoEvents(store.events ?? {}, today.entries);
  return {
    ...store,
    events,
    today: { date: today.date, entries: [] },
  };
}

/** 把一批播报留痕结算进长期记忆（跨天时调用，亦供 reconcile 复用）。 */
export function settleIntoEvents(
  events: Record<string, EventRecord>,
  entries: BroadcastSample[],
): Record<string, EventRecord> {
  let out = events;
  for (const s of entries) {
    const cand: MemoryCandidate = {
      title: s.title,
      text: s.text ?? "",
      ...(s.url ? { url: s.url } : {}),
      ...(s.score !== undefined ? { score: s.score } : {}),
    };
    out = upsertEvent(out, cand, s);
  }
  return out;
}

/** 把一条播报合并进长期记忆（存在则更新，不存在则新建）。 */
function upsertEvent(
  events: Record<string, EventRecord>,
  cand: MemoryCandidate,
  sample: BroadcastSample,
): Record<string, EventRecord> {
  const text = candidateText(cand);
  const anchors = candidateAnchors(cand);
  const tags = extractTopicTags(text);
  const facts = extractFacts(text);
  const angle = sample.angle;
  const match = findMatchingEvent(cand, { version: 1, events });
  const out = { ...events };

  const merge = (rec: EventRecord): EventRecord => {
    // 同一天的多次呈现（跨板块 / 换角度）不重复计数 —— broadcastCount 语义是
    // 「播报天数」，否则定调 + 必读 + 商机都指向同一事件会让冷却期无谓暴涨。
    const sameDay = rec.lastBroadcastAt === sample.date;
    return {
      ...rec,
      // 锚点/标签/事实取并集，让后续同类报道更容易匹配到本事件
      anchors: [...new Set([...rec.anchors, ...anchors])],
      topicTags: [...new Set([...rec.topicTags, ...tags])],
      broadcastedTexts: [...(rec.broadcastedTexts ?? []), text].slice(-MAX_TEXTS),
      broadcastedFacts: [...new Set([...(rec.broadcastedFacts ?? []), ...facts])],
      lastBroadcastAt: sample.date,
      broadcastCount: (rec.broadcastCount ?? 0) + (sameDay ? 0 : 1),
      sections: [...new Set([...(rec.sections ?? []), sample.section])],
      anglesUsed: angle ? [...new Set([...(rec.anglesUsed ?? []), angle])] : rec.anglesUsed ?? [],
      samples: [...(rec.samples ?? []), sample].slice(-MAX_SAMPLES),
      peakScore: Math.max(rec.peakScore ?? 0, cand.score ?? 0),
    };
  };

  if (match) {
    out[match.id] = merge(match.record);
    return out;
  }
  const id = makeEventId(anchors) || `ev-${hash(normText(cand.title))}`;
  out[id] = events[id]
    ? merge(events[id])
    : {
        id,
        topicTags: tags,
        anchors,
        kind: classifyKind(text),
        firstBroadcastAt: sample.date,
        lastBroadcastAt: sample.date,
        broadcastCount: 1,
        sections: [sample.section],
        anglesUsed: angle ? [angle] : [],
        samples: [sample],
        broadcastedTexts: [text],
        broadcastedFacts: facts,
        peakScore: cand.score ?? 0,
      };
  return out;
}

/**
 * 记录一次播报 → 写入**当天暂存区**（不直接进长期记忆，跨天才结算）。
 *
 * 为什么分两层：见 EventMemoryStore.today 的说明（保证同一天多次运行的幂等性）。
 * 存 text / facts 是为了让「同一次运行内」的第二条同事件报道也能算出信息增量
 * （例如 LLM 把同一事件拆成两条必读，第二条需要被识别为重复）。
 */
export function rememberBroadcast(
  store: EventMemoryStore,
  input: {
    cand: MemoryCandidate;
    section: MemorySection;
    date: string;
    angle?: EventAngle;
    novelty?: number;
    /**
     * 播报时刻（ISO 8601 带时区）。**必填、由调用方注入**（2026-09-14 C-3）：
     * 生产由 exec-guard 用 `formatBroadcastAt(input.now)` 计算（now 来自 ctx.startTime），
     * 测试注入固定时刻 —— 服务层不再隐式读系统时钟。
     */
    broadcastAt: string;
  },
): EventMemoryStore {
  const { cand, section, date, angle, novelty, broadcastAt } = input;
  const text = candidateText(cand);
  const sample: BroadcastSample = {
    date,
    section,
    title: cand.title,
    text,
    facts: extractFacts(text),
    // 播报时刻：播报与展示绑定、几乎同时产生，故默认以当前时刻（≈ 报告页面生成时刻）为准。
    // 用于以 9:00 为界区分客户演示数据与测试重跑数据，并支持按时间段筛选/清理。
    // 测试可注入固定时刻（见 input.broadcastAt），避免用例结果随真实时钟漂移。
    broadcastAt,
  };
  if (cand.url) sample.url = cand.url;
  if (cand.score !== undefined) sample.score = cand.score;
  if (novelty !== undefined) sample.novelty = novelty;
  if (angle) sample.angle = angle;

  const prev = store.today && store.today.date === date ? store.today.entries : [];
  // runId 透传（2026-09-03）：runId 由 persistMemory 注入后，同日内的多次
  // rememberBroadcast 不得把它丢掉——否则 beginDay 结算指纹校验
  // （deliverySettlementGate）会因暂存侧缺指纹而退化为「无指纹信任结算」，
  // 拦不住「推送版本 ≠ 落盘版本」的场景。beginDay 推进到新一天时才显式清空。
  const today: { date: string; entries: BroadcastSample[]; runId?: string } = {
    date,
    entries: [...prev, sample],
    ...(store.today?.date === date && store.today.runId ? { runId: store.today.runId } : {}),
  };
  return {
    version: 1,
    updatedAt: date,
    events: store.events ?? {},
    today,
    // 交付记录随库透传：不得在写入链路上丢失（否则 mark-delivered 的记录会被覆盖）
    ...(store.deliveries ? { deliveries: store.deliveries } : {}),
  };
}

/**
 * 记录一次「人工确认交付」——notify workflow 微信推送成功后调用（mark-delivered）。
 *
 * 同日重复推送 → 覆盖 pushedAt（以最后一次成功推送为准）；跨日 → 追加。
 * 返回新 store，不改入参。deliveries 是 beginDay 的结算闸门，见 EventMemoryStore.deliveries。
 */
export function appendDelivery(
  store: EventMemoryStore,
  rec: DeliveryRecord,
): EventMemoryStore {
  const list = store.deliveries ?? [];
  const exists = list.some((d) => d && d.date === rec.date);
  const deliveries = exists
    ? list.map((d) => (d && d.date === rec.date ? rec : d))
    : [...list, rec];
  return { ...store, deliveries };
}

// ---------------------------------------------------------------------------
// 11) IPO 口播去重命名空间（与 events 隔离，2026-09-09）
// ---------------------------------------------------------------------------

/**
 * 记录若干企业今日被口播（追加日期到各自数组，并裁剪超期条目）。
 * 返回新 store，不改入参。受 PUBLISH_RUN 闸门约束的写盘见 store.saveEventMemory。
 */
export function recordIpoVoicing(
  store: EventMemoryStore,
  companies: string[],
  date: string,
): EventMemoryStore {
  if (companies.length === 0) return store;
  const prev = store.ipoVoicing ?? {};
  const next: Record<string, string[]> = {};
  for (const [c, ds] of Object.entries(prev)) {
    const kept = (ds ?? []).filter((d) => diffDays(d, date) <= IPO_VOICE_PRUNE_DAYS);
    if (kept.length > 0) next[c] = kept;
  }
  for (const c of companies) {
    if (!c) continue;
    const arr = next[c] ?? [];
    if (!arr.includes(date)) arr.push(date);
    arr.sort();
    next[c] = arr;
  }
  return { ...store, ipoVoicing: next };
}

/**
 * 该企业今天是否应跳过口播：滚动窗口（最近 IPO_VOICE_WINDOW_DAYS 天，含今天）
 * 内已口播天数 ≥ IPO_VOICE_MAX_IN_WINDOW → 跳过。
 */
export function ipoShouldSkip(
  store: EventMemoryStore,
  company: string,
  today: string,
): boolean {
  const ds = store.ipoVoicing?.[company];
  if (!ds || ds.length === 0) return false;
  const recent = ds.filter((d) => diffDays(d, today) >= 0 && diffDays(d, today) <= IPO_VOICE_WINDOW_DAYS);
  return recent.length >= IPO_VOICE_MAX_IN_WINDOW;
}

/** 简易字符串 hash（事件 id 兜底，无锚点时使用）。 */
function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

// ---------------------------------------------------------------------------
// 10) 记忆库维护
// ---------------------------------------------------------------------------

/**
 * 清理过期事件。
 *
 * 与展示层 2 天窗口不同，记忆库必须活得久（否则「上周播过」无从知晓）；
 * 但也不能无限膨胀。保留策略：
 *  - 最近 retainDays（默认 45）天内播报过的保留；
 *  - 峰值分 ≥ 60 的重大事件额外延长到 retainDays × 2（重大政策值得长期记住）；
 *  - 总量超过 maxEvents（默认 400）时，按 lastBroadcastAt 淘汰最旧的。
 */
