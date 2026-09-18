/**
 * A1a 摘要区纵向优先级流（PRD 一期）。
 *
 * 现锁两件事（2026-09-17 按用户实测反馈调整）：
 *   ① 首屏只留 Top3，其余折叠（「展开其余 N 条」）——与音频侧「三件事」口径一致；
 *   ② **横滑样式保持原样**：曾一度改为纵向流，但用户实测**手机上横滑更好**，
 *      故于 2026-09-17 回退（commit `2e3df51`），折叠这一项保留。
 *
 * 2026-09-18 加固 ②：原守卫是「产物里不得出现某条字面选择器字符串」
 * （`!html.includes(".must-scroller, .insight-scroller")`）。
 * 实测它**换个写法就能静默绕过** —— 例如写成 `.must-scroller { display: block }`
 * 并挪进 `@media (max-width: 719.98px)`，字符串对不上、测试照常全绿，但横滑已经没了。
 * 现改为**声明级行为断言**：解析产物 CSS，凡是命中滚动容器选择器的规则，
 * 只要处在「窄视口」媒体条件下，就不得出现取消横滑的声明。
 * 断言语义而非拼写。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReportExec } from "../lib/services/render/exec-block";
import { renderHtml } from "../lib/services/render";
import { styleOf, stripComments, rulesMatching, rulesOf } from "./css-inspect";
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

test("③ 窄视口下滚动容器必须保持横滑（按声明判定，不认写法）", () => {
  const html = renderHtml(report([M(1)]));
  const style = stripComments(styleOf(html));
  /** 五个横滑容器（今日必读 / 商机洞察 / 风险预警 / 广东IPO / 昨日股市）。 */
  const SCROLLER = /\.(?:must|insight|risk|ipo|stock)-scroller\b/;
  /** 窄视口条件 —— 移动端覆盖都写在这里；桌面网格化写在 min-width 下，属合法。 */
  const NARROW = /max-width\s*:/;

  // (a) 基础层（无条件规则）必须提供横滑能力
  const base = rulesMatching(style, SCROLLER).filter((r) => r.ancestors.length === 0);
  assert.ok(
    base.some((r) => /overflow-x:\s*auto/.test(r.body)),
    "基础层必须保留 overflow-x: auto —— 横滑是用户 2026-09-17 实测确认要保留的交互",
  );

  // (b) 窄视口下，任何命中滚动容器的规则都不得取消横滑
  const narrow = rulesMatching(style, SCROLLER).filter((r) =>
    r.ancestors.some((a) => NARROW.test(a)),
  );
  for (const r of narrow) {
    assert.ok(
      !/overflow(-x)?:\s*visible/.test(r.body),
      `窄视口下滚动容器不得改成 overflow: visible（规则：${r.prelude}）` +
        ` —— 2026-09-17 用户实测手机上横滑更好，纵向流已回退`,
    );
    assert.ok(
      !/(?:^|;)\s*display:\s*block/.test(r.body),
      `窄视口下滚动容器不得改成 display: block（规则：${r.prelude}）—— 会取消横滑`,
    );
    assert.ok(
      !/scroll-snap-type:\s*none/.test(r.body),
      `窄视口下不得关闭 scroll-snap（规则：${r.prelude}）`,
    );
  }

  // (c) 折叠展开态须保留（回退只针对布局，不针对折叠）
  assert.ok(
    style.includes(".exec-must.expanded .must-card.must-more") ||
      rulesOf(style).some((r) => /expanded .must-card\.must-more/.test(r.prelude)),
    "折叠展开态须保留（回退只针对布局，不针对折叠）",
  );
});

test("④ 横滑回来了 → 「左右滑动查看」提示必须恢复", () => {
  const html = renderReportExec(report([M(1), M(2)]));
  const head = /📌 今日必读[\s\S]{0,160}?<\/h3>/.exec(html)?.[0] ?? "";
  assert.ok(head.length > 0, "应存在今日必读标题");
  assert.ok(head.includes("左右滑动"), "横滑布局需要该提示（回退后同步恢复）");
});
