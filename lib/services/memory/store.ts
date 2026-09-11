/**
 * 内容记忆库「解析/清洗」纯逻辑层（自 gzinfo lib/memory/store.ts 移植，IO 拆至 adapters）。
 *
 * 落盘位置：`data/event-memory.json`（随 CI 归档提交回 main，跨运行生效）。
 * 与 data/article-history.json 的区别：
 *  - article-history 存「抓过哪些条目」，按 publishedAt 保留 2 天（展示窗口）；
 *  - event-memory 存「播过哪些事件」，按 lastBroadcastAt 保留 45 天（记忆窗口）。
 *  两者生命周期不同，必须分开，不能复用历史库（否则会被 2 天 prune 清空）。
 */

import {
  emptyMemory,
  pruneMemory,
  sanitizeEvents,
  type BroadcastSample,
  type DeliveryRecord,
  type EventMemoryStore,
  type EventRecord,
} from "./event-memory";

/** 记忆保留天数（默认 45 天；重大事件自动翻倍）。 */
export const MEMORY_RETAIN_DAYS = 45;

/** today 暂存区 / 交付记录 / IPO 口播去重命名空间的读取清洗（gzinfo loadEventMemory 主体）。 */
export function reviveEventMemory(raw: unknown): EventMemoryStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyMemory();
  const r = raw as Record<string, unknown>;
  const events = r.events;
  if (!events || typeof events !== "object") return emptyMemory();
  // today 暂存区必须随文件读回：若丢失，昨天播报永远结算不进长期记忆
  // （beginDay 依赖 store.today 做跨天结算），冷却机制将整体失效。
  const t = r.today as { date?: unknown; entries?: unknown; runId?: unknown } | undefined;
  const today =
    t && typeof t === "object" && typeof t.date === "string" && Array.isArray(t.entries)
      ? {
          date: t.date,
          entries: t.entries as BroadcastSample[],
          // runId（暂存区落盘 run，结算指纹校验用）：非 string（损坏/脏值）则丢弃
          ...(typeof t.runId === "string" ? { runId: t.runId as string } : {}),
        }
      : undefined;
  // 交付记录随库读回（beginDay 结算闸门依赖它）：损坏（非数组 / 条目缺 date）逐条丢弃，
  // 至少保留结构完整者；缺失 → undefined 按「无交付」处理（与旧文件兼容）。
  const dl = r.deliveries;
  const deliveries = Array.isArray(dl)
    ? (dl.filter(
        (d: unknown) => !!d && typeof d === "object" && typeof (d as { date?: unknown }).date === "string",
      ) as DeliveryRecord[])
    : undefined;
  // IPO 口播去重命名空间（gzinfo 2026-09-09）：企业名 → 已口播日期数组；损坏（非对象 /
  // 值非数组）逐条丢弃，至少保留结构完整者，不影响 events / deliveries 读取。
  const ivRaw = r.ipoVoicing;
  const ipoVoicing: Record<string, string[]> | undefined =
    ivRaw && typeof ivRaw === "object" && !Array.isArray(ivRaw)
      ? Object.fromEntries(
          Object.entries(ivRaw as Record<string, unknown>)
            .filter(
              ([, v]) => Array.isArray(v) && (v as unknown[]).every((x) => typeof x === "string"),
            )
            .map(([k, v]) => [k, v as string[]]),
        )
      : undefined;
  return {
    version: 1,
    updatedAt: r.updatedAt as string | undefined,
    // 结构损坏的记录在此丢弃（而非让后续匹配抛错）→ 下次 saveEventMemory
    // 落盘的是清洗后的库 → 损坏不再写回，实现**自愈**。
    events: sanitizeEvents(events as Record<string, EventRecord>),
    ...(today ? { today } : {}),
    ...(deliveries ? { deliveries } : {}),
    ...(ipoVoicing && Object.keys(ipoVoicing).length > 0 ? { ipoVoicing } : {}),
  };
}

/** 写盘前清理（gzinfo saveEventMemory 的 prune 部分；返回 cleaned，由 adapters 落盘）。 */
export function prepareEventMemory(
  store: EventMemoryStore,
  today: string,
  retainDays: number = MEMORY_RETAIN_DAYS,
): EventMemoryStore {
  return pruneMemory(store, today, { retainDays });
}

/**
 * 记忆层总开关（EVENT_MEMORY=0 关闭，便于回滚与 A/B 对比）。
 *
 * 开关值由组合根注入 `ctx.config.eventMemory`（`PipelineConfig`），服务层不直读 env：
 * 需判断时直接读 `ctx.config.eventMemory`，无需再经本函数。
 */
