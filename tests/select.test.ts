import { test } from "node:test";
import assert from "node:assert/strict";
import { select } from "../lib/services/select";
import { createContext } from "../lib/orchestrator";
import type { SourceDef } from "../lib/contracts/source";
import type { ArticleInput } from "../lib/contracts/article";
import { MemFs, SilentLog } from "./helpers";

const sources: SourceDef[] = [
  { id: "s1", name: "源一", type: "rss", url: "https://example.com/1", category: "finance", tier: "T1" },
  { id: "s2", name: "源二", type: "rss", url: "https://example.com/2", category: "finance", tier: "T2" },
];

const KEYWORDS = { global_exclude: {}, dimensions: {}, opportunity_tracker: {}, risk_tracker: {} };

function article(over: Partial<ArticleInput>): ArticleInput {
  return {
    sourceId: "s1",
    title: "普通财经新闻标题",
    url: "u",
    category: "finance",
    publishedAt: new Date("2026-09-11T08:00:00Z"),
    excerpt: "摘要",
    isIpo: false,
    tier: "T2",
    source: "源一",
    ...over,
  } as ArticleInput;
}

function makeCtx(over: { startTime?: Date; windowDays?: number } = {}) {
  return createContext({
    date: "2026-09-11",
    mode: { kind: "ai" },
    sources,
    log: new SilentLog(),
    startTime: over.startTime ?? new Date("2026-09-11T08:00:00Z"),
    config: { windowDays: over.windowDays ?? 2 },
  });
}

async function runSelect(articles: ArticleInput[], ctx: ReturnType<typeof makeCtx>) {
  const fs = new MemFs();
  fs.setJson("sources.keywords.json", KEYWORDS);
  return select(articles, ctx, { fs });
}

test("窗口过滤：注入 startTime 与 config.windowDays，窗外条目被丢弃", async () => {
  const now = new Date("2026-09-11T08:00:00Z");
  const inWindow = article({ url: "in", publishedAt: new Date(now.getTime() - 86_400_000) });
  const outOfWindow = article({
    url: "out",
    publishedAt: new Date(now.getTime() - 10 * 86_400_000),
  });
  const r = await runSelect([inWindow, outOfWindow], makeCtx({ startTime: now, windowDays: 2 }));
  assert.deepEqual(r.articles.map((a) => a.url), ["in"]);
});

test("窗口边界：恰好 windowDays+1 天的条目仍在界内（含边界）", async () => {
  const now = new Date("2026-09-11T08:00:00Z");
  const edge = article({ url: "edge", publishedAt: new Date(now.getTime() - 3 * 86_400_000) });
  const r = await runSelect([edge], makeCtx({ startTime: now, windowDays: 2 }));
  assert.equal(r.articles.length, 1);
});

test("参考区豁免：tech 条目无维度命中仍放行", async () => {
  const tech = article({ url: "t", category: "tech", title: "一项普通科技动态" });
  const r = await runSelect([tech], makeCtx());
  assert.equal(r.articles.length, 1);
  assert.equal(r.filterResults.get("t")?.pass, true);
});

test("scoreValue 排序：T1 源条目优先于 T2 源条目", async () => {
  const t1 = article({ url: "a", tier: "T1", sourceId: "s1" });
  const t2 = article({ url: "b", tier: "T2", sourceId: "s2" });
  const r = await runSelect([t2, t1], makeCtx());
  assert.deepEqual(r.articles.map((a) => a.url), ["a", "b"]);
});
