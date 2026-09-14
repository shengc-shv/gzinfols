/**
 * 红筹监测 CI 入口（骨架版）—— 抓取 → 判定 → 存储 → diff。
 *
 * 用法：
 *   tsx scripts/redchip-monitor.ts [--sample fixtures/redchip-sample.json] [--date YYYY-MM-DD] [--dry-run]
 *
 * 骨架阶段：**只跑固定样本，不发起真实网络请求**。
 *
 * ⏰ 日期口径（重要）：
 *   用户在**北京时间早上 7:30** 跑 CI，此时"当天"数据尚未发布/完整，
 *   故**默认抓取「北京时间昨天」**的数据（可用 --date 覆盖补跑）。
 *   —— 不可用 Date.toISOString() 取日期（那是 UTC 日期，会在 12:00 北京跑时错成"今天"）。
 *
 * 产出：data/redchip/latest.json、snapshots/<date>.json、changelog.jsonl
 */
import { loadSampleListing } from "../lib/adapters/redchip/hkex-client";
import {
  appendChanges,
  readLatest,
  writeDatedSnapshot,
  writeLatest,
} from "../lib/adapters/redchip/snapshot-store";
import { classifyProject } from "../lib/services/redchip/classify";
import { diffSnapshots } from "../lib/services/redchip/diff";
import type { RedchipProject, RedchipSnapshot } from "../lib/contracts/redchip";
import { REPORT_TZ, todayKey } from "../lib/utils/time";

/** 北京时间（REPORT_TZ）的「昨天」日期键。 */
function yesterdayKey(): string {
  const d = new Date(todayKey() + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** 当前北京时间的 ISO 串（Asia/Shanghai 无夏令时，固定 +08:00）。 */
function beijingNowIso(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORT_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date())) p[part.type] = part.value;
  return p.year + "-" + p.month + "-" + p.day + "T" + p.hour + ":" + p.minute + ":" + p.second + "+08:00";
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function main(): void {
  const samplePath = arg("--sample", "fixtures/redchip-sample.json");
  const date = arg("--date", yesterdayKey());
  const dryRun = process.argv.includes("--dry-run");

  const records = loadSampleListing(samplePath);
  const prev = readLatest();
  const prevMap = new Map((prev?.projects ?? []).map((p) => [p.appId, p]));
  const nowIso = beijingNowIso();

  const projects: RedchipProject[] = records.map((r) => {
    const appId = String(r.id ?? "");
    return classifyProject({
      appId,
      nameCn: r.a,
      nameEn: r.aEn,
      board: r.w,
      status: r.s,
      submitDate: r.sD ?? r.d,
      docText: r.docText,
      sourceUrl: r.docUrl,
      discoveredAt: prevMap.get(appId)?.discoveredAt ?? nowIso,
    });
  });

  const snap: RedchipSnapshot = { capturedAt: nowIso, count: projects.length, projects };
  const changes = diffSnapshots(prev, snap);

  console.log("[redchip] 目标日期：" + date + "（北京时间昨天；时区 " + REPORT_TZ + "）");
  console.log("[redchip] 来源：样本 " + samplePath + "（未发起网络请求）");
  for (const p of projects) {
    console.log("  · " + p.appId + " " + p.nameCn + " | 离岸=" + p.isOffshore +
      " | 广东词频=" + p.gdCityHits + " | 判定=" + p.verdict);
  }
  console.log("[redchip] 变更 " + changes.length + " 条：" +
    changes.map((c) => c.type + "(" + c.appId + (c.field ? "/" + c.field : "") + ")").join(", "));

  if (dryRun) {
    console.log("[redchip] --dry-run：不写盘");
    return;
  }
  writeLatest(snap);
  writeDatedSnapshot(snap, date);
  appendChanges(changes);
  console.log("[redchip] 已写入 data/redchip/{latest.json, snapshots/" + date + ".json, changelog.jsonl}");
}

main();
