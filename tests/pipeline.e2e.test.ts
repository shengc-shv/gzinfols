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

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>测试频道</title>
<item>
  <title>AI 大模型驱动金融科技升级</title>
  <link>https://example.com/a</link>
  <description>头部机构发布 AI 中台，财富管理数字化效率显著提升。</description>
  <pubDate>${new Date().toUTCString()}</pubDate>
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
    date: "2026-09-11",
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
