/**
 * ⑦ 展示限额（gzinfo lib/pipeline/display-cap.ts 移植，2026-09-13 补齐 B3 缺口）。
 *
 * 覆盖：每源 ≤4 按价值排序、板块总量上限、gz 保底（不足 3 条从 biz/policy 移入
 * locale=gz 条目且未选中者放回）、stock_news 每市场 ≤5、以及不 mutate 入参。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDisplayCaps } from "../lib/services/assemble/display-cap";
import type { DailyReport, ReportItem } from "../lib/contracts/report";
import { SilentLog } from "./helpers";

function item(over: Partial<ReportItem> & { url: string }): ReportItem {
  return {
    title_cn: over.url,
    title_orig: "",
    source: "源A",
    source_type: "media" as const,
    date: "09/13",
    summary: "摘要。",
    importance: 2 as const,
    rank: 1,
    tags: [],
    locale: "national" as const,
    ...over,
  };
}

function mkReport(sections: Record<string, ReportItem[]>, stockNews?: ReportItem[] extends never ? never : any[]): DailyReport {
  return {
    date: "2026-09-13",
    hero_line: "",
    must_read: [],
    insights: [],
    sections: {
      gz_local: [],
      biz_insight: [],
      policy_market: [],
      tech: [],
      ipo: [],
      ...sections,
    },
    ...(stockNews ? { stock_news: stockNews } : {}),
  } as DailyReport;
}

const ctx = { log: new SilentLog() } as any;

test("每源 ≤4：同源 6 条只留 4 条（按价值排序），板块总量 ≤ 上限", () => {
  const six = [1, 2, 3, 4, 5, 6].map((i) =>
    item({ url: `u${i}`, source: "源A", importance: (i > 3 ? 3 : 1) as 1 | 2 | 3 }),
  );
  const r = mkReport({ gz_local: six });
  const out = applyDisplayCaps(r, ctx);
  assert.ok(out.sections.gz_local.length <= 10, "板块总量 ≤ 10");
  const fromA = out.sections.gz_local.filter((i) => i.source === "源A");
  assert.ok(fromA.length <= 4, `每源 ≤4，实际 ${fromA.length}`);
  // 价值排序：3 条 importance=3 的必须全部保留（第 4 席给次优）
  assert.equal(fromA.filter((i) => i.importance === 3).length, 3, "价值最高的 3 条应全部保留");
});

test("gz 保底：gz 不足 3 条时从 biz/policy 移入 locale=gz 条目，未选中者放回原板块", () => {
  const gz = [item({ url: "g1", locale: "gz" as const })];
  const biz = [
    item({ url: "b-gz1", locale: "gz" as const, importance: 3 as const }),
    item({ url: "b-gz2", locale: "gz" as const, importance: 1 as const }),
    item({ url: "b-nat", locale: "national" as const }),
  ];
  const policy = [item({ url: "p-gz1", locale: "gz" as const, source: "源B" })];
  const r = mkReport({ gz_local: gz, biz_insight: biz, policy_market: policy });
  const out = applyDisplayCaps(r, ctx);
  assert.ok(out.sections.gz_local.length >= 3, `gz 应补足到 3，实际 ${out.sections.gz_local.length}`);
  // 价值最高的 b-gz1（importance=3）应被移入
  assert.ok(
    out.sections.gz_local.some((i) => i.url === "b-gz1"),
    "价值最高的 gz 候选应移入 gz 板块",
  );
  // 未选中的候选必须放回原板块（不得丢失）
  assert.ok(
    out.sections.biz_insight.some((i) => i.url === "b-nat"),
    "非 gz 条目应留在原板块",
  );
  assert.ok(
    out.sections.biz_insight.some((i) => i.url === "b-gz2") ||
      out.sections.policy_market.some((i) => i.url === "p-gz1") ||
      out.sections.gz_local.some((i) => i.url === "b-gz2"),
    "未选中的 gz 候选应放回原板块（宁缺毋滥，不丢失）",
  );
});

test("宁缺毋滥：无 locale=gz 候选时不补，也绝不引入不相关条目", () => {
  const r = mkReport({
    gz_local: [item({ url: "g1", locale: "national" as const })],
    biz_insight: [item({ url: "b1", locale: "national" as const })],
  });
  const out = applyDisplayCaps(r, ctx);
  assert.ok(out.sections.gz_local.every((i) => i.locale === "national"), "gz 板块不得混入非 gz 候选以外的来源（不移动 national 条目）");
  assert.equal(out.sections.gz_local.length, 1, "无候选时不补足");
});

test("stock_news 每市场 ≤5", () => {
  const news = [
    ...["a-share", "hk", "us"].flatMap((m) =>
      Array.from({ length: 8 }, (_, i) => ({ market: m, url: `${m}-${i}`, title_cn: `t${i}` })),
    ),
  ] as any[];
  const r = mkReport({}, news);
  const out = applyDisplayCaps(r, ctx);
  for (const m of ["a-share", "hk", "us"]) {
    const n = out.stock_news!.filter((x) => x.market === m).length;
    assert.ok(n <= 5, `${m} 应 ≤5，实际 ${n}`);
  }
  assert.equal(out.stock_news!.length, 15);
});

test("不 mutate 入参", () => {
  const r = mkReport({ gz_local: [item({ url: "g1" })] });
  const before = JSON.stringify(r.sections.gz_local.length);
  applyDisplayCaps(r, ctx);
  assert.equal(JSON.stringify(r.sections.gz_local.length), before, "入参不得被修改");
});
