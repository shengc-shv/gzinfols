/**
 * A1a 摘要区纵向优先级流（PRD 一期）。
 *
 * 现锁两件事（2026-09-17 按用户实测反馈调整）：
 *   ① 首屏只留 Top3，其余折叠（「展开其余 N 条」）——与音频侧「三件事」口径一致；
 *   ② **横滑样式保持原样**：曾一度改为纵向流，但用户实测**手机上横滑更好**，
 *      故于 2026-09-17 回退（纵向覆盖规则不得再出现），折叠这一项保留。
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

test("③ 已回退横滑：不得再出现纵向流覆盖规则（且折叠项保留）", () => {
  const html = renderHtml(report([M(1)]));
  assert.ok(
    !html.includes(".must-scroller, .insight-scroller"),
    "纵向流覆盖选择器组不应存在 —— 2026-09-17 用户实测手机横滑更好，已回退",
  );
  assert.ok(html.includes("scroll-snap-type: x mandatory"), "横滑（原行为）必须保留");
  assert.ok(
    html.includes(".exec-must.expanded .must-card.must-more"),
    "折叠展开态须保留（回退只针对布局，不针对折叠）",
  );
});

test("④ 横滑回来了 → 「左右滑动查看」提示必须恢复", () => {
  const html = renderReportExec(report([M(1), M(2)]));
  const head = /📌 今日必读[\s\S]{0,160}?<\/h3>/.exec(html)?.[0] ?? "";
  assert.ok(head.length > 0, "应存在今日必读标题");
  assert.ok(head.includes("左右滑动"), "横滑布局需要该提示（回退后同步恢复）");
});
