/**
 * LLM 用量统计（纯函数）。
 *
 * 上游数据来自 `lib/adapters/llm-log.ts` 写入的 `logs/llm-calls.jsonl`；
 * 本模块只做**无副作用**的归类与聚合，供 `scripts/quota-report.ts` 输出报表。
 *
 * 移植自 gzinfo `lib/ai/log.ts` 的 classifyError + `scripts/quota-report.ts` 的统计段。
 * 所有需要「当前时间」的函数都要求显式传入 `now`（服务层禁止隐式时钟）。
 */
import type { LlmCallRecord, LlmErrorCategory } from "../../contracts/metrics";

const QUOTA_PATTERN =
  /(rate.?limit|usage.?limit|quota|429|too many requests|credit.?balance|insufficient.?balance)/i;

const AUTH_PATTERN = /(401|403|unauthorized|invalid.?api.?key|authentication|forbidden)/i;

/**
 * 把错误信息归类。判定顺序固定：超时 → 额度 → 鉴权 → 其他。
 * 空串返回 null（表示无错误）。
 */
export function classifyError(blob: string): LlmErrorCategory {
  if (!blob.trim()) return null;
  if (/timeout|timed out|etimedout/i.test(blob)) return "timeout";
  if (QUOTA_PATTERN.test(blob)) return "quota";
  if (AUTH_PATTERN.test(blob)) return "auth";
  return "other";
}

/** 每次调用的错误分类（成功恒为 null）。 */
export function errorCategoryOf(c: LlmCallRecord): LlmErrorCategory {
  return c.success ? null : (c.errorCategory ?? "other");
}

/** 累计输入/输出字符数。 */
export function sumChars(
  calls: LlmCallRecord[],
): { input: number; output: number } {
  return calls.reduce(
    (acc, c) => {
      acc.input += c.inputChars;
      acc.output += c.outputChars;
      return acc;
    },
    { input: 0, output: 0 },
  );
}

/** 取最近 N 小时内的调用（按 ts 过滤）。 */
export function withinHours(
  calls: LlmCallRecord[],
  now: number,
  hours: number,
): LlmCallRecord[] {
  const since = now - hours * 3_600_000;
  return calls.filter((c) => {
    const t = new Date(c.ts).getTime();
    return Number.isFinite(t) && t >= since;
  });
}

/** 取最近 N 个自然日内的调用（按 ts 过滤）。 */
export function withinDays(
  calls: LlmCallRecord[],
  now: number,
  days: number,
): LlmCallRecord[] {
  return withinHours(calls, now, days * 24);
}

/** 按后端分组（保留首次出现顺序）。 */
export function groupByBackend(calls: LlmCallRecord[]): Map<string, LlmCallRecord[]> {
  const out = new Map<string, LlmCallRecord[]>();
  for (const c of calls) {
    const key = c.backend || "unknown";
    const arr = out.get(key);
    if (arr) arr.push(c);
    else out.set(key, [c]);
  }
  return out;
}

export interface BackendSummary {
  backend: string;
  calls: number;
  failures: number;
  inputChars: number;
  outputChars: number;
  /** 平均耗时（毫秒；无调用为 0）。 */
  avgDurationMs: number;
  /** 各错误分类计数（仅失败项）。 */
  errors: Record<string, number>;
}

/** 汇总一组调用：次数 / 失败数 / 字符量 / 平均耗时 / 错误分类。 */
export function summarize(calls: LlmCallRecord[]): BackendSummary[] {
  const groups = groupByBackend(calls);
  const out: BackendSummary[] = [];
  for (const [backend, list] of groups) {
    const { input, output } = sumChars(list);
    const failures = list.filter((c) => !c.success);
    const errors: Record<string, number> = {};
    for (const f of failures) {
      const cat = errorCategoryOf(f) ?? "other";
      errors[cat] = (errors[cat] ?? 0) + 1;
    }
    const totalMs = list.reduce((n, c) => n + (c.durationMs || 0), 0);
    out.push({
      backend,
      calls: list.length,
      failures: failures.length,
      inputChars: input,
      outputChars: output,
      avgDurationMs: list.length ? Math.round(totalMs / list.length) : 0,
      errors,
    });
  }
  return out.sort((a, b) => b.calls - a.calls);
}

/** 字符数 → token 估算（gzinfo 口径：3 字符 ≈ 1 token）。 */
export const CHARS_PER_TOKEN = 3;

/** token 数格式化（1.2M / 34.5K / 789）。 */
export function fmtTokens(chars: number): string {
  const tok = chars / CHARS_PER_TOKEN;
  if (tok >= 1_000_000) return `${(tok / 1_000_000).toFixed(2)}M`;
  if (tok >= 1_000) return `${(tok / 1_000).toFixed(1)}K`;
  return tok.toFixed(0);
}
