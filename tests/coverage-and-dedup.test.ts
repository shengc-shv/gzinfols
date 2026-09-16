/**
 * F2（摘要信息密度治理）+ A5/F3（覆盖度与来源分布）加锁测试（2026-09-16 用户批准）。
 *
 * 背景（PRD §5.2 #2/#8、§5.1）：摘要层 9 行中 7 行的源 URL 已在正文出现 → 独立信息密度仅 22%；
 * 数据戳只给总条数、看不出覆盖度与缺失源；空板块静默消失。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderReportExec } from "../lib/services/render/exec-block";
import { itemAnchorId } from "../lib/services/render/atoms";
import { renderCoverage } from "../lib/services/render/coverage";
import type { DailyReport, ReportItem } from "../lib/contracts/report";

function item(over: Partial<ReportItem> & { url: string }): ReportItem {
  return {
    title_cn: over.url,
    source: "源A",
    source_type: "media",
    date: "09/16",
    summary: "摘要。",
    importance: 2,
    rank: 1,
    tags: [],
    locale: "national",
    ...over,
  };
}

function report(over: Partial<DailyReport> = {}): DailyReport {
  return {
    date: "2026-09-16",
    hero_line: "定调",
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
    ...over,
  } as DailyReport;
}

const BODY_URL = "https://example.com/in-body";
const FRESH_URL = "https://example.com/only-in-summary";

test("F2①：必读条目已在正文 → 不再给第二遍外链，改标「见正文」", () => {
  const r = report({
    sections: { gz_local: [], biz_insight: [], policy_market: [item({ url: BODY_URL })], tech: [], ipo: [] },
    must_read: [
      { url: BODY_URL, why: "为什么重要（增量）" },
      { url: FRESH_URL, why: "摘要独有信息" },
    ],
  });
  const html = renderReportExec(r);
  // 在正文的那条：保留增量文案，但不再是外链
  assert.ok(html.includes("为什么重要（增量）"), "决策增量必须保留");
  assert.ok(!html.includes(`href="${BODY_URL}"`), "已在正文的条目不应再给外链");
  assert.ok(html.includes("must-inbody"), "应标注「见正文」");
  // 不在正文的那条：仍是外链（摘要独有入口）
  assert.ok(html.includes(`href="${FRESH_URL}"`), "正文未覆盖的条目应保留外链");
});

test("F2②：洞察/风险的来源标记只保留「正文未覆盖」的来源", () => {
  const r = report({
    sections: {
      gz_local: [],
      biz_insight: [],
      policy_market: [item({ url: BODY_URL })],
      tech: [],
      ipo: [],
    },
    insights: [
      {
        topic: "某商机",
        tags: [],
        impact: "影响",
        action: "建议",
        sources: [
          { title: "正文已有", url: BODY_URL },
          { title: "摘要独有", url: FRESH_URL },
        ],
      },
    ],
  });
  const html = renderReportExec(r);
  assert.ok(html.includes(`href="${FRESH_URL}"`), "增量来源应保留");
  assert.ok(!html.includes(`href="${BODY_URL}"`), "正文已覆盖的来源应剔除");
});

test("F2③（修正 2026-09-16 用户反馈）：来源全在正文 → 仍渲染站内锚点，不再删空", () => {
  const r = report({
    sections: { gz_local: [], biz_insight: [], policy_market: [item({ url: BODY_URL })], tech: [], ipo: [] },
    insights: [
      { topic: "t", tags: [], impact: "i", action: "a", sources: [{ title: "s", url: BODY_URL }] },
    ],
  });
  const html = renderReportExec(r);
  assert.ok(html.includes("insight-srcs"), "来源标记区块仍应渲染（不再整条剔除）");
  assert.ok(html.includes("insight-src-inbody"), "已在正文的来源应为站内锚点标记");
  assert.ok(html.includes(`href="#${itemAnchorId(BODY_URL)}"`), "锚点必须指向正文卡片 id");
  assert.ok(!html.includes(`href="${BODY_URL}"`), "仍不给重复外链");
});

test("F2④（用户反馈修正）：必读的「见正文」必须是**可点击锚点**", () => {
  const r = report({
    sections: { gz_local: [], biz_insight: [], policy_market: [item({ url: BODY_URL })], tech: [], ipo: [] },
    must_read: [{ url: BODY_URL, why: "增量" }],
  });
  const html = renderReportExec(r);
  assert.ok(
    html.includes(`<a class="must-inbody" href="#${itemAnchorId(BODY_URL)}">见正文</a>`),
    "「见正文」必须是 a[href=#itm-…]，而不是纯文本（此前点不动）",
  );
});

test("F2⑤：来源标记带条目日期（陈旧来源可见）", () => {
  const r = report({
    sections: {
      gz_local: [],
      biz_insight: [],
      policy_market: [item({ url: BODY_URL, date: "09/14" })],
      tech: [],
      ipo: [],
    },
    insights: [
      { topic: "t", tags: [], impact: "i", action: "a", sources: [{ title: "旧闻", url: BODY_URL }] },
    ],
  });
  const html = renderReportExec(r);
  assert.ok(html.includes("09/14"), "来源标记应带日期，便于判断新旧");
});

test("F2⑥ itemAnchorId：同 url 稳定、不同 url 不同（跨渲染可对齐）", () => {
  assert.equal(itemAnchorId(BODY_URL), itemAnchorId(BODY_URL));
  assert.notEqual(itemAnchorId(BODY_URL), itemAnchorId(FRESH_URL));
  assert.ok(/^itm-[0-9a-z]+$/.test(itemAnchorId(BODY_URL)), "形如 itm-<base36>");
});

test("A5①：来源分布按「抓取 → 收录」渲染，缺失源显式列出", () => {
  const r = report({
    sourceStats: [
      { sourceId: "stcn", inflow: 30, kept: 20, avgScore: 28 },
      { sourceId: "sina-money", inflow: 19, kept: 4, avgScore: 62 },
      { sourceId: "govcn-policy", inflow: 0, kept: 0, avgScore: null },
    ],
  });
  const html = renderCoverage(r, [["广州本地", 4], ["科技前沿", 0]]);
  assert.ok(html.includes("30 → 20"), "抓取→收录应可见");
  assert.ok(html.includes("19 → 4"), "低位源应可见");
  assert.ok(html.includes("govcn-policy"), "缺失源必须显式列出");
  assert.ok(html.includes("本期未采集到内容的已启用源"));
});

test("F3①：0 条板块显式标注「本期无」，不静默消失", () => {
  const html = renderCoverage(report(), [["广州本地", 4], ["科技前沿", 0], ["股市动态", 10]]);
  assert.ok(html.includes("cov-zero"), "0 条板块应有专门的标注样式");
  assert.ok(html.includes("本期无"));
  assert.ok(html.includes("确实没有"), "应说明「不是漏采」");
});

test("A5②：无 sourceStats（历史期次）→ 渲染板块部分并说明，不崩", () => {
  const html = renderCoverage(report(), [["广州本地", 3]]);
  assert.ok(html.includes("板块条数"));
  assert.ok(html.includes("历史期次无此数据"));
  assert.ok(!html.includes("来源（抓取 → 收录）"), "无数据时不渲染空来源列");
});
