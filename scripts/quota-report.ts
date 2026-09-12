/**
 * LLM 用量报表（移植自 gzinfo scripts/quota-report.ts，按 2.0 分层重写）。
 *
 * 数据源：`logs/llm-calls.jsonl`（由 `lib/adapters/llm.ts` 在每次 complete() 出口埋点写入，
 * 见 `lib/adapters/llm-log.ts`）。统计口径：
 *   - claude-cli（Max 订阅）：看**5 小时滚动窗口**（那才是真实限流单位）；
 *   - API 后端（anthropic / openai / deepseek）：看**最近 24 小时**（按 token 计费）。
 *
 * 2.0 适配：
 *  - IO 归 `adapters/llm-log.ts`，聚合/归类归 `services/metrics`（纯函数）；
 *  - **时间一律北京时间**（硬性规定，`fmtTime` 用 REPORT_TZ 格式化，不落系统时区）；
 *  - 不再读 gzinfo 的 `data/metrics/*`（2.0 无该层），按日汇总改由本脚本从调用日志推导。
 *
 * Usage:
 *   npm run quota-report
 */
import { readLlmCallLog, setLlmLogDir } from "../lib/adapters/llm-log";
import {
  CHARS_PER_TOKEN,
  fmtTokens,
  groupByBackend,
  sumChars,
  summarize,
  withinDays,
  withinHours,
} from "../lib/services/metrics";
import type { LlmCallRecord } from "../lib/contracts/metrics";
import { REPORT_TZ } from "../lib/utils/time";

/** 北京时间格式化（硬性规定：全项目只认 Asia/Shanghai）。 */
function fmtTime(ts: string): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${p(Number(get("hour")))}:${get("minute")}`;
}

/** 取 ts 的北京日历日键（YYYY-MM-DD）。 */
function dayKey(ts: string): string {
  return fmtTime(ts).slice(0, 10);
}

function bar(value: number, max: number, width = 24): string {
  const ratio = Math.min(1, value / max);
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** claude-cli：Max 订阅按 5 小时滚动窗口扣额。 */
function reportClaudeCli(calls: LlmCallRecord[], now: number) {
  const recent5h = withinHours(calls, now, 5);
  const w5 = sumChars(recent5h);
  const SOFT_CAP_TOK = 1_000_000;

  console.log("■ 当前 5 小时滚动窗口 (Max 订阅扣额单位)");
  console.log(`  调用次数:        ${recent5h.length}`);
  console.log(
    `  累计 input:      ${fmtTokens(w5.input).padStart(7)}  ${bar(w5.input / CHARS_PER_TOKEN, SOFT_CAP_TOK)}  / ~1M 软上限`,
  );
  console.log(`  累计 output:     ${fmtTokens(w5.output).padStart(7)}`);
  const ratio = w5.input / CHARS_PER_TOKEN / SOFT_CAP_TOK;
  if (ratio > 0.7) console.log("  ⚠ 已超过软上限 70%，再跑大任务可能会撞 quota");
  else if (ratio > 0.4) console.log("  ⚪ 处于中段，还有余量");
  else console.log("  ✓ 余量充足");
}

/** API 后端：按 token 计费，看最近 24 小时。 */
function reportApiBackend(backend: string, calls: LlmCallRecord[], now: number) {
  const recent24h = withinHours(calls, now, 24);
  const w24 = sumChars(recent24h);
  console.log("■ 最近 24 小时 (按 token 计费)");
  console.log(`  调用次数:        ${recent24h.length}`);
  console.log(`  累计 input:      ${fmtTokens(w24.input)}`);
  console.log(`  累计 output:     ${fmtTokens(w24.output)}`);
  console.log(`  注：精确 token / 费用请去 ${backend} 控制台核对`);
}

function reportByDay(calls: LlmCallRecord[], now: number) {
  const recent7d = withinDays(calls, now, 7);
  if (recent7d.length === 0) return;
  console.log("");
  console.log("■ 按日汇总（最近 7 天，北京时间）");
  const byDay = new Map<string, { n: number; ok: number; ms: number }>();
  for (const c of recent7d) {
    const k = dayKey(c.ts);
    const e = byDay.get(k) ?? { n: 0, ok: 0, ms: 0 };
    e.n++;
    if (c.success) e.ok++;
    e.ms += c.durationMs || 0;
    byDay.set(k, e);
  }
  for (const [day, e] of [...byDay.entries()].sort()) {
    const rate = e.n ? Math.round((e.ok / e.n) * 100) : 0;
    console.log(
      `  ${day}  ${String(e.n).padStart(4)} 次  ok ${String(rate).padStart(3)}%  累计 ${(e.ms / 1000).toFixed(1)}s`,
    );
  }
}

function main() {
  // 允许用 LLM_CALLS_DIR 指向别的埋点目录（分析历史归档用）
  if (process.env.LLM_CALLS_DIR) setLlmLogDir(process.env.LLM_CALLS_DIR);
  const calls = readLlmCallLog();
  if (calls.length === 0) {
    console.log("没有调用记录。先跑一次 `npm run daily` 或任何会调 LLM 的命令。");
    return;
  }
  const now = Date.now();

  console.log("");
  console.log(`=== LLM usage（logs/llm-calls.jsonl，共 ${calls.length} 条）===`);

  const byBackend = groupByBackend(calls);
  for (const [backend, list] of [...byBackend.entries()].sort()) {
    console.log("");
    console.log(`──── backend: ${backend}  (${list.length} 次) ────`);
    console.log("");
    if (backend === "claude-cli") reportClaudeCli(list, now);
    else reportApiBackend(backend, list, now);

    const failures = list.filter((c) => !c.success);
    if (failures.length > 0) {
      const quota = failures.filter((c) => c.errorCategory === "quota").length;
      const timeout = failures.filter((c) => c.errorCategory === "timeout").length;
      const auth = failures.filter((c) => c.errorCategory === "auth").length;
      const other = failures.length - quota - timeout - auth;
      console.log("");
      console.log(
        `  失败 ${failures.length}: quota ${quota} · timeout ${timeout} · auth ${auth} · 其它 ${other}`,
      );
      for (const f of failures.slice(-3)) {
        console.log(
          `    ${fmtTime(f.ts)}  ${f.errorCategory ?? "?"}  ${(f.errorSnippet ?? "").slice(0, 80)}`,
        );
      }
    }
  }

  console.log("");
  console.log("■ 各后端汇总（全部记录）");
  for (const s of summarize(calls)) {
    console.log(
      `  ${s.backend.padEnd(12)} ${String(s.calls).padStart(4)} 次  失败 ${String(s.failures).padStart(3)}` +
        `  平均 ${(s.avgDurationMs / 1000).toFixed(1)}s  in ${fmtTokens(s.inputChars)} / out ${fmtTokens(s.outputChars)}`,
    );
  }

  console.log("");
  console.log("■ 最近 10 次调用 (全部 backend)");
  for (const c of calls.slice(-10)) {
    const status = c.success ? "✓" : `✗ ${c.errorCategory ?? "?"}`;
    console.log(
      `  ${fmtTime(c.ts)}  ${c.backend.padEnd(11)} ${status.padEnd(10)} ${(c.durationMs / 1000).toFixed(1).padStart(5)}s  ` +
        `${String(c.inputChars).padStart(6)} → ${String(c.outputChars).padStart(5)}`,
    );
  }

  reportByDay(calls, now);
  console.log("");
}

main();
