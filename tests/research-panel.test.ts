/**
 * 高客前瞻·研报参考区：纯函数单测（2026-10-19）。
 *
 * 只测确定性逻辑（去重/排序/截断），不碰网络 —— 爬虫的 R6/R7 过滤在采集层，
 * 由 typecheck + 实跑冒烟覆盖（`npx tsx -e` 直调爬虫）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResearchPanel, RESEARCH_PANEL_MAX } from "../lib/pipeline/side-outputs/side-research";
import type { ResearchPanelItem } from "../lib/contracts/research";
import { eastmoneyPdfUrlOf } from "../lib/adapters/crawlers/sources/eastmoney-research";

const NOW = new Date("2026-10-19T07:00:00+08:00");

const item = (title: string, day: string, org = "中金公司"): ResearchPanelItem => ({
  title,
  url: `https://example.com/${encodeURIComponent(title)}`,
  org,
  publishedAt: day,
});

test("同标题（空白/标点差异）只保留一条", () => {
  const panel = buildResearchPanel(
    [item("银行零售转型观察", "2026-10-19"), item("银行零售转型 观察！", "2026-10-18")],
    { scanned: 2, windowDays: 3, now: NOW },
  );
  assert.equal(panel.items.length, 1);
  assert.equal(panel.scanned, 2);
});

test("按发布日期降序排列", () => {
  const panel = buildResearchPanel(
    [item("A篇", "2026-10-17"), item("B篇", "2026-10-19"), item("C篇", "2026-10-18")],
    { scanned: 3, windowDays: 3, now: NOW },
  );
  assert.deepEqual(panel.items.map((i) => i.publishedAt), ["2026-10-19", "2026-10-18", "2026-10-17"]);
});

test(`超过 ${RESEARCH_PANEL_MAX} 条时截断`, () => {
  const many = Array.from({ length: RESEARCH_PANEL_MAX + 3 }, (_, i) =>
    item(`研报第${i}篇`, "2026-10-19"),
  );
  const panel = buildResearchPanel(many, { scanned: many.length, windowDays: 3, now: NOW });
  assert.equal(panel.items.length, RESEARCH_PANEL_MAX);
  assert.equal(panel.scanned, many.length);
});

test("空输入产出空面板（渲染层据此整块不渲染）", () => {
  const panel = buildResearchPanel([], { scanned: 0, windowDays: 3, now: NOW });
  assert.equal(panel.items.length, 0);
  assert.equal(panel.windowDays, 3);
  assert.equal(panel.capturedAt, NOW.toISOString());
});

test("eastmoneyPdfUrlOf：东财 infoCode → PDF 文件直链；非东财/异常形态返回空", () => {
  const url = "https://data.eastmoney.com/report/zw_industry.jshtml?infocode=AP202610191830674433";
  assert.equal(
    eastmoneyPdfUrlOf(url),
    "https://pdf.dfcfw.com/pdf/H3_AP202610191830674433_1.pdf",
    "东财 PDF 规则 = H3_<infoCode>_1.pdf",
  );
  // 新浪正文页没有 PDF → 空（渲染层据此回退 url，不硬造）
  assert.equal(
    eastmoneyPdfUrlOf("https://stock.finance.sina.com.cn/stock/go.php/vReport_Show/kind/macro/rptid/845745816742/index.phtml"),
    "",
  );
  // 形态不对（过短/纯数字）→ 不猜
  assert.equal(eastmoneyPdfUrlOf("https://data.eastmoney.com/report/zw_industry.jshtml?infocode=AP1"), "");
  assert.equal(eastmoneyPdfUrlOf("https://data.eastmoney.com/report/zw_industry.jshtml"), "");
  assert.equal(eastmoneyPdfUrlOf(""), "");
});
