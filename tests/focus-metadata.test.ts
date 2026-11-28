/**
 * 经营重点命中打标（二期 WP6）守护。
 *
 * 锁住三条口径：
 *  - 只打 M2/M3：M1 宽泛关联不贴标签（否则几乎每条都挂标，首页变彩色噪音）；
 *  - 一条最多两个标签；标题里“金价”被排除词否决时不打标；
 *  - 不 mutate 入参、无生效重点时原样返回（历史报告零改写）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { annotateFocus } from "../lib/services/assemble/focus-metadata";
import { applyFocus } from "../lib/services/business-focus/focus-apply";
import { scoreFocus } from "../lib/services/business-focus/focus-scoring";
import type { FocusItem } from "../lib/services/business-focus/types";
import type { DailyReport, ReportItem } from "../lib/contracts/report";

function focus(over: Partial<FocusItem> = {}): FocusItem {
  return {
    id: "q4_customer_aum",
    name: "中高端客户AUM提升",
    description: "",
    layer: "quarterly",
    grade: "S",
    status: "active",
    priority: 1.5,
    highlight: true,
    start_date: "2026-10-01",
    end_date: "2026-12-31",
    domains: ["wealth_aum", "customer_growth"],
    core_keywords: ["AUM", "私行"],
    keywords: ["资产配置", "财富客户"],
    synonyms: [],
    concepts: ["客户分层", "基金", "保险"],
    segments: [],
    products: [],
    exclude_keywords: ["金价"],
    source: "",
    description_for_ai: "",
    config_file: "config/quarterly-focus.json",
    ...over,
  };
}

function item(title: string, over: Partial<ReportItem> = {}): ReportItem {
  return {
    url: `https://e.com/${encodeURIComponent(title).slice(0, 12)}`,
    title_cn: title,
    source: "测试源",
    source_type: "media",
    date: "11/28",
    published_at: "2026-11-28T02:00:00.000Z",
    summary: "摘要。",
    importance: 2,
    rank: 1,
    tags: [],
    locale: "gz",
    primary_domain: "wealth_aum",
    ...over,
  };
}

function report(items: ReportItem[]): DailyReport {
  return {
    date: "2026-11-28",
    hero_line: "",
    must_read: [],
    insights: [],
    sections: { gz_local: items, biz_insight: [], policy_market: [], tech: [], ipo: [] },
  };
}

test("① 无生效重点：原样返回，不注入 focus 字段", () => {
  const r = report([item("AUM 突破千亿")]);
  const out = annotateFocus(r, [], "f-xxxxxxxx");
  assert.equal(out, r, "同一引用（零改写）");
  assert.equal(out.focus, undefined);
});

test("② M3 命中：标题命中核心词 + 领域匹配 → 打标并带 reason", () => {
  const out = annotateFocus(report([item("AUM 规模突破千亿")]), [focus()], "f-1234abcd");
  const hits = out.sections.gz_local[0].focus_hits ?? [];
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "q4_customer_aum");
  assert.equal(hits[0].level, "M3");
  assert.equal(hits[0].layer, "quarterly");
  assert.ok(hits[0].reason.includes("AUM"), `理由应含命中词：${hits[0].reason}`);
  assert.equal(out.focus?.version, "f-1234abcd");
});

test("③ M1 不入库：只命中一个概念（无标题关键词）不打标，但计入汇总的 count", () => {
  // 新口径下「纯领域匹配」不产生命中（无词面/概念信号 = M0），故用单概念构造 M1
  const r = report([item("某行推进客户分层", { primary_domain: undefined })]);
  const out = annotateFocus(r, [focus()], "f-1234abcd");
  assert.equal(out.sections.gz_local[0].focus_hits, undefined, "M1 不贴标签");
  const agg = out.focus?.items.find((x) => x.id === "q4_customer_aum");
  assert.equal(agg?.count, 1, "当日相关数（含 M1）");
  assert.equal(agg?.high, 0, "实质关联（M2/M3）为 0");
});

test("④ 排除词一票否决：「金价」相关的财富稿不得打标", () => {
  const out = annotateFocus(report([item("金价回调 AUM 客群转投黄金")]), [focus()], "f-x");
  assert.equal(out.sections.gz_local[0].focus_hits, undefined);
});

test("⑤ 一条最多两个标签：三个重点同时命中只留两个", () => {
  const fs = [
    focus({ id: "a1", name: "年度一", layer: "annual" }),
    focus({ id: "q1", name: "季度一" }),
    focus({ id: "t1", name: "临时一", layer: "temporary" }),
  ];
  const out = annotateFocus(report([item("AUM 规模突破千亿")]), fs, "f-x");
  const hits = out.sections.gz_local[0].focus_hits ?? [];
  assert.equal(hits.length, 2, "最多两个（规格 5.2）");
});

test("⑥ bonus 与真实评分一致：多命中按衰减折算，不用基准表", () => {
  const fs = [focus({ id: "q1", name: "季度一" }), focus({ id: "q2", name: "季度二" })];
  const title = "AUM 与资产配置";
  const res = applyFocus({ title, domains: ["wealth_aum"] }, 0, fs);
  // 两条都命中同一层级同一等级 → 最高为主 + 次高 0.3 衰减
  const expected = scoreFocus(
    { base: 60, matches: res.matches },
    fs,
  ).counted.map((c) => Math.round(c.bonus * 10) / 10);
  const out = annotateFocus(report([item(title)]), fs, "f-x");
  const got = (out.sections.gz_local[0].focus_hits ?? []).map((h) => h.bonus);
  for (const b of got) assert.ok(expected.includes(b), `bonus ${b} 应在真实折算结果 ${expected} 中`);
  assert.ok((out.focus?.items ?? []).every((x) => x.count >= 1), "两条重点都应计数");
});

test("⑦ 不 mutate 入参：原报告对象与条目保持原状", () => {
  const it = item("AUM 规模突破千亿");
  const r = report([it]);
  annotateFocus(r, [focus()], "f-x");
  assert.equal(r.sections.gz_local[0].focus_hits, undefined, "入参条目未被写入");
  assert.equal(r.focus, undefined, "入参报告未被写入");
});

test("⑧ 幂等：同输入两次打标结果一致（重跑覆盖不叠加）", () => {
  const r = report([item("AUM 规模突破千亿")]);
  const a = annotateFocus(r, [focus()], "f-x");
  const b = annotateFocus(a, [focus()], "f-x");
  assert.deepEqual(b.sections.gz_local[0].focus_hits, a.sections.gz_local[0].focus_hits);
  assert.equal((b.sections.gz_local[0].focus_hits ?? []).length, 1, "不重复叠加");
});
