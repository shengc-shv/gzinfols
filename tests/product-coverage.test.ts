/**
 * C4 客群商机覆盖均衡（2026-09-17）。
 *
 * 锁四件事：
 *  ① 三条产品线（按揭 / 信用卡 / 代发）的判定保守（泛词不误伤，如「分期电商」不算信用卡）；
 *  ② 统计范围明确：只看 商机洞察 + 业务启示（政策/IPO/股市不参与，否则会被楼市新闻刷成假覆盖）；
 *  ③ 未命中 → `count = 0` 并在页面**显式标「本期无」**（设计上允许「本期无」，不硬凑）；
 *  ④ 纯统计、零 LLM：函数只读条目，**不产生任何新内容**（业务相关性红线）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { productLinesOf, PRODUCT_LINES } from "../lib/services/classify/product-line";
import { productCoverageOf, productCoverageSummary } from "../lib/services/assemble/product-coverage";
import { renderHtml } from "../lib/services/render";
import type { DailyReport, ReportItem } from "../lib/contracts/report";

function item(over: Partial<ReportItem> = {}): ReportItem {
  return {
    url: "https://example.com/a",
    title_cn: "条目",
    source: "源",
    source_type: "media",
    date: "09/17",
    summary: "",
    importance: 2,
    rank: 1,
    tags: [],
    locale: "national",
    ...over,
  } as ReportItem;
}

test("① 产品线判定保守：泛词不误伤", () => {
  assert.deepEqual(productLinesOf("广州首套房贷利率下调"), ["按揭"]);
  assert.deepEqual(productLinesOf("信用卡分期手续费新规"), ["信用卡"]);
  assert.deepEqual(productLinesOf("企业代发工资业务拓展"), ["代发"]);
  // 反例：泛词不应命中
  assert.deepEqual(productLinesOf("某电商平台分期商城上线"), [], "「分期」单独出现不判信用卡");
  assert.deepEqual(productLinesOf("我市空气质量持续改善"), []);
  assert.deepEqual(productLinesOf(""), []);
  // 一条政策可同时涉及两条线（多值）
  assert.deepEqual(productLinesOf("房贷与消费贷利率联动调整").sort(), ["信用卡", "按揭"].sort());
  assert.deepEqual([...PRODUCT_LINES], ["按揭", "信用卡", "代发"], "三条线固定顺序");
});

test("② 统计范围 = 商机洞察 + 业务启示（政策/IPO 不参与）", () => {
  const report = {
    date: "2026-09-17",
    hero_line: "",
    must_read: [],
    insights: [
      { topic: "按揭提前还款应对", impact: "房贷客群流失", action: "梳理话术", tags: [], sources: [] },
      { topic: "与产品线无关的商机", impact: "影响", action: "行动", tags: [], sources: [] },
    ],
    sections: {
      gz_local: [],
      biz_insight: [item({ title_cn: "代发工资获客新规", summary: "薪酬代发场景" })],
      // 下面这些即使含产品线词也不该计入（避免被楼市新闻刷成假覆盖）
      policy_market: [item({ title_cn: "信用卡新规落地", summary: "政策" })],
      tech: [],
      ipo: [],
    },
  } as unknown as DailyReport;
  const cov = productCoverageOf(report);
  const by = Object.fromEntries(cov.map((c) => [c.line, c.count]));
  assert.equal(by["按揭"], 1, "商机洞察里的按揭应计入");
  assert.equal(by["代发"], 1, "业务启示里的代发应计入");
  assert.equal(by["信用卡"], 0, "政策板块的信用卡条目不计入（统计范围刻意收窄）");
  for (const c of cov) {
    assert.equal(typeof c.count, "number");
    assert.ok(Array.isArray(c.examples));
    assert.ok(c.examples.length <= 2, "示例最多 2 条（读者只需要核对，不需要清单）");
  }
});

test("③ 本期无 → 产出 0 条且摘要明确点名（允许「本期无」，不凑数）", () => {
  const report = {
    date: "2026-09-17",
    hero_line: "",
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  } as unknown as DailyReport;
  const cov = productCoverageOf(report);
  assert.equal(cov.length, 3, "三条线恒定产出（否则页面无法显式标注「本期无」）");
  assert.ok(cov.every((c) => c.count === 0));
  const summary = productCoverageSummary(cov);
  assert.ok(summary.includes("本期无"), "日志须点名哪几条是空的（可观测）");
  assert.ok(summary.includes("按揭") && summary.includes("代发"));
});

test("④ 渲染：命中给条数、未命中显式标「本期无」；纯统计不产生内容", () => {
  const report = {
    date: "2026-09-17",
    hero_line: "",
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  } as unknown as DailyReport;
  const before = (report.sections.biz_insight ?? []).length;
  const cov = productCoverageOf(report);
  assert.equal((report.sections.biz_insight ?? []).length, before, "统计函数不得往报告里塞条目");

  const page = renderHtml({ ...report, productCoverage: cov });
  assert.ok(page.includes("产品条线覆盖"), "页面须展示覆盖行");
  assert.ok(page.includes("本期无"), "未命中须显式标注，不能留白");
  assert.ok(page.includes('class="pc-chip pc-none"'), "未命中样式独立（灰色虚线，与命中区分）");
  // 命中态：给条数（覆盖数据由装配期注入 —— 渲染层只读，不自己判定）
  const withInsight = {
    ...report,
    insights: [{ topic: "房贷按揭客群经营", impact: "提前还款", action: "触达", tags: [], sources: [] }],
  } as unknown as DailyReport;
  const page2 = renderHtml({ ...withInsight, productCoverage: productCoverageOf(withInsight) });
  assert.ok(/class="pc-chip pc-hit"[^>]*>按揭 1</.test(page2), "命中须显示条数");
  assert.ok(page2.includes("本期无"), "同期仍须标注未命中的线");
});
