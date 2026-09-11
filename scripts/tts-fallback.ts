/**
 * TTS 兜底补合成（移植自 gzinfo scripts/tts-fallback.ts，按 2.0 存储模型适配）。
 *
 * 触发链路：`lib/adapters/tts.ts` 在「腾讯云合成失败 且 本机无 Piper」时，
 * 于 `daily_reports/<date>/tts-fallback-needed.txt` 写标记并降级为无播放器；
 * workflow 检测到标记后安装 Piper，再调用本脚本补合成。
 *
 * 流程：读 `<date>.json`（报告）+ store.json（executive 分稿）
 *   → assembleBriefingScript 拼口播稿 → 清掉腾讯密钥强制走 Piper
 *   → synthesizeAudio 生成 mp3 → 删除标记。
 *
 * 产物与 daily 一致：`daily_reports/<date>/audio/briefing-<date>.mp3`
 * （双路径落盘，site/audio 同步），后续 build-site / 发布步骤会正常带上播放器。
 *
 * ⚠️ 实现要点：`lib/adapters/tts.ts` 在**模块加载期**就把密钥读进常量
 * （`const TCE_SECRET_ID = process.env…`），因此必须在 import 之前删除 env，
 * 否则删除无效。故本脚本用动态 import（gzinfo 原版用静态 import 后删除，实为无效）。
 *
 * Usage:
 *   npm run tts:fallback            # 扫描全部待兜底日期
 *   npm run tts:fallback -- 2026-09-11
 */
import fs from "node:fs";
import path from "node:path";
import { loadExecStore } from "../lib/adapters/persistence";
import type { DailyReport } from "../lib/contracts/report";

const REPORTS_DIR = path.resolve(process.cwd(), "daily_reports");

// 强制走 Piper：必须在 import tts 之前清掉密钥（tts.ts 模块加载期即读取）
delete process.env.TENCENTCLOUD_SECRET_ID;
delete process.env.TENCENTCLOUD_SECRET_KEY;

function markerDates(): string[] {
  if (!fs.existsSync(REPORTS_DIR)) return [];
  return fs
    .readdirSync(REPORTS_DIR)
    .filter((d) => fs.existsSync(path.join(REPORTS_DIR, d, "tts-fallback-needed.txt")))
    .sort();
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const dates = arg ? [arg] : markerDates();
  if (!dates.length) {
    console.log("[tts-fallback] 无待兜底日期（无 tts-fallback-needed.txt 标记），跳过");
    return;
  }

  const { assembleBriefingScript } = await import("../lib/services/voice/index");
  const { synthesizeAudio } = await import("../lib/adapters/tts");

  for (const date of dates) {
    const dir = path.join(REPORTS_DIR, date);
    const marker = path.join(dir, "tts-fallback-needed.txt");
    const reportPath = path.join(dir, `${date}.json`);
    try {
      if (!fs.existsSync(reportPath)) {
        console.warn(`[tts-fallback] ${date} 无 ${date}.json，跳过并清理标记`);
        fs.rmSync(marker, { force: true });
        continue;
      }
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as DailyReport;
      const exec = loadExecStore(date);
      const built = await assembleBriefingScript(report, { exec });
      if (!built) {
        console.warn(`[tts-fallback] ${date} 口播稿为空，跳过并清理标记`);
        fs.rmSync(marker, { force: true });
        continue;
      }
      const res = await synthesizeAudio(date, built.script);
      console.log(
        `[tts-fallback] ✅ ${date} 兜底合成完成（${res.mp3Path}，backend=${res.backend}）`,
      );
      fs.rmSync(marker, { force: true });
    } catch (e) {
      console.error(
        `[tts-fallback] ❌ ${date} 兜底合成失败：${e instanceof Error ? e.message : String(e)}`,
      );
      // 失败保留标记，便于排查；不阻断 workflow（构建/发布照常，页面不出播放器）
    }
  }
}

main().catch((e) => {
  console.error("[tts-fallback] FAIL:", e);
  process.exit(1);
});
