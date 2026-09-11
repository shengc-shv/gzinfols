import { test } from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPipeline } from "../lib/pipeline";
import { createContext } from "../lib/orchestrator";
import { setPersistenceBaseDir } from "../lib/adapters/persistence";
import type { PipelineDeps } from "../lib/contracts/pipeline";
import type { SourceDef } from "../lib/contracts/source";
import { MemFs, FakeHttp, FakeLlm, FakeClock, SilentLog } from "./helpers";

// 固定报告日 —— 本测试必须完全确定性，不得依赖真实时钟。
// ⚠️ 若 pubDate 用 `new Date()`（真实当前时间），跨天后条目会落出 exec summary 的
// 「今天 + 昨天」两天池（窗口 = {报告日, 报告日-1}，按 publishedAt 在报告时区判定）→
// 必读为空 → HTML 不含「今日必读」区 → **每天跨天后本测试必然误红**（非源码 Bug）。
const REPORT_DATE = "2026-09-11";
// 发布时刻与报告日对齐（02:00Z = 北京时间当天 10:00），确保恒落在两日池窗口内；
// 与 tests/pipeline-stock.test.ts 的固定时钟写法保持一致。
const PUB_DATE = new Date(`${REPORT_DATE}T02:00:00Z`);

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>测试频道</title>
<item>
  <title>AI 大模型驱动金融科技升级</title>
  <link>https://example.com/a</link>
  <description>头部机构发布 AI 中台，财富管理数字化效率显著提升。</description>
  <pubDate>${PUB_DATE.toUTCString()}</pubDate>
</item>
</channel></rss>`;

const sources: SourceDef[] = [
  {
    id: "test",
    name: "测试科技源",
    type: "rss",
    url: "https://example.com/feed",
    category: "tech",
    tier: "T1",
    enabled: true,
  },
];

test("runPipeline 端到端（注入内存适配器，不联网/不调真实 LLM）", async () => {
  // 历史库/记忆库落盘走真实 fs（gzinfo 同步语义），注入临时目录做测试隔离
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "gzinfols-e2e-"));
  setPersistenceBaseDir(tmp);
  try {
    await e2eBody();
  } finally {
    setPersistenceBaseDir(undefined);
    fsSync.rmSync(tmp, { recursive: true, force: true });
  }

  async function e2eBody() {
  const fs = new MemFs();
  fs.setJson("sources.config.json", { sources });
  fs.setJson("sources.keywords.json", {
    global_exclude: {},
    dimensions: {},
    opportunity_tracker: {},
    risk_tracker: {},
  });

  const deps: PipelineDeps = {
    fs,
    clock: new FakeClock(),
    llm: new FakeLlm(),
    http: new FakeHttp(RSS),
  };

  const ctx = createContext({
    // 固定报告日 + 固定启动时刻（与 pubDate 同日），彻底消除真实时钟依赖（见文件头注释）。
    // 12:00Z 选在日中，使 UTC / Asia-Shanghai 等时区下日期键都稳落在两日池内。
    date: REPORT_DATE,
    startTime: new Date(`${REPORT_DATE}T12:00:00Z`),
    mode: { kind: "ai" },
    sources,
    log: new SilentLog(),
  });

  const out = await runPipeline(ctx, deps);

  // C2/C3：tech 参考区条目应穿过漏斗并进入 tech 板块
  assert.ok(out.report.sections.tech.length >= 1, "tech 板块应有 ≥1 条");
  // C7：HTML 含中文标题与口播友好的内容
  assert.ok(out.html.includes("AI 大模型驱动金融科技升级"), "HTML 应含条目标题");
  assert.ok(out.html.includes("今日必读"), "HTML 应含必读区");
  // C8：口播稿非空
  assert.ok(out.speech.length > 0, "口播稿应非空");
  // C9：产物路径正确落盘
  assert.ok(out.paths.htmlPath.endsWith(".html"));
  assert.ok((fs.getText(out.paths.htmlPath) ?? "").includes("AI 大模型驱动金融科技升级"));
  // C5：历史库已写入（gzinfo 形状：data/article-history.json，Record<url, HistoryEntry>）
  const histPath = path.join(tmp, "data", "article-history.json");
  assert.ok(fsSync.existsSync(histPath), "article-history.json 应落盘");
  const hist = JSON.parse(fsSync.readFileSync(histPath, "utf8")) as Record<string, { url: string; summary?: string }>;
  assert.ok(Object.keys(hist).length >= 1, "历史库应记录本次条目");
  }
});
