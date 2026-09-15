/**
 * LLM 适配器（副作用出口 #4 · AI 唯一出口）。
 *
 * 通过 LLM_BACKEND 切换后端（claude-cli | anthropic | openai），业务层只调用
 * LlmPort.complete()。expectJson 时自动 jsonrepair 兜底，保证下游能 JSON.parse。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LlmPort, LlmRequest } from "../contracts/pipeline";
import { jsonrepair } from "jsonrepair";
import { logLlmCall, recordAiCall } from "./llm-log";
import { classifyError, estimateTokens } from "../services/metrics";
import { todayKey } from "../utils/time";

const execFileP = promisify(execFile);

type Backend = "claude-cli" | "anthropic" | "openai" | "deepseek" | "dump" | "replay";

/** transient 错误判定（gzinfo 同款）：5xx/429/超时/网络可重试；4xx 配置类不重试。 */
function isTransientLlmError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const status = (e as { status?: number }).status;
  if (status !== undefined) return status === 429 || status >= 500;
  return /timeout|timed out|network|ECONNRESET|ECONNREFUSED|fetch failed|429|\b5\d\d\b/.test(msg);
}

/**
 * 凭证校验（gzinfo lib/ai/llm.ts validateBackendCredentials 移植，P4 缺口补齐）：
 * AI 模式启动即校验当前后端所需密钥，缺密钥**立即报错并给出可执行的修复提示**，
 * 而不是跑到第一次 LLM 调用才炸（CI 上常见错误：配了 DEEPSEEK_API_KEY 却忘配 LLM_BACKEND）。
 */
export function validateBackendCredentials(backend: Backend = (process.env.LLM_BACKEND as Backend) || "claude-cli"): void {
  if (backend === "claude-cli") return; // 本地 CLI 无需密钥
  if (backend === "dump") return; // dump 后端不发真实请求，无需密钥
  if (backend === "replay") return; // replay 后端只读本地分析文件，无需密钥

  const required: Record<Exclude<Backend, "claude-cli" | "dump" | "replay">, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
  };
  const requiredVar = required[backend];
  if (!requiredVar) {
    throw new Error(`LLM backend "${backend}" 未实现，请设 LLM_BACKEND=claude-cli|anthropic|openai|deepseek`);
  }
  if (process.env[requiredVar] || process.env.LLM_API_KEY) return;

  const otherKeys = Object.entries(required)
    .filter(([b, v]) => b !== backend && !!process.env[v])
    .map(([b, v]) => ({ backend: b, varName: v }));

  const lines: string[] = [
    `LLM_BACKEND=${backend} 但 ${requiredVar}（与通用 LLM_API_KEY）均未设置。`,
  ];
  if (otherKeys.length > 0) {
    lines.push(
      "",
      "环境中存在其他后端的密钥——你可能想用的是其中之一：",
      ...otherKeys.map((k) => `  - ${k.backend}：改设 LLM_BACKEND=${k.backend}（密钥 ${k.varName} 已就位）`),
    );
  }
  lines.push("", "修复：在 GitHub Secrets / 本地 .env 配好对应密钥，或改用 LLM_BACKEND=claude-cli。");
  throw new Error(lines.join("\n"));
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

/**
 * dump 后端（**不发起任何真实 LLM 调用**）：把完整调用上下文落盘，供本地/离线分析消费。
 * 目录：LLM_DUMP_DIR（默认 data/llm-dump）/<runId>/<stage>-<seq>.json
 */
let _dumpSeq = 0;
function dumpLlmContext(req: LlmRequest, model: string, backend: string): void {
  try {
    const runId =
      process.env.GITHUB_RUN_ID || process.env.REPORT_RUN_ID || "local-" + Date.now();
    const dir = path.resolve(process.env.LLM_DUMP_DIR || "data/llm-dump", String(runId));
    fs.mkdirSync(dir, { recursive: true });
    const stage = (req.stage ?? "other").replace(/[^a-z0-9-]/gi, "-");
    const seq = String(++_dumpSeq).padStart(3, "0");
    const file = path.join(dir, stage + "-" + seq + ".json");
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          runId: String(runId),
          stage: req.stage ?? "other",
          seq: _dumpSeq,
          backend,
          model,
          expectJson: Boolean((req as { expectJson?: boolean }).expectJson),
          system: req.system ?? "",
          prompt: req.prompt,
          ts: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    console.log(`[llm] dump ${stage} #${seq} → ${file}`);
  } catch (e) {
    console.warn("[llm] dump 落盘失败：", e instanceof Error ? e.message : String(e));
  }
}

/**
 * dump 后端专用：从 PASS1 的 userPrompt（含文章 JSON 数组）抽取文章，返回
 * 「全部 keep + 启发式归栏」的有效响应，让管线能流到 PASS2 / 下游 side-outputs，
 * 从而把这些阶段的真实 LLM 上下文也落盘（其余阶段返回空串，仅落盘不走真实调用）。
 * 启发式仅用于「让管线流动 + 捕获上下文」，最终内容由本地/离线分析回填，不进正式稿。
 */
function dumpPass1Placeholder(prompt: string): string {
  try {
    // 括号配平提取：prompt 在 JSON 数组之后常跟一句说明（如『输出 {"items":[...]}』），
    // 用 lastIndexOf("]") 会把这段尾巴一起包进去导致解析失败。改为从首个 '[' 起按
    // 深度配平取回对应的 ']'，只截出数组本身（字符串内的括号已被忽略）。
    let depth = 0;
    let inStr = false;
    let start = -1;
    let end = -1;
    for (let i = 0; i < prompt.length; i++) {
      const c = prompt[i];
      if (inStr) {
        if (c === "\\") i++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "[") {
        if (start < 0) start = i;
        depth++;
      } else if (c === "]") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (start < 0 || end < start) return "";
    const arr = JSON.parse(prompt.slice(start, end + 1));
    if (!Array.isArray(arr)) return "";
    const GZ_ANCHOR = /广州|穗|天河|海珠|琶洲/;
    const items = arr.map((it: any) => {
      const title = String(it?.title ?? "");
      const cat = String(it?.category ?? "");
      let section = "biz_insight";
      if (cat === "tech") section = "tech";
      else if (cat === "ipo" || cat === "gd-ipo") section = "ipo";
      else if (GZ_ANCHOR.test(title)) section = "gz_local";
      const locale = section === "gz_local" ? "gz" : "national";
      const localeEvidence =
        section === "gz_local" ? (title.match(GZ_ANCHOR)?.[0] ?? "") : "";
      return {
        url: String(it?.url ?? ""),
        keep: true,
        section,
        source_type: "media",
        locale,
        locale_evidence: localeEvidence,
        tags: [],
        title_cn: title,
        title_orig: "",
        importance_candidate: 2,
      };
    });
    return JSON.stringify({ items });
  } catch {
    return "";
  }
}

/**
 * replay 后端（本地回填分析消费）：读取 LLM_REPLAY_DIR 下 `<stage>.response.txt`
 * 作为 LLM 输出，缺失则返空串（走管线既有降级/兜底）。
 *
 * 设计用途：CI 用 dump 后端落盘全部 LLM 调用上下文 → 本地由 WorkBuddy 逐份撰写分析
 * （PASS1 取舍/归栏 + PASS2 摘要成稿）→ 本后端消费这些分析文件，本地跑全管线产出
 * 真实报告。文件命名：pass1.response.txt / pass2.response.txt / executive.response.txt；
 * 若该阶段无需人工干预（走确定性兜底），直接不写文件即可（返空 → 兜底）。
 */
function readReplayResponse(stage: string): string {
  const dir = path.resolve(process.env.LLM_REPLAY_DIR || "data/llm-replay");
  const key = stage.replace(/[^a-z0-9-]/gi, "-");
  const candidates = [
    path.join(dir, `${key}.response.txt`),
    path.join(dir, `${key}.1.response.txt`),
  ];
  for (const f of candidates) {
    try {
      if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
    } catch {
      /* ignore */
    }
  }
  return "";
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
    // dump 后端：落盘后按阶段返回占位（绝不发起真实调用）。
    // - PASS1：返回「全保留 + 启发式归栏」让管线流动，从而捕获 PASS2/下游上下文；
    // - 其余阶段：返回空串（落盘 + 走既有降级），留待本地/离线回填分析。
    if (this.backend === "dump") {
      dumpLlmContext(req, req.model || defaultModelFor(this.backend), this.backend);
      if (req.stage === "pass1") return dumpPass1Placeholder(req.prompt);
      return "";
    }
    // replay 后端：读取本地撰写的阶段分析文件（LLM_REPLAY_DIR/<stage>.response.txt）。
    // 缺失则返空串，由管线既有降级/兜底处理（executive/market 有确定性兜底）。
    if (this.backend === "replay") {
      return this.postProcess(readReplayResponse(req.stage ?? "other"), req);
    }
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
        // stage 层：按业务阶段聚合（claude-cli 无 token 计量恒 0；API 后端中文感知估算：CJK≈1/字、其余≈1/4）
        recordAiCall({
          ts: new Date().toISOString(),
          date: todayKey(),
          backend: this.backend,
          stage: req.stage ?? "other",
          ok: true,
          ms: Date.now() - t0,
          tokens: this.backend === "claude-cli" ? 0 : estimateTokens((req.system ?? "") + req.prompt) + estimateTokens(text),
          modelTag: model,
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
          recordAiCall({
            ts: new Date().toISOString(),
            date: todayKey(),
            backend: this.backend,
            stage: req.stage ?? "other",
            ok: false,
            ms: Date.now() - t0,
            tokens: 0,
            modelTag: model,
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
