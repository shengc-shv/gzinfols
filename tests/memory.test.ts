import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRolling,
  mergeHistory,
  pruneHistory,
  buildSubcatIndex,
  type HistoryEntry,
  type HistoryStore,
} from "../lib/services/memory/history";
import { reviveEventMemory, prepareEventMemory, isEventMemoryEnabled } from "../lib/services/memory/store";
import { extractReportRunId } from "../lib/services/memory/publish-run-id";
import { emptyMemory } from "../lib/services/memory/event-memory";
import type { ArticleInput } from "../lib/contracts/article";

const NOW = new Date("2026-09-11T08:00:00Z");

const article = (url: string, over: Partial<ArticleInput> = {}): ArticleInput =>
  ({
    sourceId: "src-a",
    source: "源A",
    title: `标题 ${url}`,
    url,
    category: "finance",
    publishedAt: new Date("2026-09-11T07:00:00Z"),
    excerpt: "摘要内容",
    isIpo: false,
    ...over,
  }) as ArticleInput;

const entry = (url: string, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  title: `标题 ${url}`,
  url,
  sourceId: "src-a",
  source: "源A",
  category: "finance",
  publishedAt: "2026-09-11T07:00:00Z",
  firstSeenAt: "2026-09-10T20:00:00Z",
  lastSeenAt: "2026-09-11T00:00:00Z",
  ...over,
});

test("pruneHistory：窗口外（2 天前发布）条目被裁剪；无发布时间的条目被剔除（时间红线）", () => {
  const store: HistoryStore = {
    fresh: entry("fresh", { publishedAt: "2026-09-11T01:00:00Z" }),
    yesterday: entry("yesterday", { publishedAt: "2026-09-10T12:00:00Z" }),
    stale: entry("stale", { publishedAt: "2026-09-08T12:00:00Z" }),
    nodate: entry("nodate", { publishedAt: undefined }),
  };
  const pruned = pruneHistory(store, NOW);
  assert.deepEqual(Object.keys(pruned).sort(), ["fresh", "yesterday"]);
});

test("mergeHistory：今日条目并入；ai_relevant 本轮无判定时保留历史打标；summary 不被空覆盖", () => {
  const prev: HistoryStore = {
    "u1": entry("u1", { ai_relevant: false, summary: "历史摘要" }),
  };
  const merged = mergeHistory(
    [article("u1", { relevant: undefined, summary: undefined }), article("u2", { relevant: true, summary: "本轮摘要" })],
    prev,
    "2026-09-11T08:00:00Z",
    buildSubcatIndex([{ id: "src-a", name: "源A", type: "rss", url: "x", category: "finance", subcategory: "gz-wealth" } as never]),
    NOW,
  );
  assert.equal(merged["u1"].ai_relevant, false, "本轮无判定 → 保留历史 ai_relevant=false");
  assert.equal(merged["u1"].summary, "历史摘要", "本轮无摘要 → 保留历史摘要");
  assert.equal(merged["u2"].ai_relevant, true);
  assert.equal(merged["u2"].subcategory, "gz-wealth", "注册表源级 subcategory 兜底");
  assert.ok(merged["u1"].lastSeenAt.startsWith("2026-09-11"));
  assert.ok(merged["u1"].firstSeenAt.startsWith("2026-09-10"), "firstSeenAt 保留");
});

test("buildRolling：URL 冲突今日优先且继承历史 AI 元数据；fetchedToday 标记正确", () => {
  const history: HistoryStore = {
    "u1": entry("u1", {
      ai_relevant: true,
      summary: "历史AI摘要",
      subcategory: "gz-credit",
      lastSeenAt: "2026-09-11T02:00:00Z",
    }),
    "u3": entry("u3", { lastSeenAt: "2026-09-10T02:00:00Z", publishedAt: "2026-09-10T01:00:00Z" }),
  };
  const rolling = buildRolling(
    [article("u1", { relevant: undefined, summary: undefined })],
    history,
    NOW,
  );
  const byUrl = new Map(rolling.map((a) => [a.url, a]));
  assert.equal(byUrl.get("u1")?.fetchedToday, true, "今日条目 fetchedToday=true");
  assert.equal(byUrl.get("u1")?.relevant, true, "继承历史 ai_relevant");
  assert.equal(byUrl.get("u1")?.summary, "历史AI摘要", "本轮无摘要 → 继承");
  assert.equal(byUrl.get("u3")?.fetchedToday, false, "历史条目 fetchedToday=false");
});

test("reviveEventMemory：损坏结构自愈（非对象/缺 events → 空库；损坏记录逐条丢弃）", () => {
  assert.deepEqual(reviveEventMemory(null), emptyMemory());
  assert.deepEqual(reviveEventMemory([1, 2]), emptyMemory());
  assert.deepEqual(reviveEventMemory({ nope: 1 }), emptyMemory());
  const revived = reviveEventMemory({
    version: 1,
    events: {
      ok: {
        id: "e1",
        topicTags: ["住房金融"],
        anchors: ["房贷", "#40"],
        kind: "policy",
        firstBroadcastAt: "2026-09-08",
        lastBroadcastAt: "2026-09-10",
        broadcastCount: 2,
        sections: ["must_read"],
        anglesUsed: ["policy"],
        samples: [],
        broadcastedTexts: [],
        broadcastedFacts: [],
        peakScore: 3,
      },
      bad: { totally: "wrong" },
    },
  });
  assert.deepEqual(Object.keys(revived.events), ["ok"], "损坏记录被丢弃");
});

test("prepareEventMemory：返回清理后的库（不抛错）", () => {
  const store = reviveEventMemory({
    version: 1,
    events: {},
    today: { date: "2026-09-11", entries: [] },
  });
  const cleaned = prepareEventMemory(store, "2026-09-11");
  assert.equal(cleaned.version, 1);
});

test("isEventMemoryEnabled：EVENT_MEMORY=0 关闭", () => {
  const prev = process.env.EVENT_MEMORY;
  try {
    process.env.EVENT_MEMORY = "0";
    assert.equal(isEventMemoryEnabled(), false);
    delete process.env.EVENT_MEMORY;
    assert.equal(isEventMemoryEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.EVENT_MEMORY;
    else process.env.EVENT_MEMORY = prev;
  }
});

test("extractReportRunId：gh-pages commit message 提取 run id（gzinfo 2026-09-05 修复语义）", () => {
  assert.equal(extractReportRunId("daily: report for 12345678 abcdef"), "12345678");
  assert.equal(extractReportRunId("no match here"), undefined);
  assert.equal(extractReportRunId(undefined), undefined);
});
