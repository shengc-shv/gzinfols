/**
 * TTS 后端 A/B **盲听**包（2026-09-21 新增）
 *
 * 用途：拿**同一段真实口播稿**分别送不同后端合成，输出**匿名音频**，
 * 让用户先靠耳朵判断「哪个更像人能听」，再打开答案对照 —— 避免「知道是腾讯/百炼
 * 之后的先入为主」。这也是选型（是否把生产切到百炼）唯一可信的依据。
 *
 * 与 `tts-probe.ts` 的分工：
 *   - `tts-probe`：**同一后端**下比较「AUM 的 8 种写法」哪个读得对（发音策略选型）；
 *   - `tts-ab`   ：**同一段文本**下比较「不同后端」哪个听感好（后端选型）。
 *
 * 用法（密钥只在本机使用，不落盘、不上传）：
 *
 *   # 只比腾讯 vs 百炼（缺哪个密钥就自动跳过哪个，至少要有两个才构成盲听）
 *   DASHSCOPE_API_KEY=sk-xxx \
 *   TENCENTCLOUD_SECRET_ID=xxx TENCENTCLOUD_SECRET_KEY=yyy \
 *     npm run tts:ab
 *
 *   # 指定稿子 / 指定后端 / 指定口径日期
 *   npm run tts:ab -- --script history/2026-09-21/audio_script.txt
 *   npm run tts:ab -- --backends tencent,cosyvoice
 *   npm run tts:ab -- --date 2026-09-21
 *
 * 产出 `outputs/tts-ab/`：
 *   - `A.mp3` / `B.mp3` …   匿名音频（**顺序已随机打乱**，文件名不含后端名）
 *   - `口播稿.txt`          本次使用的文本（可边听边对）
 *   - `盲听答案（先听再打开）.txt`   标签 ↔ 后端对照（含模型/音色/耗时/字节数）
 *
 * ⚠️ 注意：合成过程的控制台日志会带后端名（如「百炼 CosyVoice TTS：…」）。
 *    若要严格盲听，**先只听音频、别回看终端**。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ⚠️ 必须在 import tts 之前：`adapters/tts.ts` 的腾讯密钥是**模块加载期常量**，
// 晚于它 import 就会读不到 .env 里的值（tts-fallback.ts 的注释记着同一个坑）。
import "./_env";

import { isTtsBackendName, synthCosyvoice, synthTencent } from "../lib/adapters/tts";
import type { TtsBackendName } from "../lib/contracts/pipeline";

/** 盲听支持的后端（Piper 需本机装 CLI，不属于本次选型比较范围）。 */
const AB_BACKENDS: readonly TtsBackendName[] = ["tencent", "cosyvoice"];

const SYNTH: Record<string, (t: string, o: string, d: string) => Promise<void>> = {
  tencent: synthTencent,
  cosyvoice: synthCosyvoice,
};

/** 兜底样例：含 AUM（可顺带听出各后端的缩写读法）与真实业务语气。 */
const FALLBACK_SCRIPT = [
  "早上好。先看今日定调。",
  "科技与政策共振，建议关注零售业务机会。",
  "接下去看今日必读。",
  "某行发布 AI 中台，具备零售AUM商机的，可提前备好卖点和话术。",
  "接下去是商机洞察。",
  "关注客户资金归集需求，建议评估相关产品动作。",
  "今天播报结束。",
].join("");

interface Args {
  script?: string;
  date?: string;
  backends?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = argv[i + 1];
    if ((a === "--script" || a === "--date" || a === "--backends") && val && !val.startsWith("--")) {
      if (a === "--script") out.script = val;
      else if (a === "--date") out.date = val;
      else out.backends = val;
      i++;
    }
  }
  return out;
}

/** 取最新一期归档口播稿（daily_reports 优先于 history，因为前者是本次运行产物）。 */
function latestScriptFile(): { file: string; date: string } | null {
  const roots = ["daily_reports", "history"];
  const found: { file: string; date: string }[] = [];
  for (const root of roots) {
    const dir = path.resolve(process.cwd(), root);
    if (!fs.existsSync(dir)) continue;
    for (const d of fs.readdirSync(dir)) {
      const f = path.join(dir, d, "audio_script.txt");
      if (fs.existsSync(f)) found.push({ file: f, date: d });
    }
  }
  if (!found.length) return null;
  // 目录名即 YYYY-MM-DD，按字典序降序即时间降序
  found.sort((a, b) => b.date.localeCompare(a.date));
  return found[0]!;
}

function resolveScript(args: Args): { text: string; from: string; date: string } {
  if (args.script) {
    const p = path.resolve(process.cwd(), args.script);
    if (!fs.existsSync(p)) throw new Error(`--script 指定的文件不存在：${p}`);
    const m = /(\d{4}-\d{2}-\d{2})/.exec(p);
    return { text: fs.readFileSync(p, "utf8").trim(), from: p, date: args.date ?? m?.[1] ?? "ab-probe" };
  }
  const latest = latestScriptFile();
  if (latest) {
    return {
      text: fs.readFileSync(latest.file, "utf8").trim(),
      from: latest.file,
      date: args.date ?? latest.date,
    };
  }
  return { text: FALLBACK_SCRIPT, from: "(内置兜底样例)", date: args.date ?? "ab-probe" };
}

/** Fisher–Yates（用 CSPRNG，避免 Math.random 的可预测性影响「盲」）。 */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const wantRaw = (args.backends ?? AB_BACKENDS.join(","))
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const unsupported = wantRaw.filter((n) => !(AB_BACKENDS as readonly string[]).includes(n));
  if (unsupported.length) {
    throw new Error(
      `--backends 含不支持的值：${unsupported.join(", ")}（可选：${AB_BACKENDS.join(" | ")}）`,
    );
  }
  if (wantRaw.length < 2) {
    throw new Error("盲听至少需要 2 个后端（例如 --backends tencent,cosyvoice）");
  }
  // 上面已校验取值合法，此处收窄为契约类型
  const want = wantRaw as TtsBackendName[];
  if (!want.every((n) => isTtsBackendName(n))) {
    throw new Error(`--backends 校验异常：${want.join(", ")}`);
  }

  const { text, from, date } = resolveScript(args);
  if (text.length < 20) throw new Error(`口播稿过短（${text.length} 字），中止`);

  const outDir = path.resolve(process.cwd(), "outputs", "tts-ab");
  fs.mkdirSync(outDir, { recursive: true });

  // 先随机打乱「后端 → 标签」的映射，再按标签顺序合成（标签与后端名解耦）
  const labels = want.map((_, i) => String.fromCharCode(65 + i)); // A / B / C …
  const backendByLabel = new Map<string, TtsBackendName>();
  const shuffled = shuffle([...want]);
  labels.forEach((l, i) => backendByLabel.set(l, shuffled[i]!));

  console.log(`🎧 A/B 盲听包：${want.length} 个后端 / 口播稿 ${text.length} 字`);
  console.log(`   稿子来源：${from}`);
  console.log(`   产出目录：${outDir}`);
  console.log("");

  const results: { label: string; backend: TtsBackendName; file: string; ms: number; bytes: number }[] = [];
  const failed: { backend: TtsBackendName; reason: string }[] = [];

  for (const label of labels) {
    const backend = backendByLabel.get(label)!;
    const file = path.join(outDir, `${label}.mp3`);
    const t0 = Date.now();
    try {
      await SYNTH[backend]!(text, file, date);
      const bytes = fs.statSync(file).size;
      results.push({ label, backend, file, ms: Date.now() - t0, bytes });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      failed.push({ backend, reason });
      console.error(`  ❌ 标签 ${label} 合成失败：${reason}`);
    }
  }

  if (results.length < 2) {
    console.error(
      [
        "",
        `😵 只有 ${results.length} 条成功，无法构成盲听（需要 ≥2）。`,
        "",
        "常见原因：",
        "  - 缺密钥：腾讯 TENCENTCLOUD_SECRET_ID/KEY、百炼 DASHSCOPE_API_KEY（缺哪个就跳过哪个）",
        "  - 百炼 key 非北京地域（新加坡 key 不通用）",
        "  - 模型链不可用：cosyvoice-v3.5-* 无系统音色，须设 DASHSCOPE_TTS_VOICE=<复刻/设计音色ID>",
        "    （当前模型链与跳过原因见上方 ::warning:: 行）",
      ].join("\n"),
    );
    process.exit(1);
  }

  // 口播稿留档，便于边听边对
  fs.writeFileSync(path.join(outDir, "口播稿.txt"), `${text}\n`, "utf8");

  const lines = [
    "TTS 后端 A/B 盲听 · 答案（先听再打开！）",
    "=".repeat(56),
    "",
    `稿子来源：${from}（${text.length} 字，口径日期 ${date}）`,
    `生成时间序：${labels.join(" → ")}（**标签顺序已随机打乱，与后端名无对应关系**）`,
    "",
    "标签   后端         文件      耗时      体积",
    "-".repeat(56),
    ...results.map(
      (r) =>
        `${r.label}      ${r.backend.padEnd(12)} ${path.basename(r.file).padEnd(9)} ` +
        `${(r.ms / 1000).toFixed(1)}s`.padEnd(9) + ` ${(r.bytes / 1024).toFixed(0)} KB`,
    ),
  ];
  if (failed.length) {
    lines.push("", "失败项：", ...failed.map((f) => `  - ${f.backend}：${f.reason}`));
  }
  lines.push(
    "",
    "怎么听：",
    "  1. 先只听 A.mp3 / B.mp3（别打开本文件），凭听感判断更喜欢哪个；",
    "  2. 重点听三处：① 断句是否自然 ②「AUM」有没有被连读成 /aʊm/ ③ 数字/专有名词读法；",
    "  3. 再打开本文件对答案，然后告诉我「X 号更好」即可。",
    "",
    "口径提示（对照生产）：",
    "  - 腾讯云：TTS_VOICE_TYPE / TTS_SPEED / TTS_PRONOUNCE=ssml-say-as（AUM 逐字母读）",
    "  - 百炼  ：DASHSCOPE_TTS_MODEL / DASHSCOPE_TTS_VOICE / DASHSCOPE_TTS_RATE / " +
      "TTS_PRONOUNCE_COSYVOICE=translit（AUM →「诶优艾姆」，刻意不用腾讯 SSML 方言）",
    "  - 语速口径不同源（腾讯 Speed=1.2 vs 百炼 rate=1.0），若听感快慢差异明显，" +
      "可调 DASHSCOPE_TTS_RATE 后再跑一轮。",
  );

  const answerFile = path.join(outDir, "盲听答案（先听再打开）.txt");
  fs.writeFileSync(answerFile, lines.join("\n") + "\n", "utf8");

  console.log("");
  console.log(`🔊 匿名音频：${results.map((r) => path.basename(r.file)).join(" / ")} → ${outDir}`);
  console.log(`📄 口播稿：${path.join(outDir, "口播稿.txt")}`);
  console.log(`🙈 答案（先听再打开）：${answerFile}`);
  console.log("👉 听完告诉我「A 还是 B 更好」，我据此决定是否把生产切到百炼。");
}

main().catch((e) => {
  console.error(`💥 A/B 盲听包生成失败：${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
