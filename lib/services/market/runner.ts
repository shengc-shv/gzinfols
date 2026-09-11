/**
 * 股市 AI 调用的 runner 工厂（组合根侧装配用）。
 *
 * gzinfo 的 stock-recap / stock-news-analysis 直连 runLlm；2.0 保持端口原则——
 * 服务层只声明 runner 签名（MarketLlmRunner），由本工厂把 LlmPort 适配进来。
 * 超时/重试语义由适配器侧承担（与 gzinfo runLlm 3 次指数退避等价）。
 */

import type { LlmPort } from "../../contracts/pipeline";
import type { MarketLlmRunner } from "./recap";

/** 把 LlmPort 适配成股市链路用的 runner（stage 仅用于日志/模型覆盖语义）。 */
export function makeMarketRunner(llm: LlmPort, model?: string): MarketLlmRunner {
  const override = model?.trim() || undefined;
  return (systemPrompt, userPrompt) =>
    llm.complete({ system: systemPrompt, prompt: userPrompt, model: override });
}
