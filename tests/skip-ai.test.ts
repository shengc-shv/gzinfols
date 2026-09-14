import { test } from "node:test";
import assert from "node:assert/strict";
import { enrich } from "../lib/services/enrich";
import { createContext } from "../lib/orchestrator";
import type { ArticleInput } from "../lib/contracts/article";
import type { LlmPort, LlmRequest } from "../lib/contracts/pipeline";
import { SilentLog } from "./helpers";

/** 计数 LLM：任何调用即计数并抛错（skip-ai 下绝不应被触达）。 */
class CountingLlm implements LlmPort {
  calls = 0;
  async complete(_opts: LlmRequest): Promise<string> {
    this.calls++;
    throw new Error("skip-ai 模式不应调用 LLM");
  }
}

function article(url: string): ArticleInput {
  return {
    sourceId: "s",
    title: url === "u1" ? "央行降准释放流动性，银行信贷与财富管理受益" : "普惠小微贷款贴息政策出台",
    url,
    category: "finance",
    publishedAt: new Date("2026-09-11T08:00:00Z"),
    excerpt: url === "u1" ? "央行宣布降准，普惠小微与零售信贷投放有望扩大。" : "小微企业融资成本下降，覆盖面持续扩大。",
    isIpo: false,
    tier: "T1",
    source: "源",
  } as ArticleInput;
}

test("skip-ai 模式：全流程零 LLM 调用（llmCalls===0），条目走兜底卡", async () => {
  const llm = new CountingLlm();
  const ctx = createContext({
    date: "2026-09-11",
    mode: { kind: "skip-ai", summaryCache: new Map(), relevantUrls: undefined },
    sources: [],
    log: new SilentLog(),
  });
  const report = await enrich([article("u1"), article("u2")], ctx, { llm });

  assert.equal(llm.calls, 0, "skip-ai 下不得触碰 LLM 端口");
  assert.equal(ctx.stats.llmCalls ?? 0, 0, "llmCalls 计数应为 0");
  assert.equal(ctx.stats.llmFailures ?? 0, 0, "不应产生失败观测");
  // 兜底卡：原文标题直接成稿（两个不同事件都保留；gzinfo SKIP_AI 卡无 published_at 字段）
  assert.ok(Object.values(report.sections).flat().length === 2, "2 条都应有兜底卡");
  const all = Object.values(report.sections).flat();
  assert.ok(all.some((it) => it.title_cn.startsWith("央行降准")), "原文标题保留（u1）");
  assert.ok(all.some((it) => it.title_cn.includes("普惠小微贷款贴息")), "原文标题保留（u2）");
});

/**
 * 回归：空 allow-list 不得等价于「全部无关」。
 *
 * 背景（P0-2，2026-09-14）：历史库 `ai_relevant` 全库未打标（实测 126 条无一为 true），
 * 于是 SKIP_AI 传入的 `relevantUrls` 恒为**空 Set**。旧实现 `keepAll = !relevantUrls`
 * 对空集判为 false → 「只保留空集里的条目」→ PASS1 返回 0 条 → 报告四个主板块全空
 * （归档 2026-09-14 报告 sections 全 0 即此）。空集合语义应为「尚无已判定相关的条目」，
 * 退化为全量保留；只有**非空** allow-list 才按其过滤。
 */
test("skip-ai：空 relevantUrls（历史库未打标）退化为全量保留，不产出空简报", async () => {
  const llm = new CountingLlm();
  const ctx = createContext({
    date: "2026-09-11",
    mode: { kind: "skip-ai", summaryCache: new Map(), relevantUrls: new Set<string>() },
    sources: [],
    log: new SilentLog(),
  });
  const report = await enrich([article("u1"), article("u2")], ctx, { llm });
  assert.equal(llm.calls, 0, "skip-ai 下不得触碰 LLM 端口");
  assert.equal(
    Object.values(report.sections).flat().length,
    2,
    "空 allow-list 必须退化为全量保留（否则四主板块恒空）",
  );
});

test("skip-ai：非空 relevantUrls 仍按其过滤（08-22 防垃圾行为不回退）", async () => {
  const llm = new CountingLlm();
  const ctx = createContext({
    date: "2026-09-11",
    mode: { kind: "skip-ai", summaryCache: new Map(), relevantUrls: new Set(["u1"]) },
    sources: [],
    log: new SilentLog(),
  });
  const report = await enrich([article("u1"), article("u2")], ctx, { llm });
  const all = Object.values(report.sections).flat();
  assert.equal(all.length, 1, "有 allow-list 时只保留其中的条目");
  assert.ok(all[0].title_cn.startsWith("央行降准"), "保留的是 allow-list 命中的 u1");
});
