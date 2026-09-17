/**
 * 本地「上市字典」冻结快照同步（2026-09-17；仿 `scripts/ipo-local.ts`）。
 *
 * 要解决的问题：`listed-check` 的深交所（B2）接口在 GitHub 海外 runner 上恒
 * `fetch failed`（本机国内直连 200），线上字典长期为空。本脚本在本地抓一次三所
 * 上市列表 → 写入 `data/local-listed.json` → 远端读取时**在线优先、快照补位**。
 *
 * 纪律（与 ipo-local 同）：不自己实现任何过滤/归一规则——复用 `ListedChecker.buildListingMap`
 * （与线上完全同一条采集路径）与 `buildLocalListedSnapshot`（窗口/去重/排序的单一实现）。
 *
 * 用法：
 *   npm run listed:local                 # 抓三所 → 写文件 → 提交推送
 *   npm run listed:local -- --dry-run    # 只抓与打印，不写盘、不推送
 *   npm run listed:local -- --no-push    # 写盘但不提交推送
 *   npm run listed:local -- --file=<路径>
 */
import { REPORT_TZ } from "../lib/utils/time";
import "./_env";
import { spawnSync } from "node:child_process";
import { createListedChecker, WINDOW_DAYS } from "../lib/adapters/crawlers/sources/listed-check";
import {
  LOCAL_LISTED_GENERATOR,
  LOCAL_LISTED_PATH,
  buildLocalListedSnapshot,
  readLocalListedFile,
  writeLocalListedFile,
} from "../lib/adapters/local-listed";

interface Args {
  file: string;
  dryRun: boolean;
  push: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { file: LOCAL_LISTED_PATH, dryRun: false, push: true };
  for (const a of argv) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--no-push") args.push = false;
    else if (a.startsWith("--file=")) args.file = a.slice("--file=".length);
    else if (a === "--help" || a === "-h") {
      console.log(
        [
          "用法: npm run listed:local -- [选项]",
          "  --file=<路径>     产出文件（默认 data/local-listed.json）",
          "  --dry-run         只抓取与打印，不写盘、不推送",
          "  --no-push         写盘但不 git 提交推送",
        ].join("\n"),
      );
      process.exit(0);
    } else if (a.startsWith("-")) {
      throw new Error(`未知参数：${a}`);
    }
  }
  return args;
}

/** 报告时区（北京时间）的 ISO 8601（含偏移），让 fetchedAt 人类可读、机器可解析。 */
function isoWithOffset(d: Date, tz = REPORT_TZ): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const off =
    new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      .formatToParts(d)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT+08:00";
  const m = off.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  const suffix = m ? `${m[1]}${m[2]}:${m[3] ?? "00"}` : "+08:00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:${g("second")}${suffix}`;
}

function git(args: string[], allowFail = false): boolean {
  const r = spawnSync("git", args, { stdio: "inherit" });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ")} 失败（exit ${r.status}）`);
  return r.status === 0;
}

function gitCapture(args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return (r.stdout || "") + (r.stderr || "");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const checker = createListedChecker();
  const cutoff = checker.cutoffDate(now);
  console.log(
    `[listed:local] 窗口=${WINDOW_DAYS} 天（cutoff=${cutoff}）；文件=${args.file}`,
  );

  // ① 采集（与线上同一条路径：ListedChecker.buildListingMap）
  const map = await checker.buildListingMap(cutoff);
  const listings = [...map.values()];
  console.log(`[listed:local] 抓取完成：上市字典 ${listings.length} 条`);

  // ② 与文件里窗口内旧记录合并（共享函数：时间红线 / 窗口 / 代码去重）
  const { file: prev, reason: prevReason } = readLocalListedFile(args.file);
  if (!prev) console.log(`[listed:local] 上一版文件不可用（${prevReason}）→ 本次以新抓结果为准`);
  const { file, stats } = buildLocalListedSnapshot(listings, {
    prev,
    windowDays: WINDOW_DAYS,
    cutoff,
    fetchedAt: isoWithOffset(now),
    generator: LOCAL_LISTED_GENERATOR,
  });
  console.log(
    `[listed:local] 归一化：新抓有效 ${stats.newValid} 条（丢弃不合规 ${stats.newInvalid}）` +
      `；沿用旧文件窗口内 ${stats.prevUsed} 条 → 最终 ${stats.total} 条`,
  );
  console.log(
    `[listed:local] 各交易所：${
      Object.entries(file.counts)
        .map(([k, v]) => `${k}=${v}`)
        .join("  ") || "(空)"
    }`,
  );
  if (stats.newValid === 0) {
    console.warn(
      `[listed:local] ⚠️ 本轮三所均未产出窗口内记录（接口失败或被拦）` +
        `${stats.prevUsed > 0 ? "；已保留上一版窗口内记录" : ""}`,
    );
  }

  if (args.dryRun) {
    console.log("[listed:local] --dry-run：不写盘、不推送。");
    return stats.total === 0 ? 1 : 0;
  }

  // ③ 写盘（原子写）
  writeLocalListedFile(file, args.file);
  console.log(`[listed:local] ✅ 已写入 ${args.file}`);

  // ④ 提交推送（文件无变化则跳过，避免空提交）
  if (!args.push) {
    console.log("[listed:local] --no-push：跳过 git 提交推送。");
    return 0;
  }
  const dirty = gitCapture(["status", "--porcelain", "--", args.file]).trim();
  if (!dirty) {
    console.log("[listed:local] 文件内容无变化 → 跳过提交推送。");
    return 0;
  }
  git(["add", "--", args.file]);
  git([
    "commit",
    "-m",
    `chore(listed): 本地上市字典快照 data/local-listed.json（${isoWithOffset(now).slice(0, 10)}，${file.listings.length} 条）`,
  ]);
  git(["fetch", "origin", "main"]);
  if (!git(["merge", "--no-edit", "origin/main"], true)) {
    git(["merge", "--abort"], true);
    console.error("[listed:local] ✗ 与 origin/main 合并冲突，已 abort。请手动处理后重跑。");
    return 1;
  }
  git(["push", "origin", "main"]);
  console.log("[listed:local] ✅ 已推送 data/local-listed.json 到 origin/main");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[listed:local] ✗ ${(err as Error).message}`);
    process.exit(1);
  });
