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
    title: "央行降准释放流动性，银行信贷与财富管理受益",
    url,
    category: "finance",
    publishedAt: new Date("2026-09-11T08:00:00Z"),
    excerpt: "央行宣布降准，普惠小微与零售信贷投放有望扩大。",
    isIpo: false,
    tier: "T1",
    source: "源",
  } as ArticleInput;
}

test("skip-ai 模式：全流程零 LLM 调用（llmCalls===0），条目走兜底卡", async () => {
  const llm = new CountingLlm();
  const ctx = createContext({
    date: "2026-09-11",
    mode: { kind: "skip-ai" },
    sources: [],
    log: new SilentLog(),
  });
  const report = await enrich([article("u1"), article("u2")], ctx, { llm });

  assert.equal(llm.calls, 0, "skip-ai 下不得触碰 LLM 端口");
  assert.equal(ctx.stats.llmCalls ?? 0, 0, "llmCalls 计数应为 0");
  assert.equal(ctx.stats.llmFailures ?? 0, 0, "不应产生失败观测");
  // 兜底卡：原文标题直接成稿
  assert.ok(Object.values(report.sections).flat().length === 2, "2 条都应有兜底卡");
  const all = Object.values(report.sections).flat();
  assert.ok(all.every((it) => it.title_cn.startsWith("央行降准")), "应保留原文标题");
  assert.ok(all.every((it) => it.published_at?.length), "兜底卡也应带完整 ISO 时间");
});
