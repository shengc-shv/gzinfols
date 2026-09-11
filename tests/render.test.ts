import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHtml, renderMarkdown } from "../lib/services/render";
import { SECTION_ORDER } from "../lib/contracts/report";
import type { DailyReport, ReportItem } from "../lib/contracts/report";

function item(title: string, over: Partial<ReportItem> = {}): ReportItem {
  return {
    url: "https://example.com/x",
    title_cn: title,
    source: "源",
    source_type: "official",
    date: "09/11",
    summary: "摘要",
    importance: 2,
    rank: 1,
    tags: ["标签"],
    locale: "national",
    tier: "T1",
    ...over,
  };
}

function baseReport(): DailyReport {
  return {
    date: "2026-09-11",
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  };
}

test("XSS 防护：标题含 <script> 时输出被转义，无可执行注入标签", () => {
  const report = baseReport();
  report.sections.tech = [item('<script>alert(1)</script>')];
  const html = renderHtml(report);
  assert.ok(!html.includes("<script>alert"), "不得出现可执行的注入标签");
  assert.ok(html.includes("&lt;script&gt;"), "标题应被 HTML 转义");
  const md = renderMarkdown(report);
  assert.ok(md.includes("<script>alert"), "Markdown 是纯文本归档，保留原文");
});

test("五板块 tab 齐全且顺序与契约 SECTION_ORDER 一致", () => {
  const html = renderHtml(baseReport());
  for (const key of SECTION_ORDER) {
    assert.ok(html.includes(`data-tab="${key}"`), `缺少 tab：${key}`);
  }
  const first = html.indexOf('data-tab="gz_local"');
  const last = html.indexOf('data-tab="ipo"');
  assert.ok(first >= 0 && first < last, "tab 顺序应遵循 SECTION_ORDER");
});

test("must_read 区渲染：含标题、链接与理由", () => {
  const report = baseReport();
  report.must_read = [{ url: "https://example.com/a", why: "因为重要", title: "必读标题" }];
  const html = renderHtml(report);
  assert.ok(html.includes("今日必读"), "应含必读区标题");
  assert.ok(html.includes("必读标题"), "应含必读条目标题");
  assert.ok(html.includes("因为重要"), "应含必读理由");
});
