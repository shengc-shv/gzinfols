/**
 * 股市 AI 调用的 runner 工厂（组合根侧装配用）。
 *
 * gzinfo 的 stock-recap / stock-news-analysis 直连 runLlm；2.0 保持端口原则——
 * 服务层只声明 runner 签名（MarketLlmRunner），由本工厂把 LlmPort 适配进来。
 * 超时/重试语义由适配器侧承担（与 gzinfo runLlm 3 次指数退避等价）。
 */

import type { LlmPort } from "../../contracts/pipeline";
import type { AiStage } from "../../contracts/metrics";
import type { MarketLlmRunner } from "./recap";

/**
 * 把 LlmPort 适配成股市链路用的 runner。
 * 2026-09-15（Token 优化）：显式透传 stage，让 stock-recap / stock-news 的调用在埋点里
 * 正确归因（此前不传 stage → 一律记 "other"，按阶段的用量账单无法拆解）。
 */
export function makeMarketRunner(
  llm: LlmPort,
  opts: { model?: string; stage?: AiStage } = {},
): MarketLlmRunner {
  const override = opts.model?.trim() || undefined;
  return (systemPrompt, userPrompt) =>
    llm.complete({ system: systemPrompt, prompt: userPrompt, model: override, stage: opts.stage });
}
