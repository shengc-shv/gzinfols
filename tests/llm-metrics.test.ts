/**
 * LLM 埋点与用量统计（2026-09-12 新增，quota-report 的前置模块）。
 *
 * 覆盖：错误归类、时间窗口过滤、按后端汇总、以及落盘往返（含开关与损坏行容错）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyError, fmtTokens, groupByBackend, sumChars, summarize, withinDays, withinHours } from "../lib/services/metrics";
import { loadStageCalls, logLlmCall, readLlmCallLog, recordAiCall, setLlmLogDir } from "../lib/adapters/llm-log";
import type { AiCallMetric } from "../lib/contracts/metrics";
import type { LlmCallRecord } from "../lib/contracts/metrics";

function rec(over: Partial<LlmCallRecord> = {}): LlmCallRecord {
  return {
    ts: "2026-09-12T10:00:00+08:00",
    backend: "deepseek",
    model: "deepseek-chat",
    durationMs: 1200,
    success: true,
    inputChars: 3000,
    outputChars: 900,
    errorCategory: null,
    errorSnippet: null,
    ...over,
  };
}

test("classifyError：超时 / 额度 / 鉴权 / 其它 / 空", () => {
  assert.equal(classifyError(""), null);
  assert.equal(classifyError("request timed out"), "timeout");
  assert.equal(classifyError("ETIMEDOUT"), "timeout");
  assert.equal(classifyError("429 Too Many Requests"), "quota");
  assert.equal(classifyError("insufficient balance"), "quota");
  assert.equal(classifyError("401 unauthorized"), "auth");
  assert.equal(classifyError("invalid api key"), "auth");
  assert.equal(classifyError("something exploded"), "other");
  // 判定优先级：同时命中超时与额度时按超时算
  assert.equal(classifyError("timeout and quota"), "timeout");
});

test("统计：时间窗口 / 字符累计 / 按后端分组 / 汇总", () => {
  const now = new Date("2026-09-12T12:00:00+08:00").getTime();
  const calls = [
    rec({ ts: "2026-09-12T11:00:00+08:00", backend: "deepseek" }), // 1h 前
    rec({ ts: "2026-09-12T02:00:00+08:00", backend: "deepseek" }), // 10h 前
    rec({ ts: "2026-09-10T02:00:00+08:00", backend: "claude-cli", durationMs: 3000 }), // 2 天前
    rec({ ts: "2026-09-12T11:30:00+08:00", backend: "claude-cli", success: false, errorCategory: "quota" }),
  ];
  assert.equal(withinHours(calls, now, 5).length, 2, "5 小时内应有 2 条");
  assert.equal(withinDays(calls, now, 1).length, 3, "24 小时内应有 3 条");
  assert.equal(withinDays(calls, now, 7).length, 4);

  const s = sumChars(calls);
  assert.equal(s.input, 3000 * 4);
  assert.equal(s.output, 900 * 4);

  const groups = groupByBackend(calls);
  assert.deepEqual([...groups.keys()].sort(), ["claude-cli", "deepseek"]);

  const sum = summarize(calls);
  const ds = sum.find((x) => x.backend === "deepseek")!;
  const cc = sum.find((x) => x.backend === "claude-cli")!;
  assert.equal(ds.calls, 2);
  assert.equal(ds.failures, 0);
  assert.equal(cc.calls, 2);
  assert.equal(cc.failures, 1);
  assert.deepEqual(cc.errors, { quota: 1 });
  assert.equal(cc.avgDurationMs, Math.round((3000 + 1200) / 2));
});

test("fmtTokens：3 字符 ≈ 1 token", () => {
  assert.equal(fmtTokens(300), "100");
  assert.equal(fmtTokens(30_000), "10.0K");
  assert.equal(fmtTokens(6_000_000), "2.00M");
});

test("落盘往返：写入 → 读回（含开关与损坏行）", () => {
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "llm-log-"));
  setLlmLogDir(tmp);
  try {
    assert.deepEqual(readLlmCallLog(), [], "空目录应返回空数组");
    logLlmCall(rec());
    logLlmCall(rec({ backend: "claude-cli", success: false, errorCategory: "auth", errorSnippet: "401" }));

    const all = readLlmCallLog();
    assert.equal(all.length, 2);
    assert.equal(all[0].backend, "deepseek");
    assert.equal(all[1].errorCategory, "auth");

    // 追加一条损坏行：读取应跳过而非抛错
    const p = path.join(tmp, "logs", "llm-calls.jsonl");
    fsSync.appendFileSync(p, "{not-json}\n", "utf8");
    assert.equal(readLlmCallLog().length, 2, "损坏行应被跳过");

    // 关掉埋点后不再写入
    const prev = process.env.LLM_TELEMETRY;
    try {
      process.env.LLM_TELEMETRY = "off";
      logLlmCall(rec({ backend: "openai" }));
      assert.equal(readLlmCallLog().length, 2, "LLM_TELEMETRY=off 时不应写入");
    } finally {
      if (prev === undefined) delete process.env.LLM_TELEMETRY;
      else process.env.LLM_TELEMETRY = prev;
    }
  } finally {
    setLlmLogDir(undefined);
    fsSync.rmSync(tmp, { recursive: true, force: true });
  }
});


test("stage 层：recordAiCall 落盘按日文件 + loadStageCalls 读回（含损坏行容错）", () => {
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "stage-metrics-"));
  setLlmLogDir(tmp);
  try {
    assert.deepEqual(loadStageCalls(), []); // 空目录
    const m = (over: Partial<AiCallMetric> = {}): AiCallMetric => ({
      ts: "2026-09-14T10:00:00+08:00",
      date: "2026-09-14",
      backend: "deepseek",
      stage: "pass1",
      ok: true,
      ms: 800,
      tokens: 0,
      modelTag: "deepseek-chat",
      ...over,
    });
    recordAiCall(m());
    recordAiCall(m({ stage: "pass2", ok: false, ms: 1200 }));
    fsSync.appendFileSync(path.join(tmp, "data", "metrics", "ai-calls-2026-09-14.jsonl"), "{broken}\n", "utf8");
    const calls = loadStageCalls();
    assert.equal(calls.length, 2, "损坏行应被跳过");
    assert.equal(calls.filter((c) => c.stage === "pass1").length, 1);
    assert.equal(loadStageCalls("2026-09-14").length, 2, "按日过滤");

    // LLM_TELEMETRY=off 一并关闭 stage 层
    const prev = process.env.LLM_TELEMETRY;
    try {
      process.env.LLM_TELEMETRY = "off";
      recordAiCall(m({ stage: "executive" }));
      assert.equal(loadStageCalls().length, 2, "off 时不应写入");
    } finally {
      if (prev === undefined) delete process.env.LLM_TELEMETRY; else process.env.LLM_TELEMETRY = prev;
    }
  } finally {
    setLlmLogDir(undefined);
    fsSync.rmSync(tmp, { recursive: true, force: true });
  }
});
