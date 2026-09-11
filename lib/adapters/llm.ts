/**
 * LLM 适配器（副作用出口 #4 · AI 唯一出口）。
 *
 * 通过 LLM_BACKEND 切换后端（claude-cli | anthropic | openai），业务层只调用
 * LlmPort.complete()。expectJson 时自动 jsonrepair 兜底，保证下游能 JSON.parse。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LlmPort, LlmRequest } from "../contracts/pipeline";
import { jsonrepair } from "jsonrepair";

const execFileP = promisify(execFile);

type Backend = "claude-cli" | "anthropic" | "openai" | "deepseek" | "minimax";

export class LlmAdapter implements LlmPort {
  private readonly backend: Backend;

  constructor(backend: Backend = (process.env.LLM_BACKEND as Backend) || "claude-cli") {
    this.backend = backend;
  }

  async complete(req: LlmRequest): Promise<string> {
    const text = await this.dispatch(req);
    if (req.expectJson) {
      try {
        return JSON.stringify(JSON.parse(jsonrepair(text)));
      } catch {
        return text.trim();
      }
    }
    return text.trim();
  }

  private async dispatch(req: LlmRequest): Promise<string> {
    switch (this.backend) {
      case "claude-cli":
        return this.viaClaudeCli(req);
      case "anthropic":
        return this.viaAnthropic(req);
      case "openai":
        return this.viaOpenAi(req);
      default:
        throw new Error(
          `LLM backend "${this.backend}" 未实现，请设 LLM_BACKEND=claude-cli|anthropic|openai`,
        );
    }
  }

  /** 走本地 claude CLI（默认后端，与 gzinfo 行为一致）。 */
  private async viaClaudeCli(req: LlmRequest): Promise<string> {
    const prompt = [req.system ? `# 系统：${req.system}\n` : "", req.prompt].join("");
    const { stdout } = await execFileP(
      "claude",
      ["-p", prompt, "--output-format", "text", "--verbose", "false"],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout;
  }

  private async viaAnthropic(req: LlmRequest): Promise<string> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      max_tokens: req.maxTokens ?? 4096,
      system: req.system,
      temperature: req.temperature ?? 0.2,
      messages: [{ role: "user", content: req.prompt }],
    });
    return msg.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
  }

  private async viaOpenAi(req: LlmRequest): Promise<string> {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const chat = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: req.temperature ?? 0.2,
      max_tokens: req.maxTokens ?? 4096,
      messages: [
        ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
        { role: "user", content: req.prompt },
      ],
    });
    return chat.choices[0]?.message?.content ?? "";
  }
}
