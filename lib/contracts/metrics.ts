/**
 * LLM 调用埋点契约（2026-09-12 新增，为 quota-report 提供前置数据源）。
 *
 * 移植自 gzinfo `lib/ai/log.ts`（字符级明细，写 `logs/llm-calls.jsonl`）。
 * 2.0 分层：类型归契约层（零逻辑）；错误归类/聚合等纯函数归 `services/metrics`；
 * 追加写盘归 `adapters/llm-log.ts`（唯一副作用出口）。
 */

/** LLM 失败归类（供 quota-report 区分「额度」与「配置/网络」问题）。 */
export type LlmErrorCategory = "timeout" | "quota" | "auth" | "other" | null;

/** 单次 LLM 调用记录（append-only 日志的一行）。 */
export interface LlmCallRecord {
  /** ISO 时间戳。 */
  ts: string;
  backend: string;
  model: string;
  durationMs: number;
  success: boolean;
  /** 送入的 system + prompt 字符数。 */
  inputChars: number;
  /** 返回文本字符数。 */
  outputChars: number;
  errorCategory: LlmErrorCategory;
  errorSnippet: string | null;
}
