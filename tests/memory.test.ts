import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeAgainstHistory, loadHistory, rollingSince, saveHistory } from "../lib/services/memory";
import { createContext } from "../lib/orchestrator";
import type { ArticleInput } from "../lib/contracts/article";
import type { DailyReport, ReportItem } from "../lib/contracts/report";
import type { HistoryStore } from "../lib/services/memory";
import { MemFs, SilentLog } from "./helpers";

const NOW = new Date("2026-09-11T08:00:00Z");

function makeCtx() {
  return createContext({
    date: "2026-09-11",
    mode: { kind: "ai" },
    sources: [],
    log: new SilentLog(),
    startTime: NOW,
  });
}

function articleInput(url: string, publishedAt: Date): ArticleInput {
  return {
    sourceId: "s",
    title: `标题-${url}`,
    url,
    category: "finance",
    publishedAt,
    excerpt: "摘要",
    isIpo: false,
    tier: "T2",
    source: "源",
  } as ArticleInput;
}

function reportItem(url: string): ReportItem {
  return {
    url,
    title_cn: `标题-${url}`,
    source: "源",
    source_type: "media",
    date: "09/11",
    summary: "摘要",
    importance: 2,
    rank: 0,
    tags: [],
    locale: "national",
  };
}

function reportWith(urls: string[]): DailyReport {
  return {
    date: "2026-09-11",
    must_read: [],
    insights: [],
    sections: {
      gz_local: urls.map(reportItem),
      biz_insight: [],
      policy_market: [],
      tech: [],
      ipo: [],
    },
  };
}

test("saveHistory：合并历史 + 真 30 天滚动裁剪（31 天前条目被裁掉）", async () => {
  const fs = new MemFs();
  const ctx = makeCtx();

  const fresh = articleInput("u-fresh", NOW);
  const old = articleInput("u-old", new Date(NOW.getTime() - 31 * 86_400_000));
  await saveHistory(reportWith(["u-fresh", "u-old"]), [fresh, old], ctx, { fs });

  const store = await loadHistory({ fs });
  assert.ok(store.items.some((it) => it.url === "u-fresh"), "界内条目应保留");
  assert.ok(
    store.items.every((it) => it.url !== "u-old"),
    "31 天前的条目应被滚动裁剪剔除",
  );
});

test("saveHistory：与既有历史合并（不丢旧条目）", async () => {
  const fs = new MemFs();
  const ctx = makeCtx();
  // 预置 1 天前的历史条目
  const prev: HistoryStore = {
    date: "2026-09-10",
    items: [{ url: "u-prev", title: "昨日", summary: "", date: "09/10", section: "gz_local", publishedAt: new Date(NOW.getTime() - 86_400_000).toISOString() }],
  };
  await fs.writeJson("data/history.json", prev);

  await saveHistory(reportWith(["u-fresh"]), [articleInput("u-fresh", NOW)], ctx, { fs });
  const store = await loadHistory({ fs });
  assert.ok(store.items.some((it) => it.url === "u-prev"), "旧历史条目应保留");
  assert.ok(store.items.some((it) => it.url === "u-fresh"), "本次条目应写入");
});

test("dedupeAgainstHistory：历史库已有 url 命中被丢弃", () => {
  const ctx = makeCtx();
  const store: HistoryStore = {
    date: "2026-09-10",
    items: [{ url: "u1", title: "", summary: "", date: "09/10", section: "gz_local" }],
  };
  const { kept, dropped } = dedupeAgainstHistory(
    [articleInput("u1", NOW), articleInput("u2", NOW)],
    store,
    ctx,
  );
  assert.equal(dropped, 1);
  assert.deepEqual(kept.map((a) => a.url), ["u2"]);
});

test("rollingSince：publishedAt 缺省且 date 为 MM/DD 的条目视为窗外", () => {
  const store: HistoryStore = {
    date: "2026-09-11",
    items: [
      { url: "iso", title: "", summary: "", date: "09/11", section: "gz_local", publishedAt: new Date(NOW.getTime() - 5 * 86_400_000).toISOString() },
      { url: "mmdd", title: "", summary: "", date: "09/11", section: "gz_local" },
    ],
  };
  const items = rollingSince(store, NOW.toISOString());
  assert.deepEqual(items.map((it) => it.url), ["iso"]);
});
