/**
 * TTS 音频合成冒烟验证（2026-10-26 sc：单独验证 CI 侧 ffmpeg + 腾讯合成链路是否可行）
 *
 * 用途：**只验证「装好 ffmpeg 之后能不能把当天口播稿合成出音频」**，不写生产数据、
 * 不改 history/、不发通知。产出落在 `outputs/tts-smoke/`（CI 里作为 artifact 上传）。
 *
 * 为什么要单独一条：
 *   10-25 出现两次 `apt-get install ffmpeg` 卡死（run 94 卡 19 分钟被取消）。
 *   改成「静态二进制 + actions/cache + timeout 硬失败」后，需要一个**独立可手动触发**的
 *   最小闭环来证明：ffmpeg 就绪 → 腾讯多片合成 → mp3 落盘，全程不碰主流程。
 *
 * 用法（CI 由 .github/workflows/tts-smoke.yml 调用）：
 *   TTS_BACKEND=tencent TENCENTCLOUD_SECRET_ID=xxx TENCENTCLOUD_SECRET_KEY=yyy \
 *     npx tsx scripts/tts-smoke.ts [YYYY-MM-DD]
 *
 * ⏰ 时区：默认日期走 `todayKey()`（北京日历日），**不用 toISOString**（那是 UTC）。
 */
import fs from "node:fs";
import path from "node:path";

// ⚠️ 必须在 import tts 之前：腾讯密钥是模块加载期常量，晚于它 import 就读不到 .env
import "./_env";

import { synthTencent, hasFfmpeg } from "../lib/adapters/tts";
import { todayKey } from "../lib/utils/time";

const CHUNK_LIMIT = 120; // 与 lib/adapters/tts.ts 的 CHUNK_LIMIT 同源（腾讯单次 150 汉字留余量）

async function main(): Promise<void> {
  const date = process.argv[2]?.trim() || todayKey();
  const scriptPath = path.resolve(process.cwd(), `history/${date}/audio_script.txt`);
  const outDir = path.resolve(process.cwd(), "outputs/tts-smoke");
  const outPath = path.join(outDir, `briefing-${date}-smoke.mp3`);

  console.log("=".repeat(60));
  console.log(`TTS 冒烟：date=${date} · backend=${process.env.TTS_BACKEND ?? "(默认链)"}`);
  console.log("=".repeat(60));

  // ---- 前置条件逐条报，失败点必须一眼可见 ----
  if (!fs.existsSync(scriptPath)) {
    console.error(`❌ 口播稿不存在：${scriptPath}`);
    console.error("   （CI 里说明该日 daily 未产出，或 date 传错）");
    process.exitCode = 2;
    return;
  }
  const text = fs.readFileSync(scriptPath, "utf8").trim();
  const chars = text.replace(/\s/g, "").length;
  const chunks = Math.ceil(chars / CHUNK_LIMIT);
  console.log(`口播稿：${chars} 字 → 预计 ${chunks} 片（单片上限 ${CHUNK_LIMIT} 字）`);
  console.log(`ffmpeg：${hasFfmpeg() ? "✅ 可用（多片拼接走重编码）" : "⛔ 不可用（多片将降级字节拼接）"}`);

  // ffmpeg 缺失时**直接失败**：本 workflow 的核心目的就是验证 ffmpeg 可用性，
  // 降级跑通会给出假阳性（"音频出来了"但音质不是线上口径）。
  if (!hasFfmpeg()) {
    console.error("❌ ffmpeg 不可用 → 冒烟失败（CI 的 Ensure ffmpeg 步骤没就绪）");
    process.exitCode = 3;
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });

  // ---- 合成（这条路径 = 线上腾讯链：分片 → 逐片发音改写 → mergeMp3 重编码）----
  const t0 = Date.now();
  try {
    await synthTencent(text, outPath, date);
  } catch (e) {
    console.error(`❌ 合成失败：${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 4;
    return;
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (!fs.existsSync(outPath)) {
    console.error("❌ 合成未报错但产物不存在");
    process.exitCode = 5;
    return;
  }
  const size = fs.statSync(outPath).size;
  console.log(`✅ 合成完成：${outPath}`);
  console.log(`   耗时 ${elapsed}s · 体积 ${size} bytes（${(size / 1024).toFixed(0)} KB）`);

  // ---- 与线上成品对照（同一天的 history/audio/briefing-<date>.mp3）----
  const basePath = path.resolve(process.cwd(), `history/${date}/audio/briefing-${date}.mp3`);
  if (fs.existsSync(basePath)) {
    const base = fs.statSync(basePath).size;
    const diff = ((size - base) / base) * 100;
    console.log(
      `   线上成品 ${base} bytes → 本次差异 ${diff >= 0 ? "+" : ""}${diff.toFixed(1)}%` +
        `（同文稿不同次合成，体积有浮动属正常；数量级一致即视为通过）`,
    );
    if (Math.abs(diff) > 60) {
      console.warn("::warning::与线上成品体积差异 >60%，请人工听一下是否截断或异常");
    }
  } else {
    console.log("   （该日无线上成品可对照 —— 仅验证合成链路可用）");
  }

  // 极小体积＝几乎肯定异常（正常 600 字口播 ≈ 400KB+）
  if (size < 50_000) {
    console.error(`❌ 产物仅 ${size} bytes，明显异常（疑似截断）`);
    process.exitCode = 6;
    return;
  }
  console.log("\n✅ 冒烟通过（ffmpeg 就绪 + 腾讯多片合成 + mp3 落盘）");
}

main();
