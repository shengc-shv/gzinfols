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
import { logLlmCall } from "./llm-log";
import { classifyError } from "../services/metrics";

const execFileP = promisify(execFile);

type Backend = "claude-cli" | "anthropic" | "openai" | "deepseek";

/** transient 错误判定（gzinfo 同款）：5xx/429/超时/网络可重试；4xx 配置类不重试。 */
function isTransientLlmError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const status = (e as { status?: number }).status;
  if (status !== undefined) return status === 429 || status >= 500;
  return /timeout|timed out|network|ECONNRESET|ECONNREFUSED|fetch failed|429|\b5\d\d\b/.test(msg);
}

/** 各后端默认模型（埋点与请求共用同一真源，避免漂移）。 */
function defaultModelFor(backend: string): string {
  switch (backend) {
    case "anthropic":
      return process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
    case "openai":
      return process.env.OPENAI_MODEL || "gpt-4o-mini";
    case "deepseek":
      return process.env.DEEPSEEK_MODEL || "deepseek-chat";
    default:
      return "claude-cli";
  }
}

export class LlmAdapter implements LlmPort {
  private readonly backend: Backend;

  constructor(backend: Backend = (process.env.LLM_BACKEND as Backend) || "claude-cli") {
    this.backend = backend;
  }

  /**
   * 重试语义（gzinfo lib/ai/llm.ts 2026-08-27 对齐）：
   * 3 次尝试 + 指数退避（1.5s/3s/6s）；仅 transient 错误（5xx/429/超时/网络）重试，
   * 4xx 配置类错误立即抛。HTTP 成功但空文本 → 打告警（下游解析将失败，可观测）。
   */
  async complete(req: LlmRequest): Promise<string> {
    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 1500;
    let lastErr: unknown;
    // 埋点：字符级明细写入 logs/llm-calls.jsonl（quota-report 数据源）。
    // 重试算一次调用（durationMs 含重试等待），失败以最终错误归类。
    const t0 = Date.now();
    const inputChars = (req.system?.length ?? 0) + (req.prompt?.length ?? 0);
    const model = req.model || defaultModelFor(this.backend);
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const text = await this.dispatch(req);
        if (attempt > 0) console.warn(`[llm] ${req.model ?? "default"} 成功（重试 ${attempt} 次后）`);
        if (!text.trim()) {
          console.warn("[llm] ⚠️ 返回空文本（HTTP 成功但 content 为空，下游解析将失败）");
        }
        logLlmCall({
          ts: new Date().toISOString(),
          backend: this.backend,
          model,
          durationMs: Date.now() - t0,
          success: true,
          inputChars,
          outputChars: text.length,
          errorCategory: null,
          errorSnippet: null,
        });
        return this.postProcess(text, req);
      } catch (e) {
        lastErr = e;
        const transient = isTransientLlmError(e);
        if (!transient || attempt === MAX_RETRIES - 1) {
          const msg = e instanceof Error ? e.message : String(e);
          logLlmCall({
            ts: new Date().toISOString(),
            backend: this.backend,
            model,
            durationMs: Date.now() - t0,
            success: false,
            inputChars,
            outputChars: 0,
            errorCategory: classifyError(msg),
            errorSnippet: msg.slice(0, 300),
          });
          throw e;
        }
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[llm] 第 ${attempt + 1} 次失败（${transient ? "transient" : "非 transient"}），${delay}ms 后重试: ${e instanceof Error ? e.message : e}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  private postProcess(text: string, req: LlmRequest): string {
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
    // 模型覆盖（gzinfo PASS1_MODEL/PASS2_MODEL 语义）：请求级 model 优先于后端默认
    if (req.model) (req as { modelOverride?: string }).modelOverride = req.model;
    switch (this.backend) {
      case "claude-cli":
        return this.viaClaudeCli(req);
      case "anthropic":
        return this.viaAnthropic(req);
      case "openai":
        return this.viaOpenAi(req);
      case "deepseek":
        return this.viaDeepSeek(req);
      default:
        throw new Error(
          `LLM backend "${this.backend}" 未实现，请设 LLM_BACKEND=claude-cli|anthropic|openai|deepseek`,
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
      model: req.model || defaultModelFor("anthropic"),
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
      model: req.model || defaultModelFor("openai"),
      temperature: req.temperature ?? 0.2,
      max_tokens: req.maxTokens ?? 4096,
      messages: [
        ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
        { role: "user", content: req.prompt },
      ],
    });
    return chat.choices[0]?.message?.content ?? "";
  }

  /** DeepSeek 后端（CI 默认，openai 兼容协议；动态 import 与 viaOpenAi 同风格）。 */
  private async viaDeepSeek(req: LlmRequest): Promise<string> {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({
      baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
      apiKey: process.env.DEEPSEEK_API_KEY,
    });
    const chat = await client.chat.completions.create({
      model: req.model || defaultModelFor("deepseek"),
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
