/**
 * 风险候选标题真实性守护（2026-11-28 第一期规格 P1 修复）。
 *
 * 事故：extractRiskCandidates 原用 r.matched.join(" / ") || url 当 title，
 * 即拿「命中关键词拼接串 / URL」冒充新闻标题喂给 LLM，risk.topic 因此失真；
 * articles 参数带下划线被闲置，真实标题就在手边却不用。
 *
 * 口径：title = 原始文章真实标题（title_cn 优先），命中词独立放 matched，
 * 证据片段放 evidence，S/A/B 优先级与上限 5 不变。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRiskCandidates } from "../lib/pipeline/side-outputs/side-exec-summary";
import type { ArticleInput } from "../lib/contracts/article";
import type { FilterResult } from "../lib/contracts/pipeline";
import type { DailyReport } from "../lib/contracts/report";

function article(title: string, url: string, over: Partial<ArticleInput> = {}): ArticleInput {
  return {
    sourceId: "test",
    title,
    url,
    category: "finance",
    publishedAt: new Date("2026-11-28T01:00:00Z"),
    isIpo: false,
    excerpt: "证监会对相关主体作出行政处罚，没收违法所得并处罚款。",
    source: "测试源",
    ...over,
  };
}

function filterResult(matched: string[], priority: "S" | "A" | "B"): FilterResult {
  return {
    pass: true,
    score: 90,
    dimensions: [],
    risks: [{ tracker: "regulatory_penalty", priority, label: "监管处罚", fields: matched, action: "" }],
    matched,
    bucket: "daily",
  };
}

const REPORT = { date: "2026-11-28" } as DailyReport;

test("① 风险候选 title 用原始文章真实标题，不用命中关键词拼接", () => {
  const url = "https://www.cnfin.com/yw-lb/detail/20261127/4501413_1.html";
  const title = "【中国证监会严肃查处两起编造传播证券市场误导性信息案件】";
  const results = new Map<string, FilterResult>([
    [url, filterResult(["证监会", "查处", "误导信息"], "S")],
  ]);
  const [c] = extractRiskCandidates(results, [article(title, url)], REPORT);
  assert.equal(c.title, title, "必须用原文标题");
  assert.ok(!c.title.includes(" / "), "不得出现关键词拼接痕迹");
  assert.deepEqual(c.matched, ["证监会", "查处", "误导信息"], "命中词独立保留");
  assert.deepEqual(c.trackers, ["regulatory_penalty"], "命中规则保留");
  assert.equal(c.priority, "S");
  assert.ok(c.evidence?.includes("行政处罚"), "证据片段来自原文 excerpt");
});

test("② title_cn 优先于原始 title（外文中文化口径）", () => {
  const url = "https://e.com/cn";
  const results = new Map<string, FilterResult>([[url, filterResult(["监管"], "A")]]);
  const [c] = extractRiskCandidates(
    results,
    [article("English original headline", url, { title_cn: "中文标题：监管新规落地" })],
    REPORT,
  );
  assert.equal(c.title, "中文标题：监管新规落地");
});

test("③ articles 里找不到 url 时才用 url 兜底，不用命中词冒充标题", () => {
  const url = "https://e.com/missing";
  const results = new Map<string, FilterResult>([[url, filterResult(["处罚", "通报"], "B")]]);
  const [c] = extractRiskCandidates(results, [], REPORT);
  assert.equal(c.title, url, "无文章时 url 兜底（可被溯源）");
  assert.ok(!c.title.includes("处罚 / 通报"), "绝不拿命中拼接串当标题");
});

test("④ S>A>B 排序且最多 5 条不变", () => {
  const results = new Map<string, FilterResult>();
  const prios: Array<"B" | "A" | "S"> = ["B", "S", "A", "B", "A", "S", "B"];
  prios.forEach((p, i) => {
    const u = `https://e.com/${i}`;
    results.set(u, filterResult([`词${i}`], p));
  });
  const out = extractRiskCandidates(
    results,
    prios.map((_, i) => article(`原文标题 ${i}`, `https://e.com/${i}`)),
    REPORT,
  );
  assert.equal(out.length, 5, "上限 5 条不变");
  assert.deepEqual(out.map((c) => c.priority), ["S", "S", "A", "A", "B"], "优先级排序不变");
  assert.ok(out.every((c) => c.title.startsWith("原文标题")), "全部使用真实标题");
});
