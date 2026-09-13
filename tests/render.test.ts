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

test("五板块面板齐全（完整版渲染：panel id 与 gzinfo 同款）", () => {
  const report = baseReport();
  // gzinfo 语义：空板块不渲染（alwaysShow 仅 gz）；各板块填 1 条以断言面板齐全
  const one = (url: string, title: string): any => ({
    url, title_cn: title, title_orig: title, source: "源", source_type: "media",
    date: "09/13", summary: "摘要。", importance: 2, rank: 1, tags: [], locale: "national",
  });
  report.sections.gz_local = [one("https://e.com/gz", "广州出台科技金融新政")];
  report.sections.biz_insight = [one("https://e.com/biz", "银行理财规模回升")];
  report.sections.policy_market = [one("https://e.com/pol", "国务院发布金融政策")];
  report.sections.tech = [one("https://e.com/tech", "AI 大模型驱动金融科技升级")];
  const ipoItem = one("https://e.com/ipo", "广东某企业赴港上市");
  ipoItem.tags = ["粤"]; // IPO 面板只展示广东企业（topGdIpo 判定），fixture 需带粤标
  report.sections.ipo = [ipoItem];
  const html = renderHtml(report);
  // gzinfo 全量渲染为 panel 布局：<section class="panel" id="p-gz"> 等（非轻量版的 data-tab）
  for (const panel of ["p-gz", "p-biz", "p-pol", "p-tech", "p-ipo"]) {
    assert.ok(html.includes(`id="${panel}"`), `缺少面板：${panel}`);
  }
  const first = html.indexOf('id="p-gz"');
  const last = html.indexOf('id="p-ipo"');
  // 注：p-stock（股市动态）常排第二，非五板块断言范围
  assert.ok(first >= 0 && first < last, "面板顺序应遵循 gzinfo 版面顺序");
});

test("must_read 区渲染：含标题、链接与理由", () => {
  const report = baseReport();
  report.must_read = [{ url: "https://example.com/a", why: "因为重要", title: "必读标题" }];
  const html = renderHtml(report);
  assert.ok(html.includes("今日必读"), "应含必读区标题");
  assert.ok(html.includes("必读标题"), "应含必读条目标题");
  assert.ok(html.includes("因为重要"), "应含必读理由");
});
