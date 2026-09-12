/**
 * LLM 调用日志适配器（唯一副作用出口）。
 *
 * - 追加写 `logs/llm-calls.jsonl`（append-only），供 `scripts/quota-report.ts` 统计；
 * - 埋点失败绝不影响 LLM 主流程（全部 try/catch 吞掉）；
 * - 旁路：`LLM_TELEMETRY=off` 关闭写入（回滚 / 降噪用）；
 * - 测试隔离：`setLlmLogDir(tmp)` 可把落盘目录指到临时目录。
 *
 * 移植自 gzinfo `lib/ai/log.ts`；2.0 把 fs 收进适配器层，
 * 错误归类等纯逻辑留在 `services/metrics`。
 */
import fs from "node:fs";
import path from "node:path";
import type { LlmCallRecord } from "../contracts/metrics";

const LOG_REL = path.join("logs", "llm-calls.jsonl");

let overrideDir: string | undefined;

/** 测试用：覆盖日志根目录（传 undefined 还原为 process.cwd()）。 */
export function setLlmLogDir(dir?: string): void {
  overrideDir = dir;
}

function logPath(): string {
  return path.resolve(overrideDir ?? process.cwd(), LOG_REL);
}

/** 埋点总开关（LLM_TELEMETRY=off 关闭）。 */
export function llmTelemetryEnabled(): boolean {
  return process.env.LLM_TELEMETRY !== "off";
}

/** 追加一条调用记录；失败静默（不得影响主流程）。 */
export function logLlmCall(record: LlmCallRecord): void {
  if (!llmTelemetryEnabled()) return;
  try {
    const p = logPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // 埋点失败不得影响 LLM 主流程
  }
}

/** 读取全部调用记录（损坏行跳过；旧记录补 backend 与 errorSnippet 别名）。 */
export function readLlmCallLog(): LlmCallRecord[] {
  const p = logPath();
  if (!fs.existsSync(p)) return [];
  const out: LlmCallRecord[] = [];
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as LlmCallRecord & { stderrSnippet?: string | null };
      // 兼容：早期记录用 stderrSnippet 存错误摘要
      if (!rec.errorSnippet && rec.stderrSnippet) rec.errorSnippet = rec.stderrSnippet;
      if (!rec.backend) rec.backend = "claude-cli";
      out.push(rec);
    } catch {
      // 跳过损坏行
    }
  }
  return out;
}
