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

/**
 * 字符数 → token 的**聚合**换算比（只在「拿不到原文、只有字符数」的场景用，如读历史埋点）。
 *
 * 2026-09-15 校准（Token 优化）：原值 3 是**英文**经验值（cl100k ≈ 4 字符/token），
 * 对中文严重低估——中文（CJK）实际约 1 字符 ≈ 1 token，本项目产出物以中文为主
 * （混少量 ASCII 链接/数字），综合约 1.5 字符 ≈ 1 token。改用它可避免用量账单
 * 失真 2 倍以上，是「先能测准、再谈优化」的前提。
 * 逐条调用有原文时，用下面的 estimateTokens(text) 做更精确的分段估算。
 */
export const CHARS_PER_TOKEN = 1.5;

/** 是否 CJK 字符（含常见全角/中文标点；用于中文感知的 token 估算）。 */
function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3000 && cp <= 0x303f) || // CJK 标点
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // 基本区
    (cp >= 0xf900 && cp <= 0xfaff) || // 兼容表意
    (cp >= 0xff00 && cp <= 0xffef) || // 全角字符
    (cp >= 0x20000 && cp <= 0x2ebef) // 扩展 B~F
  );
}

/**
 * 中文感知的 token 估算（启发式）：CJK ≈ 1 token/字，其余（ASCII/数字/空白）≈ 1 token/4 字符。
 * 与原「字符数/3」相比，中文场景准 2~3 倍。纯函数，供适配器埋点（llm.complete）使用。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (isCjkCodePoint(ch.codePointAt(0) ?? 0)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

/** token 数格式化（1.2M / 34.5K / 789）。 */
export function fmtTokens(chars: number): string {
  const tok = chars / CHARS_PER_TOKEN;
  if (tok >= 1_000_000) return `${(tok / 1_000_000).toFixed(2)}M`;
  if (tok >= 1_000) return `${(tok / 1_000).toFixed(1)}K`;
  return tok.toFixed(0);
}
