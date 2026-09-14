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

/* ───────── stage 层埋点（gzinfo lib/ai/metrics.ts 移植，2026-09-14）───────── */

/** 业务阶段（gzinfo ai/mode.ts AiStage 逐字；credentials 阶段不适用 2.0 校验函数故不列）。 */
export type AiStage =
  | "enrich" // 富集摘要（GitHub/X/论文/finance/politics/gd-ipo）
  | "classify" // 条目级 LLM 分类
  | "executive" // 执行摘要
  | "stock-recap" // 股市解读三卡
  | "stock-news" // 股市消息清单逐条归纳
  | "trading" // 交易点评
  | "pass1" // 两阶段管线：PASS1 筛选分类
  | "pass2" // 两阶段管线：PASS2 总编辑成稿
  | "other";

/** 阶段维度调用计数（append-only，按日一份 data/metrics/ai-calls-<date>.jsonl）。 */
export interface AiCallMetric {
  ts: string;
  /** 北京时间日历日键（报告时区口径）。 */
  date: string;
  backend: string;
  stage: AiStage;
  ok: boolean;
  ms: number;
  /** token 估算：claude-cli（Max 订阅）无计量恒 0；API 后端按 3 字符≈1token 估算。 */
  tokens: number;
  modelTag: string;
}
