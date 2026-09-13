/**
 * R2 批次：无 AI 报告合成 + 凭证校验（gzinfo report-from-articles / validateBackendCredentials 移植）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNoAiReport, categoryToSection } from "../lib/services/render/report-from-articles";
import { validateBackendCredentials } from "../lib/adapters/llm";
import type { ArticleInput } from "../lib/contracts/article";

function art(over: Partial<ArticleInput> & { url: string; title: string }): ArticleInput {
  return {
    sourceId: "s1",
    source: "源",
    excerpt: "摘要内容。",
    category: "finance",
    fetchedAt: new Date("2026-09-13T02:00:00Z"),
    ...over,
  } as ArticleInput;
}

test("categoryToSection：内容判定归属（无状态源红线）", () => {
  assert.equal(categoryToSection("tech", "任意标题"), "tech"); // tech 独立栏目按类别
  assert.equal(categoryToSection("ipo", "任意"), "ipo"); // ipo/gd-ipo 内容态例外
  assert.equal(categoryToSection("gd-ipo", "任意"), "ipo");
  assert.equal(categoryToSection("finance", "广州发放消费贷贴息"), "gz_local"); // 广州锚 → gz_local
  assert.equal(categoryToSection("finance", "央行发布货币政策报告"), "policy_market"); // 政策动作
  assert.equal(categoryToSection("finance", "某公司发布新款芯片"), "policy_market"); // 芯片命中全国市场词（gzinfo 同款）
  assert.equal(categoryToSection("finance", "某企业完成B轮融资"), "biz_insight"); // 兜底
});

test("buildNoAiReport：无 AI 摘要用 excerpt 兜底 + rank 递增 + 跨板块去重", () => {
  const report = buildNoAiReport([
    art({ url: "https://e.com/1", title: "广州出台新政", category: "gz" }),
    art({ url: "https://e.com/2", title: "全国市场动态", summary: "已有 AI 摘要。" }),
    art({ url: "https://e.com/1", title: "广州出台新政（通稿重复）", category: "gz" }),
  ]);
  const all = Object.values(report.sections).flat();
  assert.equal(all.length, 2, "同 URL 跨板块去重（dedupeSections）");
  const g1 = all.find((i) => i.url === "https://e.com/1")!;
  assert.equal(g1.summary, "摘要内容。", "无 summary 用 excerpt 兜底");
  const g2 = all.find((i) => i.url === "https://e.com/2")!;
  assert.equal(g2.summary, "已有 AI 摘要。", "已有 summary 保留");
  assert.ok(g2.importance === 2, "无 AI 路径 importance 恒 2");
});

test("validateBackendCredentials：claude-cli 放行 / 缺密钥报错且给出修复提示", () => {
  // claude-cli 无需密钥
  assert.doesNotThrow(() => validateBackendCredentials("claude-cli"));
  // deepseek 缺密钥 → 报错信息含修复指引与「其他已就位密钥」提示
  const prev = { backend: process.env.LLM_BACKEND, ds: process.env.DEEPSEEK_API_KEY, oa: process.env.OPENAI_API_KEY };
  try {
    delete process.env.LLM_BACKEND;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.LLM_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test";
    assert.throws(
      () => validateBackendCredentials("deepseek"),
      (e: Error) => e.message.includes("DEEPSEEK_API_KEY") && e.message.includes("LLM_BACKEND=openai"),
      "报错应指出缺哪个密钥并提示可能想用的后端",
    );
    // 配置齐 → 放行
    process.env.DEEPSEEK_API_KEY = "sk-test";
    assert.doesNotThrow(() => validateBackendCredentials("deepseek"));
  } finally {
    if (prev.backend === undefined) delete process.env.LLM_BACKEND; else process.env.LLM_BACKEND = prev.backend;
    if (prev.ds === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prev.ds;
    if (prev.oa === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prev.oa;
  }
});
