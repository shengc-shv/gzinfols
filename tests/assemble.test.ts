import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleReport } from "../lib/services/assemble";
import { createContext } from "../lib/orchestrator";
import type { DailyReport, ReportItem } from "../lib/contracts/report";
import { SilentLog } from "./helpers";

function ctx() {
  return createContext({
    date: "2026-09-11",
    mode: { kind: "ai" },
    sources: [],
    log: new SilentLog(),
    config: { windowDays: 2, maxPerSection: 18, maxPerSourcePerSection: 4 },
  });
}

function item(title: string, over: Partial<ReportItem> = {}): ReportItem {
  return {
    url: `https://example.com/${encodeURIComponent(title)}`,
    title_cn: title,
    source: "源",
    source_type: "official",
    date: "09/11",
    summary: "摘要内容",
    importance: 2,
    rank: 0,
    tags: [],
    locale: "national",
    tier: "T1",
    ...over,
  };
}

function emptyReport(): DailyReport {
  return {
    date: "2026-09-11",
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  };
}

test("排序：importance 优先，同 importance 按 tier 降序", () => {
  const report = emptyReport();
  report.sections.policy_market = [
    item("甲一档", { importance: 1, tier: "T1" }),
    item("乙三档", { importance: 3, tier: "T2" }),
    item("丙二档T1", { importance: 2, tier: "T1" }),
    item("丁二档T2", { importance: 2, tier: "T2" }),
  ];
  const out = assembleReport(report, ctx());
  assert.deepEqual(
    out.sections.policy_market.map((i) => i.title_cn),
    ["乙三档", "丙二档T1", "丁二档T2", "甲一档"],
  );
  assert.deepEqual(
    out.sections.policy_market.map((i) => i.rank),
    [1, 2, 3, 4],
  );
});

test("单源配额：同一来源最多保留 maxPerSourcePerSection 条", () => {
  const report = emptyReport();
  report.sections.gz_local = Array.from({ length: 6 }, (_, i) =>
    item(`同源第${i + 1}`, { source: "单一来源", importance: 3 }),
  );
  const out = assembleReport(report, ctx());
  assert.equal(out.sections.gz_local.length, 4, "6 条同源应只留 4 条");
  assert.ok(out.sections.gz_local.every((i) => i.source === "单一来源"));
});

test("must_read 恒空：gzinfo 语义下 assemble 不兜底（必读由 side-outputs 旁路产出）", () => {
  const report = emptyReport();
  report.sections.gz_local = [item("广州头条")];
  const out = assembleReport(report, ctx());
  assert.deepEqual(out.must_read, [], "assemble 不再生成兜底必读");
});

test("must_read 已有值时：不覆盖，原样保留", () => {
  const report = emptyReport();
  report.must_read = [{ url: "https://example.com/mr", why: "AI 选定" }];
  report.sections.gz_local = [item("广州头条")];
  const out = assembleReport(report, ctx());
  assert.deepEqual(out.must_read, [{ url: "https://example.com/mr", why: "AI 选定" }]);
});
