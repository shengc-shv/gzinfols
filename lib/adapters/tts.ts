/**
 * TTS：腾讯云主用 + Piper 本地兜底（自 gzinfo lib/audio/tts.ts 逐字移植，2026-08-24 重构）。
 *
 *  - 主用腾讯云语音合成（TTS）TextToVoice：免费资源包 800 万字符，精品女声。
 *    因腾讯 Node SDK 在运行时不导出请求模型类（Models 为空），此处手写
 *    TC3-HMAC-SHA256 签名 + 原生 fetch 调 REST API，零 SDK 依赖、完全可控。
 *  - 腾讯特有坑（2026-08-24 实测 + 官方文档核实，文档 https://cloud.tencent.com/document/api/1073/37995）：
 *    1) **Text 直接传原文（UTF-8），不要 base64**。官方示例即 `"Text": "你好"`；
 *       文档「合成语音的源文本，按 UTF-8 编码统一计算」。若传 base64 字符串，
 *       腾讯会把它当原文念出来 → 从第一个字就是乱码，且时长与 base64 字符串长度
 *       成正比（UTF-8 base64 179s / GBK base64 113.65s，实测 1.5 倍吻合）。
 *    2) 单次上限 150 个汉字（文档「中文最大支持150个汉字」），口播稿 ~600 字须按
 *       句子分片合成，再用 ffmpeg 重编码 concat 拼接（-codec copy 拼 mp3 存在
 *       位储备/帧对齐边界风险，统一 libmp3lame 重编码，见 mergeMp3）。
 *  - 发音规范化（2026-09-10 用户试听定案）：默认 SSML say-as 把 AUM 等缩写逐字母读，
 *    SSML 分片失败自动退回汉字音译（见 ./pronounce.ts 与 TTS_PRONOUNCE）。
 *  - 兜底：腾讯连续失败（3 次重试）自动切换 Piper 本地 onnx 合成（本地可用；
 *    CI 不预装 Piper → 腾讯失败时本轮降级为无播放器，不阻断发布）。
 *  - 输出（双路径）：daily_reports/<date>/audio/briefing-<date>.mp3（归档）
 *    + site/<date>/audio/briefing-<date>.mp3（静态站点播放器引用）。
 *  - 失败策略（用户约定）：所有后端均失败则抛错，由调用方 catch 降级
 *    （打 warning、页面不出播放器、不阻断发布）。
 *
 * 环境变量：
 *   TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY（必填，无则走 Piper）
 *   TENCENTCLOUD_REGION（默认 ap-guangzhou）
 *   TTS_VOICE_TYPE（默认 501001 智瑜精品女声） TTS_SPEED（默认 1，约快 15%）
 *   TTS_PRONOUNCE（默认 ssml-say-as；可选 translit / none）
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
// 2026-09-10：口播发音规范化（AUM 逐字母读）。改写放在「送 TTS 之前」的边界上，
// 一次覆盖全稿（hero/must_read/insights/risk/IPO/股市），与上游文本模板解耦。
import { isPronounceMode, isSsmlMode, toSpeechText, type PronounceMode } from "./pronounce";
import type { TtsPort } from "../contracts/pipeline";

// ---------- 腾讯云 ----------
const TCE_SECRET_ID = process.env.TENCENTCLOUD_SECRET_ID || "";
const TCE_SECRET_KEY = process.env.TENCENTCLOUD_SECRET_KEY || "";
const TCE_REGION = process.env.TENCENTCLOUD_REGION || "ap-guangzhou";
const TCE_HOST = "tts.tencentcloudapi.com";
const TCE_SERVICE = "tts";
const TCE_ACTION = "TextToVoice";
const TCE_VERSION = "2019-08-23";
const VOICE_TYPE = parseInt(process.env.TTS_VOICE_TYPE || "101011", 10);
const SPEED = parseInt(process.env.TTS_SPEED || "1.2", 10);
const CHUNK_LIMIT = 120; // 腾讯单次上限 150 个汉字，按 120 字分片留余量

/**
 * 口播发音改写策略（`TTS_PRONOUNCE` 环境变量）。
 *
 * **默认 `ssml-say-as`（2026-09-10 用户试听定案）**：走腾讯云官方 SSML 的
 * `<say-as interpret-as="characters">`，把 `AUM` 逐字符读成「A U M」。
 *
 * 定案过程：上游原先把 AUM 拆成「A U M」（空格）送过去，腾讯云仍连读（09-10 口播稿实证）；
 * 遂用 `npm run tts:probe` 合成 8 种候选逐一试听，用户选定第 6 种（即本项）。
 * SSML 分片若合成失败，`synthTencent` 会自动退回 `translit`（汉字音译）重试并 `::warning::`，
 * 不会整篇掉到 Piper 音色。
 */
const PRONOUNCE_MODE_ENV = process.env.TTS_PRONOUNCE ?? "";

/** 默认发音策略（试听定案）：SSML 逐字符读。 */
export const DEFAULT_PRONOUNCE_MODE: PronounceMode = "ssml-say-as";

/** 解析生效的发音策略；`TTS_PRONOUNCE` 未设或非法时用默认策略。 */
export function resolvePronounceMode(): PronounceMode {
  if (isPronounceMode(PRONOUNCE_MODE_ENV)) return PRONOUNCE_MODE_ENV;
  if (PRONOUNCE_MODE_ENV) {
    console.warn(
      `⚠️ TTS_PRONOUNCE=${PRONOUNCE_MODE_ENV} 不是合法策略，按默认 ${DEFAULT_PRONOUNCE_MODE} 处理`,
    );
  }
  return DEFAULT_PRONOUNCE_MODE;
}

// ---------- Piper 兜底 ----------
const VOICE = "zh_CN-huayan-medium";
const LENGTH_SCALE = "1.1";
const MODEL_DIR = path.join(process.env.HOME || os.tmpdir(), ".cache", "piper");
const BASE_URL =
  "https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium";

// ---------- 公共 ----------
const MAX_RETRY = 3;
const MIN_BYTES = 10_000; // 异常偏小校验（空音频防护）
const MIN_MODEL_BYTES = 10_000_000; // 中文 medium 模型应 >10MB，偏小说明下载到 404 错误页

export interface TtsResult {
  /**
   * mp3 **归档后的持久路径**（`daily_reports/<date>/audio/briefing-<date>.mp3`）。
   * ⚠️ 不是合成时用的临时路径：临时目录在 `synthesizeAudio` 返回前就会被 finally 清理，
   * 下游若对它 `stat` 会 ENOENT（2026-09-15 线上事故：播放器元数据整段丢失、页面无播放器）。
   */
  mp3Path: string;
  /** 估算时长（秒）；避免引入 mp3 解析依赖，使用字数估算 */
  durationSec: number;
  /** 合成后端：tencent=腾讯云合成，piper=开源 Piper 本地兜底 */
  backend: "tencent" | "piper";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- 腾讯云 TC3 签名 + 调用 ----------
function hmac(key: string | Buffer, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf-8").digest();
}
function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf-8").digest("hex");
}

/** 按中文断句标点切分，贪心组包到不超过 limit 字符的分片。 */
function splitText(t: string, limit: number): string[] {
  const sentences = t.split(/(?<=[。！？；\n])/);
  const chunks: string[] = [];
  let buf = "";
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (buf.length + s.length <= limit) {
      buf += s;
    } else {
      if (buf) chunks.push(buf);
      let rest = s;
      while (rest.length > limit) {
        chunks.push(rest.slice(0, limit));
        rest = rest.slice(limit);
      }
      buf = rest;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/** ffmpeg concat 拼接多个 mp3 分片：重编码拼接，避免 -codec copy 的位储备/帧对齐边界噪声。 */
export function mergeMp3(parts: Buffer[], outPath: string): void {
  if (parts.length === 1) {
    fs.writeFileSync(outPath, parts[0]);
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tts-merge-"));
  const files: string[] = [];
  try {
    parts.forEach((p, i) => {
      const f = path.join(tmp, `p-${i}.mp3`);
      fs.writeFileSync(f, p);
      files.push(f);
    });
    const lst = path.join(tmp, "list.txt");
    fs.writeFileSync(
      lst,
      files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"),
    );
    // 解码全部输入后统一重编码为 16k mp3：消除跨文件帧依赖错位
    const r = spawnSync(
      "ffmpeg",
      ["-y", "-f", "concat", "-safe", "0", "-i", lst, "-ar", "16000", "-ac", "1", "-codec:a", "libmp3lame", "-b:a", "48k", outPath],
    );
    if (r.status !== 0) {
      const err = (r.stderr || Buffer.alloc(0)).toString().slice(0, 300);
      throw new Error(`ffmpeg 拼接失败（exit ${r.status}）：${err}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 单次 TextToVoice 请求（已签名），返回 mp3 二进制。 */
async function tencentTextToVoice(payloadJson: string): Promise<Buffer> {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const hashedPayload = sha256Hex(payloadJson);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${TCE_HOST}\n`;
  const signedHeaders = "content-type;host";
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;
  const credentialScope = `${date}/${TCE_SERVICE}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;
  const secretDate = hmac(`TC3${TCE_SECRET_KEY}`, date);
  const secretService = hmac(secretDate, TCE_SERVICE);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = hmac(secretSigning, stringToSign).toString("hex");
  const authorization =
    `TC3-HMAC-SHA256 Credential=${TCE_SECRET_ID}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const resp = await fetch(`https://${TCE_HOST}/`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json; charset=utf-8",
      "X-TC-Action": TCE_ACTION,
      "X-TC-Version": TCE_VERSION,
      "X-TC-Timestamp": String(timestamp),
      "X-TC-Region": TCE_REGION,
    },
    body: payloadJson,
  });
  const data = (await resp.json()) as { Response?: { Audio?: string; Error?: { Code: string; Message: string } } };
  if (data.Response?.Error) {
    throw new Error(`腾讯云错误 ${data.Response.Error.Code}: ${data.Response.Error.Message}`);
  }
  if (!data.Response?.Audio) {
    throw new Error("腾讯云返回缺少 Audio 字段");
  }
  return Buffer.from(data.Response.Audio, "base64");
}

/** 单次腾讯云合成一片（已含发音改写）。抽出来便于「SSML 失败 → 退回纯文本」重试。 */
async function tencentSynthChunk(spoken: string, date: string, index: number): Promise<Buffer> {
  const payload = JSON.stringify({
    // Text 直接传原文（UTF-8），不要 base64（2026-08-24 官方文档核实 + 实测）
    Text: spoken,
    SessionId: `${date}-${index}-${crypto.randomBytes(4).toString("hex")}`,
    VoiceType: VOICE_TYPE,
    Codec: "mp3",
    SampleRate: 16000,
    Speed: SPEED,
  });
  const audio = await tencentTextToVoice(payload);
  if (audio.length < 1000) {
    throw new Error(`腾讯第 ${index} 片返回异常偏小：${audio.length} bytes`);
  }
  return audio;
}

/** 腾讯云合成整篇口播稿（分片 + 逐片发音改写 + 拼接）。导出供试听脚本 scripts/tts-probe.ts 复用。 */
export async function synthTencent(text: string, outPath: string, date: string): Promise<void> {
  const mode = resolvePronounceMode();
  // SSML 标签本身虽不计入 150 汉字上限，但保守压低分片粒度，避免超限报错
  const limit = isSsmlMode(mode) ? Math.min(CHUNK_LIMIT, 110) : CHUNK_LIMIT;
  const chunks = splitText(text, limit);
  console.log(
    `ℹ️ 腾讯云 TTS：共 ${text.length} 字，分 ${chunks.length} 片合成（发音策略 ${mode}）`,
  );
  const parts: Buffer[] = [];
  let ssmlFallback = 0;
  for (let i = 0; i < chunks.length; i++) {
    // 关键：**先分片、再逐片改写**，保证 SSML 标签不会被分片截断
    const spoken = toSpeechText(chunks[i], mode);
    try {
      parts.push(await tencentSynthChunk(spoken, date, i));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!isSsmlMode(mode)) throw e;
      // SSML 分片失败 → 退回汉字音译纯文本重试（宁可换种读法，也不能整篇降级到 Piper 音色）
      console.warn(`⚠️ 腾讯第 ${i} 片 SSML 合成失败，退回汉字音译重试：${msg}`);
      parts.push(await tencentSynthChunk(toSpeechText(chunks[i], "translit"), date, i));
      ssmlFallback++;
    }
  }
  if (ssmlFallback > 0) {
    console.warn(
      `::warning::TTS 发音 SSML 有 ${ssmlFallback}/${chunks.length} 片退回汉字音译，请检查腾讯云 SSML 支持情况`,
    );
  }
  mergeMp3(parts, outPath);
}

// ---------- Piper 兜底 ----------
function ensureModel(): { model: string; config: string } {
  const model = path.join(MODEL_DIR, `${VOICE}.onnx`);
  const config = path.join(MODEL_DIR, `${VOICE}.onnx.json`);
  if (fs.existsSync(model) && fs.existsSync(config)) return { model, config };
  console.log(`⏬ 首次下载 Piper 模型到 ${MODEL_DIR} ...`);
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  const dl = (file: string, url: string) => {
    // --connect-timeout 20：连不上（如沙箱/CI 网络受限）快速失败；
    // --max-time 240：50MB 模型在良好网络下足够，超时则降级（不阻断发布）。
    const r = spawnSync(
      "curl",
      ["-sfL", "--connect-timeout", "20", "--max-time", "240", "-o", file, url],
      { stdio: "inherit" },
    );
    if (r.status !== 0) throw new Error(`下载 Piper 模型失败（exit ${r.status}）：${url}`);
  };
  dl(model, `${BASE_URL}/${VOICE}.onnx`);
  dl(config, `${BASE_URL}/${VOICE}.onnx.json`);
  if (fs.statSync(model).size < MIN_MODEL_BYTES) {
    fs.rmSync(model, { force: true });
    fs.rmSync(config, { force: true });
    throw new Error("下载的模型文件异常偏小，可能是 404 错误页");
  }
  return { model, config };
}

/** piper 文本→WAV，再 ffmpeg WAV→MP3。 */
function synthPiper(text: string, outPath: string): void {
  const { model, config } = ensureModel();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "piper-"));
  const wav = path.join(tmpDir, "out.wav");
  const p = spawnSync(
    "piper",
    ["--model", model, "--config", config, "--output_file", wav, "--length-scale", LENGTH_SCALE],
    { input: Buffer.from(text, "utf-8"), maxBuffer: 64 * 1024 * 1024 },
  );
  if (p.status !== 0) {
    const err = (p.stderr || Buffer.alloc(0)).toString().slice(0, 300);
    throw new Error(`piper 合成失败（exit ${p.status}）：${err}`);
  }
  const f = spawnSync("ffmpeg", ["-y", "-i", wav, "-codec:a", "libmp3lame", "-q:a", "4", outPath]);
  if (f.status !== 0) {
    const err = (f.stderr || Buffer.alloc(0)).toString().slice(0, 300);
    throw new Error(`ffmpeg 转码失败（exit ${f.status}）：${err}`);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---------- 重试包装 ----------
async function runBackend(
  name: string,
  fn: (t: string, o: string) => void | Promise<void>,
  text: string,
  out: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      await fn(text, out);
      const size = fs.statSync(out).size;
      if (size < MIN_BYTES) throw new Error(`音频异常偏小：${size} bytes`);
      console.log(`✅ TTS 成功（${name}）：${out}（${size} bytes）`);
      return true;
    } catch (e) {
      console.warn(`⚠️ ${name} 第 ${attempt}/${MAX_RETRY} 次失败：${e instanceof Error ? e.message : e}`);
      if (attempt < MAX_RETRY) await sleep(3000 * attempt);
    }
  }
  return false;
}

/** Piper CLI 是否可用（腾讯包月场景 workflow 不再预装 Piper，仅失败兜底时安装）。 */
function piperAvailable(): boolean {
  const r = spawnSync("sh", ["-c", "command -v piper"], { stdio: "ignore" });
  return r.status === 0;
}

/**
 * 双路径落盘：归档（daily_reports/<date>/audio）+ 站点（site/<date>/audio，2026-09-14 B-3 子目录布局）。
 *
 * @returns 归档后的**持久路径** —— 必须把此路径交回调用方（而非合成用的临时路径）：
 *   临时目录随后会被 `synthesizeAudio` 的 finally 清理，交回临时路径必致下游 `stat` ENOENT。
 * @param baseDir 仅测试注入用（默认进程工作目录）。
 */
export function writeMp3Both(src: string, date: string, baseDir: string = process.cwd()): string {
  const archiveDir = path.resolve(baseDir, "daily_reports", date, "audio");
  fs.mkdirSync(archiveDir, { recursive: true });
  const archived = path.join(archiveDir, path.basename(src));
  fs.copyFileSync(src, archived);
  // 报告页位于 site/<date>/<date>.html，其中播放器引用相对路径 `audio/briefing-<date>.mp3`
  // → 必须落在 site/<date>/audio/ 才解析得到（此前写 site/audio/ 是扁平布局的遗留）。
  const siteDir = path.resolve(baseDir, "site", date, "audio");
  fs.mkdirSync(siteDir, { recursive: true });
  fs.copyFileSync(src, path.join(siteDir, path.basename(src)));
  return archived;
}

export async function synthesizeAudio(date: string, script: string): Promise<TtsResult> {
  if (!script || script.trim().length < 20) {
    throw new Error(`口播稿过短（${script?.length ?? 0} 字），中止 TTS`);
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-"));
  const out = path.join(workDir, `briefing-${date}.mp3`);
  try {
    const durationSec = Math.max(1, Math.round(script.length / 5.2)); // 与 CHARS_PER_SEC 对齐（腾讯 Speed=1 实测 ~5.3 字/秒）

    // —— 主用腾讯云 ——
    if (TCE_SECRET_ID && TCE_SECRET_KEY) {
      if (await runBackend("tencent", (t, o) => synthTencent(t, o, date), script, out)) {
        const archived = writeMp3Both(out, date);
        return { mp3Path: archived, durationSec, backend: "tencent" };
      }
      console.warn("⚠️ 腾讯云连续失败，尝试 Piper 本地兜底……");
    } else {
      console.log("ℹ️ 未配置 TENCENTCLOUD_SECRET_ID/KEY，使用 Piper 本地兜底");
    }

    // —— Piper 兜底（仅在腾讯失败/未配置时走到这里；CI 未预装 Piper 则降级为无播放器）——
    if (!piperAvailable()) {
      // 腾讯失败且本机无 Piper：写「待兜底」标记，供 workflow 安装 Piper 后
      // 调 `npm run tts:fallback` 补合成（gzinfo 同款标记机制，见 scripts/tts-fallback.ts）。
      if (TCE_SECRET_ID && TCE_SECRET_KEY) {
        try {
          const dir = path.resolve(process.cwd(), "daily_reports", date);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(
            path.join(dir, "tts-fallback-needed.txt"),
            `${new Date().toISOString()} 腾讯云合成失败且无 Piper，待兜底补合成\n`,
            "utf-8",
          );
        } catch {
          // 写标记失败不影响主流程（照常抛错降级为无播放器）
        }
      }
      throw new Error(
        TCE_SECRET_ID && TCE_SECRET_KEY
          ? "腾讯云合成失败且 CI 未安装 Piper（降级：本轮无音频，不阻断发布）"
          : "Piper 未安装（未配置腾讯密钥且无 Piper 兜底）",
      );
    }

    if (await runBackend("piper", synthPiper, script, out)) {
      console.warn("::warning::今日音频由 Piper 兜底生成，请检查腾讯云 TTS 状态与额度");
      const archived = writeMp3Both(out, date);
      return { mp3Path: archived, durationSec, backend: "piper" };
    }

    throw new Error("所有 TTS 后端均失败");
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * TtsPort 适配器（组合根装配）。启用条件：AUDIO_ENABLED === "true"
 * （CI 的 Generate 步骤显式注入；本地默认关闭，需要时在 .env 打开）。
 * 失败语义：抛错由管线 catch 降级为「页面无播放器」，不阻断发布。
 */
export class TtsAdapter implements TtsPort {
  async synthesize(script: string, date: string): Promise<TtsResult & { bytes: number }> {
    const r = await synthesizeAudio(date, script);
    // mp3Path 此时已是**归档持久路径**（临时目录在 synthesizeAudio 返回前清理），可安全 stat。
    // 仍留兜底：bytes 只用于日志，任何 stat 异常都不该连带丢掉「音频元数据」
    // —— 2026-09-15 线上事故即因 stat 临时路径抛 ENOENT，被管线 catch 后整页无播放器。
    let bytes = 0;
    try {
      bytes = fs.statSync(r.mp3Path).size;
    } catch {
      console.warn(`⚠️ 音频已归档但 stat 失败（bytes 记 0，不阻断播放器渲染）：${r.mp3Path}`);
    }
    return { ...r, bytes };
  }
}
