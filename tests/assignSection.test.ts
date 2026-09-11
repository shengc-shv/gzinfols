import { test } from "node:test";
import assert from "node:assert/strict";
import { assignSection } from "../lib/services/enrich";
import type { ArticleInput } from "../lib/contracts/article";

function mk(title: string, excerpt = "", over: Partial<ArticleInput> = {}): ArticleInput {
  return {
    sourceId: "s",
    title,
    url: "u",
    category: "finance",
    publishedAt: new Date(),
    excerpt,
    isIpo: false,
    tier: "T2",
    source: "S",
    ...over,
  } as ArticleInput;
}

test("红线#2：板块归属由内容判定，与 sourceId/category 无关", () => {
  assert.equal(assignSection(mk("广州营商环境优化，招商引资加码")), "gz_local");
  assert.equal(assignSection(mk("央行降准释放流动性，货币宽松")), "policy_market");
  assert.equal(assignSection(mk("招行财富管理 AUM 创新高，零售信贷投放")), "biz_insight");
  assert.equal(assignSection(mk("AI 大模型算力突破，金融科技升级")), "tech");
});

test("红线#2：IPO 内容态（isIpo / category）直接进 IPO 板块", () => {
  assert.equal(assignSection(mk("某公司 IPO 过会", "", { isIpo: true, category: "gd-ipo" })), "ipo");
  assert.equal(assignSection(mk("科创板 IPO 发行", "", { category: "ipo" })), "ipo");
});

test("红线#2：无明确命中时回退到 policy_market", () => {
  assert.equal(assignSection(mk("一则普通社会新闻标题")), "policy_market");
});
