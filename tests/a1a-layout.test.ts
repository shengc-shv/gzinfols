/**
 * A1a 摘要区纵向优先级流（PRD 一期）。
 *
 * 锁住三件事：
 *   ① 横滑 → 纵向：读者主场景是微信内置浏览器（窄屏），而原实现**仅 ≥720px 才转网格**，
 *      窄屏仍是横滑（易误触、卡片被裁切）。现默认单列纵向，桌面再转多列网格。
 *   ② 首屏只留 Top3，其余折叠（「展开其余 N 条」）——与音频侧「三件事」口径一致。
 *   ③ 无横滑后，「← 左右滑动查看 →」提示不再出现。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReportExec } from "../lib/services/render/exec-block";
import { renderHtml } from "../lib/services/render";
import type { DailyReport } from "../lib/contracts/report";

function report(mustRead: Array<{ url: string; why: string; title?: string }>): DailyReport {
  return {
    date: "2026-09-16",
    hero_line: "",
    must_read: mustRead,
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  } as unknown as DailyReport;
}
const M = (i: number) => ({ url: `u${i}`, why: `理由${i}`, title: `标题${i}` });
/** 只统计 li 元素（避免把 CSS 规则 .must-card.must-more 也算成卡片）。 */
const cards = (h: string) => (h.match(/<li class="must-card/g) ?? []).length;
const folded = (h: string) => (h.match(/<li class="must-card[^"]*must-more/g) ?? []).length;

test("① 首屏只留 Top3：第 4 条起折叠，并给出展开按钮", () => {
  const html = renderReportExec(report([M(1), M(2), M(3), M(4), M(5)]));
  assert.equal(cards(html), 5, "5 条都要渲染（折叠靠 CSS，不是不渲染）");
  assert.equal(folded(html), 2, "第 4、5 条折叠");
  assert.ok(html.includes("展开其余 2 条"), "展开按钮须带条数");
});

test("② 必读 ≤3 条时：不折叠、不出现展开按钮", () => {
  const html = renderReportExec(report([M(1), M(2), M(3)]));
  assert.equal(folded(html), 0);
  assert.ok(!html.includes("expand-btn"), "无多余条目时不该有展开按钮");
});

test("③ 纵向流 CSS 必须覆盖在横滑定义之后（否则不生效）", () => {
  const html = renderHtml(report([M(1)]));
  const snap = html.indexOf("scroll-snap-type: x mandatory");
  const grid = html.indexOf("grid-template-columns: 1fr");
  assert.ok(snap > 0, "应存在原有的横滑定义（被覆盖而非删除）");
  assert.ok(grid > snap, "纵向规则须在横滑定义之后，否则窄屏仍横滑");
  assert.ok(html.includes(".exec-must.expanded .must-card.must-more"), "展开态须恢复 flex");
});

test("④ 今日必读标题不再提示「左右滑动」", () => {
  const html = renderReportExec(report([M(1), M(2)]));
  const head = /📌 今日必读[\s\S]{0,120}?<\/h3>/.exec(html)?.[0] ?? "";
  assert.ok(head.length > 0, "应存在今日必读标题");
  assert.ok(!head.includes("左右滑动"), "已无横滑，不应再提示滑动");
});
