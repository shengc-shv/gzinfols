/**
 * 滚动历史库服务（B3 重写为 gzinfo lib/output/history.ts 同构形状）。
 *
 * 与旧 2.0 版（{date, items[]} 简化形状）的差异：gzinfo 为 Record<url, HistoryEntry>，
 * 含 ai_relevant 条目级相关性 / summary AI 摘要缓存 / subcategory 条目级子标签 /
 * firstSeenAt·lastSeenAt 出现时间——它们是 exec 两天池、滚动并入三态门槛、
 * SKIP_AI prefill 复用、跨天判重的数据基础，缺一不可（功能一致性要求）。
 *
 * 纯函数层（零 fs）；IO 见 lib/adapters/persistence.ts（loadHistoryStore/persistHistoryStore）。
 */

export {
  FETCH_WINDOW_DAYS,
  type HistoryEntry,
  type HistoryStore,
  pruneHistory,
  buildRolling,
  mergeHistory,
  buildSubcatIndex,
} from "./history";
export {
  MEMORY_RETAIN_DAYS,
  reviveEventMemory,
  prepareEventMemory,
  isEventMemoryEnabled,
} from "./store";
export { buildMemoryBrief, formatMemoryBrief } from "./event-memory";
export { applyMemoryGuard } from "./exec-guard";
export { extractReportRunId } from "./publish-run-id";
