/**
 * TTS：腾讯云主用 + 阿里云百炼 CosyVoice + Piper 本地兜底
 * （自 gzinfo lib/audio/tts.ts 逐字移植，2026-08-24 重构；2026-09-21 引入后端注册表）。
 *
 * ## 架构（2026-09-21 重构，为「后端可插拔」而改）
 *
 * 原先是硬编码的「腾讯 → Piper」两级 if，加第三个后端会把 `synthesizeAudio` 写成面条。
 * 现改为**后端注册表 + 候选链**：
 *
 *   resolveBackendChain()  ← TTS_BACKEND（逗号分隔）；缺省 ["cosyvoice","tencent","piper"]
 *        ↓ 依次取
 *   BACKENDS[name].ready()  ← 凭据/外部依赖就绪性；不就绪则跳过并打日志（不再靠 if 层层特判）
 *        ↓ 就绪
 *   BACKENDS[name].synth()  ← 各自负责分片 + 拼接，runBackend 只管重试与「异常偏小」校验
 *
 * **两级降级**（2026-09-21 定案；**2026-09-25 用户决定去掉 v3.5-plus**）：
 *   ① 后端链（跨服务商）：百炼 → 腾讯 → Piper；
 *   ② 百炼内部的**模型链**（同一服务商内）：缺省只有 `cosyvoice-v3.5-flash`
 *      （链是配置驱动的，可自行再加模型；全失败才轮到腾讯）。
 *
 * **候选链语义是「显式」的**：`TTS_BACKEND=cosyvoice` 表示「只用 cosyvoice」，
 * 失败即失败，**不会静默换成腾讯** —— 否则做 A/B 盲听时拿到的音频可能根本不是目标后端。
 * 需要兜底就写成 `TTS_BACKEND=cosyvoice,piper`（回退是显式声明，不是隐式发生）。
 *
 * ## 后端耦合的三件事（这是注册表存在的真正理由）
 *
 * 1. **发音策略**：`ssml-say-as` 产出的是**腾讯云方言**的
 *    `<say-as interpret-as="characters">`，DashScope/百炼与 Piper 都不认这套标签
 *    → 跨后端复用会被当普通文本念出来或直接报错。故按后端解析默认值并拦截不安全的模式
 *    （`resolvePronounceMode(backend)` + `BACKEND_UNSAFE_PRONOUNCE`）。
 * 2. **分片上限**：腾讯 150 汉字 / 百炼未公开 → 各后端自己的 CHUNK 常量。
 * 3. **容器格式**：腾讯恒 mp3；百炼可 wav/pcm/opus（`mergeMp3` 单片走字节直拷，
 *    容器不匹配会产出「名为 .mp3 的 wav」）→ 下载后按魔数校验，必要时 ffmpeg 归一。
 *
 * ## 腾讯云（tencent）
 *
 *  - 腾讯云语音合成（TTS）TextToVoice：免费资源包 800 万字符，精品女声。
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
 *
 * ## 阿里云百炼 CosyVoice（cosyvoice，2026-09-21 新增）
 *
 * 官方文档（2026-09-21 核实，非凭记忆）：
 *  - 用户指南 https://help.aliyun.com/zh/model-studio/non-realtime-tts-user-guide
 *  - HTTP API https://help.aliyun.com/en/model-studio/cosyvoice-tts-http-api
 *
 *  - **仅北京地域**（China Beijing），新加坡 Key 不通；`DASHSCOPE_API_KEY` 由用户自备。
 *  - 端点：`POST https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`
 *    （官方另推专属域名 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/...`，
 *     旧域名仍在服役；本实现两者都支持，见 `cosyEndpoint`）。
 *  - 请求体：`{ model, input: { text, voice, format, sample_rate, … } }` ——
 *    **voice / format / sample_rate 全部在 `input` 内**（不是 `parameters`，与部分老文档/直觉相反）。
 *  - 返回体（非流式）：`output.audio.url` 指向音频文件，**有效期 24 小时**，
 *    `output.audio.data` 在非流式下为空串（流式才回 base64）→ 本实现两者都兼容。
 *    官方示例 JSON（摘自上述 HTTP API 文档）：
 *      {"request_id":"…","output":{"finish_reason":"stop",
 *       "audio":{"data":"","url":"http://dashscope-result-bj.oss-cn-beijing…wav?…",
 *                "id":"audio_…","expires_at":1772697707}},"usage":{"characters":15}}
 *  - 格式：`format` 缺省 **mp3**（可选 mp3/pcm/wav/opus）；`sample_rate` 支持
 *    8000/12000/16000/22050(缺省)/24000/44100/48000。
 *  - ⚠️ **`cosyvoice-v3.5-flash` 只支持「声音复刻 / 声音设计」音色，没有系统音色**
 *    （官方原话：仅支持声音设计和声音复刻场景(无系统音色)），
 *    所以「v3.5 + 系统音色」这种组合必然失败。系统音色要配
 *    `cosyvoice-v3-flash` / `cosyvoice-v3-plus`（如 `longanyang`）
 *    → 前置判定见 `modelUnavailableReason`（不可用的模型会被跳过并告警，不拖垮整条模型链）。
 *  - **模型链**：`DASHSCOPE_TTS_MODELS` 按序尝试，前一个失败就换下一个
 *    （缺省只有 `cosyvoice-v3.5-flash`；全失败才轮到腾讯）。错误按 HTTP 状态分级：
 *    4xx → 换模型；401/403 → 换模型无意义，直接放弃百炼；网络/5xx/429 → 同模型退避重试。
 *  - 计费：按输入字符数（`usage.characters` 回显），v3.5-flash 0.8 元/万字符、v3-flash 1 元/万字符。
 *  - 合规：文本出本机到阿里云**华北2(北京)**，数据中心在国内；调用方须已确认
 *    口播文本不含可定位的银行主体信息（用户 2026-09-21 已拍板合规可接受）。
 *
 * ## Piper 兜底（piper）
 *
 *  - 腾讯/百炼连续失败（3 次重试）后自动切换 Piper 本地 onnx 合成（本地可用；
 *    CI 不预装 Piper → 云端后端失败时本轮降级为无播放器，不阻断发布）。
 *  - 输出（双路径）：daily_reports/<date>/audio/briefing-<date>.mp3（归档）
 *    + site/<date>/audio/briefing-<date>.mp3（静态站点播放器引用）。
 *  - 失败策略（用户约定）：所有后端均失败则抛错，由调用方 catch 降级
 *    （打 warning、页面不出播放器、不阻断发布）。
 *
 * 环境变量：
 *   TTS_BACKEND（后端链，逗号分隔；缺省 cosyvoice,tencent,piper）—— 显式指定即关掉隐式回退
 *   —— 腾讯云 ——
 *   TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY（无则跳过 tencent）
 *   TENCENTCLOUD_REGION（默认 ap-guangzhou）
 *   TTS_VOICE_TYPE（默认 101011） TTS_SPEED（默认 1.2）
 *   TTS_PRONOUNCE（默认 ssml-say-as；可选 translit / none）
 *   —— 百炼 CosyVoice ——
 *   DASHSCOPE_API_KEY（无则跳过 cosyvoice）
 *   DASHSCOPE_TTS_MODELS（**模型链**，逗号分隔，每项 `模型` 或 `模型@音色ID`；
 *     缺省 cosyvoice-v3.5-flash）
 *   DASHSCOPE_TTS_VOICE（模型链里未写 `@音色` 时的音色；v3.5 系列无系统音色 → 必须显式给）
 *   DASHSCOPE_TTS_ENDPOINT / DASHSCOPE_WORKSPACE_ID（端点覆盖；后者走官方专属域名）
 *   DASHSCOPE_TTS_FORMAT（默认 mp3） DASHSCOPE_TTS_SAMPLE_RATE（默认 24000）
 *   DASHSCOPE_TTS_RATE（语速 0.5~2.0，默认 1.0） DASHSCOPE_TTS_CHUNK_LIMIT（默认 1900）
 *   DASHSCOPE_TTS_AIGC_TAG（默认 false；置 true 给音频打 AIGC 隐式水印）
 *   DASHSCOPE_TTS_VOICE_FORCE（置 true 跳过「模型×音色」兼容性判定）
 *   TTS_PRONOUNCE_COSYVOICE（默认 translit —— 百炼不认腾讯 SSML 方言）
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
// 2026-09-10：口播发音规范化（AUM 逐字母读）。改写放在「送 TTS 之前」的边界上，
// 一次覆盖全稿（hero/must_read/insights/risk/IPO/股市），与上游文本模板解耦。
import { isPronounceMode, isSsmlMode, toSpeechText, type PronounceMode } from "./pronounce";
import type { TtsBackendName, TtsPort } from "../contracts/pipeline";

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
 * 口播发音改写策略（各后端各自的 `TTS_PRONOUNCE[_*]` 环境变量）。
 *
 * **腾讯云默认 `ssml-say-as`（2026-09-10 用户试听定案）**：走腾讯云官方 SSML 的
 * `<say-as interpret-as="characters">`，把 `AUM` 逐字符读成「A U M」。
 *
 * 定案过程：上游原先把 AUM 拆成「A U M」（空格）送过去，腾讯云仍连读（09-10 口播稿实证）；
 * 遂用 `npm run tts:probe` 合成 8 种候选逐一试听，用户选定第 6 种（即本项）。
 * SSML 分片若合成失败，`synthTencent` 会自动退回 `translit`（汉字音译）重试并 `::warning::`，
 * 不会整篇掉到 Piper 音色。
 *
 * ⚠️ **该策略与后端强耦合**：SSML 标签是腾讯云私有方言，不能直接送给别的后端
 * → 具体默认值与安全网见下方 `BACKEND_DEFAULT_PRONOUNCE` / `BACKEND_UNSAFE_PRONOUNCE`。
 */

/** 腾讯云默认发音策略（试听定案）：SSML 逐字符读。 */
export const DEFAULT_PRONOUNCE_MODE: PronounceMode = "ssml-say-as";

/**
 * **各后端的默认发音策略**（后端耦合，不可跨后端复用 —— 见文件头「后端耦合的三件事」）。
 *
 * - tencent：`ssml-say-as`（2026-09-10 用户试听定案，腾讯云支持该 SSML 实现）；
 * - cosyvoice：`translit`（汉字音译「诶优艾姆」）。**刻意不用 SSML**：
 *   `pronounce.ts` 产出的 `<say-as interpret-as="characters">` 是腾讯云 SSML 方言，
 *   百炼即便开 `enable_ssml` 也未声明支持该标签 → 送过去轻则被当文本念出来，重则报错。
 *   汉字音译是任何 TTS 后端都必然逐字读的写法，无需依赖标签支持；
 * - piper：`asis`（与重构前逐字一致 —— Piper 路径从来不经过发音改写）。
 */
const BACKEND_DEFAULT_PRONOUNCE: Record<TtsBackendName, PronounceMode> = {
  tencent: DEFAULT_PRONOUNCE_MODE,
  cosyvoice: "translit",
  piper: "asis",
};

/** 各后端读取发音策略的环境变量名（便于按后端分别调参）。 */
const BACKEND_PRONOUNCE_ENV: Record<TtsBackendName, string> = {
  tencent: "TTS_PRONOUNCE",
  cosyvoice: "TTS_PRONOUNCE_COSYVOICE",
  piper: "TTS_PRONOUNCE_PIPER",
};

/**
 * 各后端**不认**的发音策略（安全网）。
 * 命中时不报错（报错会让整条链断掉），而是打 warning 并退回该后端默认策略。
 */
const BACKEND_UNSAFE_PRONOUNCE: Record<TtsBackendName, ReadonlySet<PronounceMode>> = {
  tencent: new Set<PronounceMode>(),
  cosyvoice: new Set<PronounceMode>(["ssml-say-as", "ssml-sub"]),
  piper: new Set<PronounceMode>(["ssml-say-as", "ssml-sub"]),
};

/**
 * 解析生效的发音策略；对应环境变量未设或非法时用该后端默认策略。
 *
 * @param backend 目标后端；**缺省 `tencent`** —— 与重构前签名兼容，行为逐字不变。
 */
export function resolvePronounceMode(backend: TtsBackendName = "tencent"): PronounceMode {
  const fallback = BACKEND_DEFAULT_PRONOUNCE[backend];
  const envName = BACKEND_PRONOUNCE_ENV[backend];
  const raw = (process.env[envName] ?? "").trim();
  let mode: PronounceMode = fallback;
  if (isPronounceMode(raw)) {
    mode = raw;
  } else if (raw) {
    console.warn(`⚠️ ${envName}=${raw} 不是合法策略，按默认 ${fallback} 处理`);
  }
  if (BACKEND_UNSAFE_PRONOUNCE[backend].has(mode)) {
    console.warn(
      `::warning::${envName}=${mode} 不被 ${backend} 接受（SSML 标签是后端私有方言）→ 本后端退回 ${fallback}`,
    );
    return fallback;
  }
  return mode;
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
  /**
   * **实际产出该音频**的后端（不是「期望」的后端）。
   * 类型单一真源见 `contracts/pipeline.ts#TtsBackendName`。
   * tencent=腾讯云合成，cosyvoice=阿里云百炼 CosyVoice，piper=开源 Piper 本地兜底。
   */
  backend: TtsBackendName;
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
  const mode = resolvePronounceMode("tencent");
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

// ---------- 阿里云百炼 CosyVoice ----------
/**
 * **缺省模型链**（按序尝试，前面的失败就换下一个）。
 *
 * 2026-09-21 定案为 `v3.5-plus → v3.5-flash`；**2026-09-25 用户决定不再采用
 * `cosyvoice-v3.5-plus`**，故缺省链只剩 `cosyvoice-v3.5-flash`（0.8 元/万字符、额度池独立）。
 * ⚠️ 「轮到腾讯」不在这里，而是 `TTS_BACKEND` 链上的下一个后端（缺省 `cosyvoice,tencent,piper`）。
 * 链本身仍是配置驱动的：`DASHSCOPE_TTS_MODELS` 想再加模型随时可加，本常量只是缺省值。
 */
const COSY_DEFAULT_MODELS: readonly string[] = ["cosyvoice-v3.5-flash"];

/**
 * CosyVoice **系统音色**的命名特征：一律以 `long` 开头
 * （longanyang / longxiaochun / longanhuan …）。
 * 克隆/设计音色是用户自定义前缀（如 `myvoice-xxxx`），不匹配该正则。
 */
const COSY_SYSTEM_VOICE_RE = /^long/i;

/**
 * **没有系统音色**的模型族：`cosyvoice-v3.5-*`（当前在用的是 `-flash`）只支持
 * 「声音复刻 / 声音设计」场景（官方原话「仅支持声音设计和声音复刻场景(无系统音色)」）
 * → 必须显式提供音色 ID。
 */
const COSY_NO_SYSTEM_VOICE_RE = /^cosyvoice-v3\.5/;

/** v3 / v2 系列的系统音色缺省（官方 HTTP 示例所用，与 v3-flash / v3-plus 配套）。 */
const COSY_SYSTEM_VOICE_DEFAULT = "longanyang";

/**
 * 分片上限（字符）。
 * ⚠️ 官方 HTTP API 文档**未给出 `input.text` 的长度上限**（只给了 `instruction` 的 100 字符限制），
 * 故此处取保守值 1900：低于业内常见的 2000 上限，且高于本项目口播稿上限
 * （`SCRIPT_MAX_CHARS = 1300`）→ 常规情况恒为单片，不触发 ffmpeg 重编码，保留百炼原生音质。
 * 若日后要念长文，调 `DASHSCOPE_TTS_CHUNK_LIMIT`，并注意分片 >1 会走 16k 重编码拼接。
 */
const COSY_DEFAULT_CHUNK_LIMIT = 1900;

/** 一个合成目标 = 模型 + 音色（同一模型链里各模型可配不同音色）。 */
export interface CosyTarget {
  model: string;
  /** 显式指定的音色 ID；空串表示「按模型族取缺省」（见 `resolveVoice`）。 */
  voice: string;
}

/**
 * 解析 `DASHSCOPE_TTS_MODELS`：逗号分隔，每项写 `模型` 或 **`模型@音色ID`**。
 *
 * **为什么允许逐模型指定音色**：`cosyvoice-v3.5-*` 只认「声音复刻 / 设计音色」，
 * 而这类音色在创建（voice-enrollment）时是**绑定目标模型**的 →
 * 同一个模型链里的两个模型可能需要**不同的音色 ID**。未写 `@音色` 的项回落到
 * `DASHSCOPE_TTS_VOICE`；再没有就按模型族取缺省（v3.5 系列无缺省可用，会被跳过）。
 *
 * @param rawModels 原始串；空 / 未设 → 用缺省模型链
 * @param explicitVoice `DASHSCOPE_TTS_VOICE` 的值
 */
export function parseModelChain(rawModels: string | undefined, explicitVoice = ""): CosyTarget[] {
  const src = (rawModels ?? "").trim();
  const items = src ? src.split(",") : [...COSY_DEFAULT_MODELS];
  const out: CosyTarget[] = [];
  for (const raw of items) {
    const item = raw.trim();
    if (!item) continue;
    const at = item.indexOf("@");
    const model = (at >= 0 ? item.slice(0, at) : item).trim();
    if (!model) continue;
    const voice = (at >= 0 ? item.slice(at + 1) : "").trim() || explicitVoice;
    out.push({ model, voice });
  }
  if (!out.length) throw new Error(`DASHSCOPE_TTS_MODELS=${src} 未解析出任何模型`);
  return out;
}

/** 该目标实际使用的音色；`null` = 该模型族没有可用缺省（v3.5 系列），必须显式给。 */
export function resolveVoice(target: CosyTarget): string | null {
  if (target.voice) return target.voice;
  return COSY_NO_SYSTEM_VOICE_RE.test(target.model) ? null : COSY_SYSTEM_VOICE_DEFAULT;
}

/**
 * 该 (模型, 音色) 组合是否可用；返回**不可用原因**（`null` = 可用）。
 *
 * 刻意**不抛错**：单个模型不可用（缺音色 ID / 音色与模型不匹配）不该拖垮整条模型链 ——
 * 上层会 `::warning::` 记一笔并继续试下一个模型（这正是「某个模型不可用就换下一个」的前提）。
 * 提前判定的价值：拿一条「该模型不支持此音色」的 400，代价是一次真实请求 + 一句难懂的报错。
 */
export function modelUnavailableReason(model: string, voice: string | null): string | null {
  if (process.env.DASHSCOPE_TTS_VOICE_FORCE === "true") return null;
  if (!voice) {
    if (COSY_NO_SYSTEM_VOICE_RE.test(model)) {
      return (
        `${model} 没有系统音色（仅声音复刻/声音设计音色）→ 需要音色 ID：` +
        `设 DASHSCOPE_TTS_VOICE=<音色ID>，或在 DASHSCOPE_TTS_MODELS 里写 ${model}@<音色ID>`
      );
    }
    return `${model} 未指定音色`;
  }
  if (COSY_NO_SYSTEM_VOICE_RE.test(model) && COSY_SYSTEM_VOICE_RE.test(voice)) {
    return (
      `${model} 无系统音色，而 voice=${voice} 看起来是系统音色` +
      `（系统音色只配 cosyvoice-v3-flash / v3-plus）`
    );
  }
  return null;
}

/**
 * 解析并**筛出可用**的模型链（导出供测试与诊断）。
 *
 * @returns `usable` 保持声明顺序的可用目标；`skipped` 每项一句「模型（原因）」供告警。
 */
export function resolveCosyTargets(
  rawModels?: string,
  explicitVoice?: string,
): { usable: CosyTarget[]; skipped: string[] } {
  const targets = parseModelChain(
    rawModels ?? process.env.DASHSCOPE_TTS_MODELS,
    explicitVoice ?? (process.env.DASHSCOPE_TTS_VOICE ?? "").trim(),
  );
  const usable: CosyTarget[] = [];
  const skipped: string[] = [];
  for (const t of targets) {
    const voice = resolveVoice(t);
    const reason = modelUnavailableReason(t.model, voice);
    if (reason) {
      skipped.push(`${t.model}（${reason}）`);
      continue;
    }
    usable.push({ model: t.model, voice: voice as string });
  }
  return { usable, skipped };
}

interface CosyConfig {
  apiKey: string;
  endpoint: string;
  targets: CosyTarget[];
  format: string;
  sampleRate: number;
  rate: number;
  chunkLimit: number;
  aigcTag: boolean;
}

/** 官方专属域名（推荐）：`https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/...`；否则用通用域名。 */
function cosyEndpoint(): string {
  const override = (process.env.DASHSCOPE_TTS_ENDPOINT ?? "").trim();
  if (override) return override;
  const ws = (process.env.DASHSCOPE_WORKSPACE_ID ?? "").trim();
  const host = ws ? `${ws}.cn-beijing.maas.aliyuncs.com` : "dashscope.aliyuncs.com";
  return `https://${host}/api/v1/services/audio/tts/SpeechSynthesizer`;
}

/** 读取百炼配置（**运行时读 env**，与腾讯那组模块加载期常量不同 —— 便于脚本/测试切换）。 */
function cosyConfig(): CosyConfig {
  return {
    apiKey: (process.env.DASHSCOPE_API_KEY ?? "").trim(),
    endpoint: cosyEndpoint(),
    targets: resolveCosyTargets().usable,
    format: (process.env.DASHSCOPE_TTS_FORMAT ?? "").trim() || "mp3",
    sampleRate: parseInt(process.env.DASHSCOPE_TTS_SAMPLE_RATE || "24000", 10),
    rate: parseFloat(process.env.DASHSCOPE_TTS_RATE || "1"),
    chunkLimit: parseInt(
      process.env.DASHSCOPE_TTS_CHUNK_LIMIT || String(COSY_DEFAULT_CHUNK_LIMIT),
      10,
    ),
    aigcTag: process.env.DASHSCOPE_TTS_AIGC_TAG === "true",
  };
}

/** 支持 `enable_aigc_tag` 的模型（官方清单）。 */
const COSY_AIGC_CAPABLE = new Set([
  "cosyvoice-v3-flash",
  "cosyvoice-v3-plus",
  "cosyvoice-v2",
  "qwen-audio-3.0-tts-plus",
  "qwen-audio-3.1-tts-flash",
  "qwen-audio-3.0-tts-flash",
]);

/** mp3 魔数判定（ID3 头 或 MPEG 帧同步）—— 用于拦截「名为 .mp3 的非 mp3 容器」。 */
export function looksLikeMp3(b: Buffer): boolean {
  if (b.length < 3) return false;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return true; // "ID3"
  return b[0] === 0xff && (b[1]! & 0xe0) === 0xe0; // 帧同步 111xxxxx
}

/** 非 mp3 音频 → mp3（ffmpeg）。仅当 `DASHSCOPE_TTS_FORMAT` 被改成 wav/pcm/opus 时才会走到。 */
function transcodeToMp3(buf: Buffer): Buffer {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tts-xcode-"));
  const src = path.join(tmp, "in.bin");
  const dst = path.join(tmp, "out.mp3");
  try {
    fs.writeFileSync(src, buf);
    const r = spawnSync("ffmpeg", [
      "-y", "-i", src, "-ar", "24000", "-ac", "1", "-codec:a", "libmp3lame", "-q:a", "4", dst,
    ]);
    if (r.status !== 0) {
      const err = (r.stderr || Buffer.alloc(0)).toString().slice(0, 300);
      throw new Error(`ffmpeg 转码失败（exit ${r.status}）：${err}`);
    }
    return fs.readFileSync(dst);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

interface CosyResponse {
  request_id?: string;
  /** 错误码（DashScope 业务错误与 HTTP 非 2xx 都会带）。 */
  code?: string;
  message?: string;
  output?: {
    finish_reason?: string;
    audio?: { data?: string; url?: string; id?: string; expires_at?: number };
  };
  usage?: { characters?: number };
}

/**
 * 百炼 HTTP 错误（带状态码与业务码）。
 * 之所以要**带上状态码**：到底该「重试同一模型」「换下一个模型」还是「放弃整个百炼后端」，
 * 取决于它是「这个模型/额度的问题」还是「这把 Key 的问题」—— 只看 message 字符串区分不出来。
 */
export class CosyHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CosyHttpError";
  }
}

/**
 * 错误分级 —— 决定后续动作：
 *  - `transient`：网络异常 / 5xx / 429 限流 → 同一模型退避重试；
 *  - `model`    ：其它 4xx（额度耗尽、参数被拒、该模型不支持此音色）→ **换下一个模型**；
 *  - `provider` ：401 / 403（Key 无效或无权限）→ **换模型毫无意义**（同一把 Key），终止本后端。
 */
export type CosyErrorKind = "transient" | "model" | "provider";

export function cosyErrorKind(e: unknown): CosyErrorKind {
  if (!(e instanceof CosyHttpError)) return "transient"; // fetch 抛出的网络异常等
  if (e.status === 401 || e.status === 403) return "provider";
  if (e.status === 429 || e.status >= 500) return "transient";
  return "model";
}

/** 单次百炼合成一片：POST → 取音频（base64 优先，其次 24h 有效的 url 再下载）。 */
async function cosySynthChunk(
  spoken: string,
  cfg: CosyConfig,
  target: CosyTarget,
  index: number,
): Promise<{ audio: Buffer; characters: number }> {
  const input: Record<string, unknown> = {
    text: spoken,
    voice: target.voice,
    format: cfg.format,
    sample_rate: cfg.sampleRate,
    // 中文简报：显式声明目标语言（官方建议在数字/缩写读法不合预期时使用）
    language_hints: ["zh"],
  };
  if (cfg.rate !== 1) input.rate = cfg.rate;
  if (cfg.aigcTag) {
    if (COSY_AIGC_CAPABLE.has(target.model)) input.enable_aigc_tag = true;
    else console.warn(`⚠️ ${target.model} 不支持 enable_aigc_tag，已忽略（AIGC 水印未打）`);
  }

  const where = `${target.model} 第 ${index} 片`;
  const resp = await fetch(cfg.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: target.model, input }),
  });
  const raw = await resp.text();
  let data: CosyResponse = {};
  try {
    data = JSON.parse(raw) as CosyResponse;
  } catch {
    // 非 JSON（网关错误页 / 空响应）→ 下面统一按 raw 报错
  }
  if (!resp.ok || data.code) {
    const detail = data.message || data.code || raw.slice(0, 300) || "(空响应体)";
    throw new CosyHttpError(
      `百炼 ${where} 失败（HTTP ${resp.status}${data.code ? ` / ${data.code}` : ""}）：${detail}`,
      resp.status,
      data.code,
    );
  }

  const audio = data.output?.audio;
  let buf: Buffer;
  if (audio?.data) {
    // 流式/部分模型以 base64 回传；非流式官方示例中该字段为空串
    buf = Buffer.from(audio.data, "base64");
  } else if (audio?.url) {
    const dl = await fetch(audio.url);
    if (!dl.ok) {
      // 音频 URL 下载失败：URL 24h 内有效，属瞬时问题，重试有意义
      throw new CosyHttpError(
        `百炼音频下载失败（HTTP ${dl.status}）：${audio.url.slice(0, 120)}`,
        dl.status,
      );
    }
    buf = Buffer.from(await dl.arrayBuffer());
  } else {
    // HTTP 200 却没有音频 → 请求被受理但没产出，多半是参数/模型问题 → 换模型
    throw new CosyHttpError(
      `百炼 ${where} 返回缺少音频（output.audio 的 url/data 均为空）：${raw.slice(0, 300)}`,
      200,
      "NoAudio",
    );
  }
  if (buf.length < 1000) throw new Error(`百炼 ${where} 返回异常偏小：${buf.length} bytes`);
  return { audio: buf, characters: data.usage?.characters ?? 0 };
}

/** 单片合成；**瞬时错误就地退避重试**，永久性错误（换模型/换后端才有意义）立即上抛。 */
async function cosySynthChunkWithRetry(
  spoken: string,
  cfg: CosyConfig,
  target: CosyTarget,
  index: number,
): Promise<{ audio: Buffer; characters: number }> {
  let last: unknown;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      return await cosySynthChunk(spoken, cfg, target, index);
    } catch (e) {
      last = e;
      if (cosyErrorKind(e) !== "transient") throw e;
      console.warn(
        `⚠️ 百炼 ${target.model} 第 ${index} 片第 ${attempt}/${MAX_RETRY} 次瞬时失败：` +
          `${e instanceof Error ? e.message : e}`,
      );
      if (attempt < MAX_RETRY) await sleep(3000 * attempt);
    }
  }
  throw last;
}

/** 用单个模型合成整篇（分片 + 逐片发音改写 + 容器归一），返回可直接交给 mergeMp3 的分片。 */
async function cosyRenderWithModel(
  target: CosyTarget,
  chunks: string[],
  cfg: CosyConfig,
  mode: PronounceMode,
  billing: { chars: number },
): Promise<Buffer[]> {
  const parts: Buffer[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const spoken = toSpeechText(chunks[i], mode);
    const r = await cosySynthChunkWithRetry(spoken, cfg, target, i);
    parts.push(r.audio);
    billing.chars += r.characters;
  }
  // 容器归一：mergeMp3 在「单片」时走字节直拷，若 format 非 mp3 会产出「名为 .mp3 的 wav」
  return parts.map((p) => {
    if (looksLikeMp3(p)) return p;
    if (parts.length === 1) {
      console.warn(`⚠️ 百炼返回非 mp3 容器（format=${cfg.format}），ffmpeg 转码后再落盘`);
    }
    return transcodeToMp3(p);
  });
}

/**
 * 百炼 CosyVoice 合成整篇口播稿。
 *
 * **模型链语义（2026-09-21 用户定案）**：按 `DASHSCOPE_TTS_MODELS` 的声明顺序逐个模型试 ——
 * 前一个失败（额度耗尽 / 参数被拒 / 瞬时错误退避后仍失败）就换下一个；
 * **全部失败才抛错**，由 `TTS_BACKEND` 链的下一环（腾讯）接手。
 * 唯一例外：401/403 属**凭据**问题，换模型注定同样失败 → 立刻终止本后端，让链上下一环接手。
 *
 * 导出供试听 / A-B 盲听脚本复用（与 `synthTencent` 对称）。
 */
export async function synthCosyvoice(text: string, outPath: string, date: string): Promise<void> {
  const { usable, skipped } = resolveCosyTargets();
  for (const s of skipped) console.warn(`::warning::百炼跳过模型 ${s}`);
  if (!usable.length) {
    throw new Error(
      `百炼没有可用模型（${skipped.join("；") || "模型链为空"}）。` +
        `cosyvoice-v3.5-* 无系统音色 → 请设 DASHSCOPE_TTS_VOICE=<复刻/设计音色ID>，` +
        `或在 DASHSCOPE_TTS_MODELS 里写成 模型@音色ID`,
    );
  }

  const cfg: CosyConfig = { ...cosyConfig(), targets: usable };
  const mode = resolvePronounceMode("cosyvoice");
  const chunks = splitText(text, cfg.chunkLimit);
  console.log(
    `ℹ️ 百炼 CosyVoice TTS：共 ${text.length} 字，分 ${chunks.length} 片合成；` +
      `模型链 ${usable.map((t) => `${t.model}(${t.voice})`).join(" → ")}；` +
      `format=${cfg.format}；发音策略 ${mode}`,
  );

  const billing = { chars: 0 };
  const failures: string[] = [];
  try {
    for (const target of usable) {
      let parts: Buffer[];
      try {
        parts = await cosyRenderWithModel(target, chunks, cfg, mode, billing);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (cosyErrorKind(e) === "provider") {
          // 同一把 Key：换模型注定同样失败 → 立刻放弃整个百炼后端，交给链上的腾讯
          throw new Error(`百炼不可用（凭据/权限问题，换模型无意义）→ 交给下一个后端：${msg}`);
        }
        failures.push(`${target.model}：${msg}`);
        console.warn(`::warning::百炼 ${target.model} 合成失败 → 换下一个模型：${msg}`);
        continue;
      }
      // 拼接放在 try 之外：ffmpeg 失败不是「模型的问题」，不该触发换模型重试
      mergeMp3(parts, outPath);
      if (failures.length) {
        console.warn(
          `::warning::百炼已降级到 ${target.model} 合成（前面失败：${failures.join("；")}）`,
        );
      }
      return;
    }
    throw new Error(`百炼模型链全部失败：${failures.join("；")}`);
  } finally {
    // 失败的模型可能已为部分分片计费，故放在 finally 里如实报出
    if (billing.chars > 0) {
      console.log(`ℹ️ 百炼计费字符（usage.characters 合计）：${billing.chars}`);
    }
  }
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
/**
 * 外层重试包装。
 *
 * @param attempts 尝试次数。**后端自带内层重试时须传 1**，否则会「内层链 × 外层重试」相乘
 *   （百炼就是这样：它内部已有「模型链 + 分片瞬时重试」，再叠 3 次外层重试等于把整条
 *   模型链跑三遍，纯浪费且拖慢降级到腾讯的速度）。
 */
async function runBackend(
  name: TtsBackendName,
  fn: (t: string, o: string, d: string) => void | Promise<void>,
  text: string,
  out: string,
  date: string,
  attempts: number = MAX_RETRY,
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await fn(text, out, date);
      const size = fs.statSync(out).size;
      if (size < MIN_BYTES) throw new Error(`音频异常偏小：${size} bytes`);
      console.log(`✅ TTS 成功（${name}）：${out}（${size} bytes）`);
      return true;
    } catch (e) {
      console.warn(`⚠️ ${name} 第 ${attempt}/${attempts} 次失败：${e instanceof Error ? e.message : e}`);
      if (attempt < attempts) await sleep(3000 * attempt);
    }
  }
  return false;
}

/** Piper CLI 是否可用（腾讯包月场景 workflow 不再预装 Piper，仅失败兜底时安装）。 */
function piperAvailable(): boolean {
  const r = spawnSync("sh", ["-c", "command -v piper"], { stdio: "ignore" });
  return r.status === 0;
}

// ---------- 后端注册表 + 候选链 ----------
/** 合法后端名（与 `contracts/pipeline.ts#TtsBackendName` 对应）。 */
const TTS_BACKEND_NAMES: readonly TtsBackendName[] = ["tencent", "cosyvoice", "piper"];

export function isTtsBackendName(v: string): v is TtsBackendName {
  return (TTS_BACKEND_NAMES as readonly string[]).includes(v);
}

/**
 * 缺省候选链（2026-09-21 用户定案）：
 * **百炼 CosyVoice 优先 → 腾讯云兜底 → Piper 本地最后一道**。
 *
 * 百炼内部还有自己的模型链（缺省仅 `cosyvoice-v3.5-flash`，见 `COSY_DEFAULT_MODELS`），
 * 所以整体降级顺序是：v3.5-flash → 腾讯 → Piper。
 * 回退到旧行为：`TTS_BACKEND=tencent,piper`。
 */
export const DEFAULT_BACKEND_CHAIN: readonly TtsBackendName[] = ["cosyvoice", "tencent", "piper"];

/**
 * 解析 `TTS_BACKEND` 候选链（逗号分隔，去重、忽略空白）。
 *
 * **语义要点**：链是「显式」的。写成 `cosyvoice` 就是只用 cosyvoice，失败即失败，
 * **不会静默换成腾讯** —— 否则做 A/B 盲听时可能拿到非目标后端的音频而毫不知情。
 * 需要兜底就显式写 `cosyvoice,piper`。
 *
 * @param raw 覆盖入参（测试用）；缺省读 `process.env.TTS_BACKEND`。
 */
export function resolveBackendChain(
  raw: string | undefined = process.env.TTS_BACKEND,
): TtsBackendName[] {
  const src = (raw ?? "").trim();
  if (!src) return [...DEFAULT_BACKEND_CHAIN];
  const names: TtsBackendName[] = [];
  const bad: string[] = [];
  for (const part of src.split(",")) {
    const n = part.trim().toLowerCase();
    if (!n) continue;
    if (isTtsBackendName(n)) {
      if (!names.includes(n)) names.push(n);
    } else {
      bad.push(n);
    }
  }
  if (bad.length) {
    throw new Error(
      `TTS_BACKEND 含未知后端：${bad.join(", ")}（可选：${TTS_BACKEND_NAMES.join(" | ")}）`,
    );
  }
  if (!names.length) throw new Error(`TTS_BACKEND=${src} 未解析出任何有效后端`);
  return names;
}

/** 一个后端的装配契约（就绪性 + 合成入口）。 */
interface TtsBackendSpec {
  name: TtsBackendName;
  /** 凭据 / 外部依赖是否就绪；不就绪则跳过并打日志（取代原先层层 if 特判）。 */
  ready(): { ok: boolean; reason?: string };
  synth(text: string, out: string, date: string): void | Promise<void>;
  /**
   * 外层重试次数；缺省 `MAX_RETRY`。
   * 后端**自带内层重试/降级链**时须显式写 1，避免两层相乘（见 `runBackend`）。
   */
  maxAttempts?: number;
}

/**
 * 后端注册表。**新增后端只改这里 + `TtsBackendName` + 渲染层徽章文案表。**
 * 腾讯那组的凭据仍沿用模块加载期常量（保持与重构前一致），
 * 百炼与 Piper 走运行时判定（便于脚本切换 / 测试注入）。
 */
const BACKENDS: Record<TtsBackendName, TtsBackendSpec> = {
  tencent: {
    name: "tencent",
    ready: () =>
      TCE_SECRET_ID && TCE_SECRET_KEY
        ? { ok: true }
        : { ok: false, reason: "未配置 TENCENTCLOUD_SECRET_ID/KEY" },
    synth: (t, o, d) => synthTencent(t, o, d),
  },
  cosyvoice: {
    name: "cosyvoice",
    ready: () =>
      (process.env.DASHSCOPE_API_KEY ?? "").trim()
        ? { ok: true }
        : { ok: false, reason: "未配置 DASHSCOPE_API_KEY" },
    synth: (t, o, d) => synthCosyvoice(t, o, d),
    // 内部已有「模型链 + 分片瞬时重试」→ 外层不再叠重试
    maxAttempts: 1,
  },
  piper: {
    name: "piper",
    ready: () => (piperAvailable() ? { ok: true } : { ok: false, reason: "本机未安装 Piper" }),
    synth: (t, o) => synthPiper(t, o),
  },
};

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

/**
 * 按 `TTS_BACKEND` 候选链依次尝试合成，返回**实际成功**的后端。
 *
 * 与重构前（硬编码「腾讯 → Piper」）的行为等价条件：`TTS_BACKEND` 未设
 * （缺省链 `tencent,piper`）+ 依赖就绪性判定不变。
 * 失败语义不变：全链失败则抛错，由调用方 catch 降级为「页面无播放器」（不阻断发布）。
 */
export async function synthesizeAudio(date: string, script: string): Promise<TtsResult> {
  if (!script || script.trim().length < 20) {
    throw new Error(`口播稿过短（${script?.length ?? 0} 字），中止 TTS`);
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-"));
  const out = path.join(workDir, `briefing-${date}.mp3`);
  try {
    const durationSec = Math.max(1, Math.round(script.length / 5.2)); // 与 CHARS_PER_SEC 对齐（腾讯 Speed 实测 ~5.3 字/秒）
    const chain = resolveBackendChain();
    const attempted: TtsBackendName[] = [];

    for (const name of chain) {
      const spec = BACKENDS[name];
      const ready = spec.ready();
      if (!ready.ok) {
        console.log(`ℹ️ TTS 跳过 ${name}：${ready.reason ?? "不可用"}`);
        continue;
      }
      attempted.push(name);
      if (await runBackend(name, spec.synth, script, out, date, spec.maxAttempts ?? MAX_RETRY)) {
        const archived = writeMp3Both(out, date);
        return { mp3Path: archived, durationSec, backend: name };
      }
      if (name !== chain[chain.length - 1]) {
        console.warn(`⚠️ ${name} 连续失败，链上还有下一个后端，继续尝试……`);
      }
    }

    // —— 全链失败 ——
    // 沿用既有「待兜底标记」机制：**云端后端确实被尝试过**且本机无 Piper 时，
    // 写标记供 workflow 装好 Piper 后调 `npm run tts:fallback` 补合成。
    // （条件含 `attempted.some(≠piper)`：若腾讯/百炼根本没配凭据、只是被跳过，
    //   写标记没有意义，与原实现的 `if (TCE_SECRET_ID && TCE_SECRET_KEY)` 语义一致。）
    const cloudAttempted = attempted.some((n) => n !== "piper");
    if (cloudAttempted && chain.includes("piper") && !piperAvailable()) {
      try {
        const dir = path.resolve(process.cwd(), "daily_reports", date);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, "tts-fallback-needed.txt"),
          `${new Date().toISOString()} 云端 TTS 合成失败且无 Piper，待兜底补合成\n`,
          "utf-8",
        );
      } catch {
        // 写标记失败不影响主流程（照常抛错降级为无播放器）
      }
    }
    const chainLabel = chain.join(" → ");
    if (cloudAttempted && chain.includes("piper") && !piperAvailable()) {
      throw new Error(`TTS 链全部失败（${chainLabel}），且 CI 未安装 Piper（降级：本轮无音频，不阻断发布）`);
    }
    throw new Error(`所有 TTS 后端均失败（链：${chainLabel}）`);
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
