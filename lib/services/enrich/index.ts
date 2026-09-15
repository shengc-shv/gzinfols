/**
 * 富集服务 C4（AI 管线入口）——对齐 gzinfo lib/pipeline/ai.ts + lib/ai/pipeline.ts。
 *
 * 两阶段管线：PASS1（AI 筛选分类，批 30/失败重试+拆半递归隔离毒丸）→ PASS2（总编辑成稿，
 * 单次全量 + 13 条校验回炉 ≤2 次 → 降级路径）。SKIP_AI 模式由 makeSkipAiRunner 零 LLM 合成。
 *
 * 必读/商机在本阶段**恒为空**（gzinfo 语义：由主编层 executive-summary 旁路基于
 * 「今天+昨天」两日窗口统一生成，B3 批次接入）；本阶段只产出 hero_line + sections。
 *
 * 与 gzinfo 的刻意差异（改进项，见核对报告）：
 *  - 2.0 早期自创的「AI 相关性回检」已移除：PASS1 的 keep 判定（保留标准 1-4 条）即
 *    gzinfo 的相关性闸门，功能覆盖相同且省一半 LLM 调用。
 */
import type { ArticleInput } from "../../contracts/article";
import type { DailyReport } from "../../contracts/report";
import type { LlmPort, PipelineContext } from "../../contracts/pipeline";
import type { AiStage } from "../../contracts/metrics";
import type { HistoryStore } from "../memory/history";
import { isWithinCalendarDays } from "../../utils/time";
import { generateDaily, makeSkipAiRunner } from "./pipeline";
import type { LlmRunner } from "./pass1";
import { toPass1Input } from "./pass1-input";

export interface EnrichDeps {
  llm: LlmPort;
  /** 跨天 prefill 历史库（gzinfo HistoryStore 形状；pipeline 从持久化加载后传入）。 */
  history?: HistoryStore;
}

/**
 * 把 LlmPort 适配成 gzinfo 的 LlmRunner（(system, user) → text）。
 *
 * 模型覆盖由调用方从 `ctx.config.models`（组合根读 PASS1_MODEL / PASS2_MODEL 注入）传入，
 * 服务层不直读 env。
 */
export function makeLlmRunner(llm: LlmPort, model?: string, stage?: AiStage): LlmRunner {
  return (systemPrompt, userPrompt) =>
    llm.complete({ system: systemPrompt, prompt: userPrompt, model, stage }).then((r) => r);
}

/**
 * 从历史库构建 prefillCache（url→summary），供全 AI 模式 PASS2 确定性复用。
 * gzinfo 口径：ai_relevant===true + 非空 summary + 发布时间落在抓取窗口内（最近 2 天）。
 */
function buildPrefillCache(
  history: HistoryStore | undefined,
  now: Date,
  windowDays: number,
): Map<string, string> {
  const cache = new Map<string, string>();
  for (const [url, e] of Object.entries(history ?? {})) {
    if (e.ai_relevant !== true) continue;
    const s = e.summary?.trim();
    if (!s) continue;
    if (!e.publishedAt) continue;
    if (!isWithinCalendarDays(e.publishedAt, windowDays, now)) continue;
    cache.set(url, s);
  }
  return cache;
}

/** C4 入口：执行两阶段 AI 管线，产出 DailyReport（must_read/insights 留空待 B3 旁路）。 */
export async function enrich(
  articles: ArticleInput[],
  ctx: PipelineContext,
  deps: EnrichDeps,
): Promise<DailyReport> {
  const inputs = articles.map(toPass1Input);
  ctx.log.info(
    "ai",
    `进入两阶段 AI 管线：${inputs.length} 条（PASS1 筛选 + PASS2 成稿 + 校验回炉/降级）`,
  );

  const runner: LlmRunner = makeLlmRunner(deps.llm, ctx.config.models.pass1, "pass1");
  // PASS2 用独立模型覆盖（PASS2_MODEL）；runner 内按 system prompt 无法区分阶段，
  // 故管线以 runner 参数区分：generateDaily 内部 PASS2 仍调同一 runner —— gzinfo 用
  // PASS1_MODEL/PASS2_MODEL 区分默认 runner，这里统一注入「按 stage 选择模型」的组合 runner。
  const runner2: LlmRunner = makeLlmRunner(deps.llm, ctx.config.models.pass2, "pass2");
  const combined: LlmRunner = (system, user, runCtx) =>
    system.includes("总编辑") ? runner2(system, user, runCtx) : runner(system, user, runCtx);

  if (ctx.mode.kind === "skip-ai") {
    const skipRunner = makeSkipAiRunner(ctx.mode.summaryCache, ctx.mode.relevantUrls);
    try {
      const report = await generateDaily(inputs, ctx.date, { runner: skipRunner });
      return report;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`[daily] 管线生成失败：${msg}`);
    }
  }

  try {
    // 全 AI 模式：从历史构建 prefillCache（预分析复用，命中条目 PASS2 不进 payload）
    const prefillCache = buildPrefillCache(deps.history, ctx.startTime, ctx.config.windowDays);
    const report = await generateDaily(inputs, ctx.date, { runner: combined, prefillCache });
    const totalKept = Object.values(report.sections).reduce((n, s) => n + s.length, 0) as number;
    ctx.log.info(
      "ai",
      `管线产出：必读 ${report.must_read.length} 条 / 商机 ${report.insights.length} 条 / 正文 ${totalKept} 条（预分析复用 ${prefillCache.size} 条 summary）`,
    );
    return report;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[daily] 管线生成失败：${msg}`);
  }
}
