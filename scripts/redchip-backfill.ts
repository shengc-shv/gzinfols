/**
 * 红筹台账基线回填（一次性运维脚本）。
 *
 * 用法：
 *   npx tsx scripts/redchip-backfill.ts [--source <上游 listing_full.csv>] [--dry-run] [--no-push]
 *
 * 为什么需要它（2026-09-17 实测根因）：
 *   `redchip-monitor` 的采信窗口是「今天 + 昨天」，跑出来只有当日新递表的 0~1 家；
 *   在册申请（处理中 / 已上市）从来没有基线 → 线上红筹面板长期「共 1 家（红筹 0）」。
 *   而红筹商机的价值恰恰在**在册的全量**（约 38 家离岸 ∧ 广东运营线索），不是每天新增的那一两家。
 *
 * 做什么：读上游台账 → 按本仓口径过滤（离岸注册 ∧ 广东运营词频 ≥ 3）→ 合并进 `leads.json`。
 *   只建台账、**不写 changelog**（否则 38 家会全被标成「新增」，污染变更历史）。
 *
 * 🔴 红线：上游 CSV 的 `gd_opco` / `vie_evidence` 是招股书**原文片段**，实测含
 *   「主要往来银行 中国银行广州番禺支行」这类可定位银行主体的信息。
 *   本脚本**只读** id/name/board/status/stock_code/submit_date/domicile/
 *   gd_opco_count/is_vie/app_proof_url 九类字段，原文列一律不进内存模型、不进产物。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  REDCHIP_LEADS_PATH,
  REDCHIP_LATEST_PATH,
  REDCHIP_DIR,
  type RedchipProject,
  type RedchipSnapshot,
} from "../lib/contracts/redchip";
import {
  pickRedchipRows,
  projectFromUpstreamRow,
  type UpstreamListingRow,
} from "../lib/services/redchip/backfill";
import { mergeProjects } from "../lib/services/redchip/backfill";
import { readLeads, writeLeads, writeLatest, writeDatedSnapshot } from "../lib/adapters/redchip/snapshot-store";
import { toLeads } from "../lib/services/redchip/leads";
import { REPORT_TZ, todayKey } from "../lib/utils/time";

/** 上游 CSV 的默认位置（同级目录的 red 仓库）；不存在时须显式 --source。 */
const DEFAULT_SOURCE = path.resolve(process.cwd(), "..", "red", "data", "listing_full.csv");

/** 北京时间 ISO（Asia/Shanghai 无夏令时）。脚本层用时钟；服务层严禁。 */
function beijingNowIso(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORT_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date())) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+08:00`;
}

/** 最小 CSV 解析（RFC4180：双引号包裹、内部 "" 转义、字段内允许换行与逗号）。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** CSV → 上游行（**只取九类字段**，原文列不读）。 */
function rowsOfCsv(text: string): UpstreamListingRow[] {
  const table = parseCsv(text.replace(/^\uFEFF/, ""));
  const header = table.shift() ?? [];
  const idx = (name: string) => header.indexOf(name);
  const col = {
    id: idx("id"), cn: idx("name_cn"), en: idx("name_en"), board: idx("board"),
    status: idx("status"), code: idx("stock_code"), date: idx("submit_date"),
    dom: idx("domicile"), gdCount: idx("gd_opco_count"), vie: idx("is_vie"),
    proof: idx("app_proof_url"),
  };
  const pick = (r: string[], i: number): string => (i >= 0 ? (r[i] ?? "").trim() : "");
  const out: UpstreamListingRow[] = [];
  for (const r of table) {
    const appId = pick(r, col.id);
    if (!appId) continue;
    out.push({
      appId,
      nameCn: pick(r, col.cn),
      nameEn: pick(r, col.en),
      board: pick(r, col.board),
      status: pick(r, col.status),
      stockCode: pick(r, col.code),
      submitDate: pick(r, col.date),
      domicile: pick(r, col.dom),
      gdOpcoCount: Number(pick(r, col.gdCount)) || 0,
      vieFlag: pick(r, col.vie),
      proofUrl: pick(r, col.proof),
    });
  }
  return out;
}

/** 写盘前的登记信息。 */
interface Summary {
  totalRows: number;
  picked: number;
  offshore: number;
  addedToLedger: number;
  ledgerTotal: number;
  redchipTotal: number;
}

function main(): number {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const noPush = argv.includes("--no-push");
  const srcIdx = argv.indexOf("--source");
  const source = srcIdx >= 0 ? argv[srcIdx + 1] : DEFAULT_SOURCE;

  if (!source || !fs.existsSync(source)) {
    console.error(
      `[redchip-backfill] ❌ 找不到上游台账：${source ?? "(未指定)"}\n` +
        `  用法：npx tsx scripts/redchip-backfill.ts --source /path/to/red/data/listing_full.csv [--dry-run] [--no-push]`,
    );
    return 1;
  }

  const allRows = rowsOfCsv(fs.readFileSync(source, "utf8"));
  const picked = pickRedchipRows(allRows);
  const nowIso = beijingNowIso();

  const incoming: RedchipProject[] = picked.map((r) => projectFromUpstreamRow(r, nowIso));
  const prev = readLeads();
  const merged = mergeProjects(prev, incoming);
  const added = merged.length - prev.length;

  const summary: Summary = {
    totalRows: allRows.length,
    picked: picked.length,
    offshore: picked.filter((r) => r.domicile).length,
    addedToLedger: added,
    ledgerTotal: merged.length,
    redchipTotal: merged.filter((p) => p.verdict === "redchip").length,
  };

  console.log(`[redchip-backfill] 上游台账：${source}`);
  console.log(`[redchip-backfill] 台账 ${summary.totalRows} 行 → 命中红筹口径 ${summary.picked} 家（离岸 ∧ 广东运营词频 ≥ 3）`);
  console.log(`[redchip-backfill] 既有线索库 ${prev.length} 条 → 合并后 ${summary.ledgerTotal} 条（本次新增 ${added}）`);
  console.log(`[redchip-backfill] 其中判定为红筹线索：${summary.redchipTotal} 家`);
  for (const p of incoming.slice(0, 8)) {
    console.log(
      `  · ${p.appId} ${p.nameCn || p.nameEn} | ${p.domicile ?? "-"} | 词频 ${p.gdCityHits} | 递表 ${p.submitDate ?? "-"} | ${p.status}`,
    );
  }
  if (incoming.length > 8) console.log(`  … 其余 ${incoming.length - 8} 家见 ${REDCHIP_LEADS_PATH}`);

  if (dryRun) {
    console.log("[redchip-backfill] --dry-run：不写盘");
    return 0;
  }

  const dateKey = todayKey();
  const snap: RedchipSnapshot = { capturedAt: nowIso, count: merged.length, projects: merged };
  fs.mkdirSync(path.resolve(REDCHIP_DIR, "snapshots"), { recursive: true });
  writeLeads(toLeads(merged));
  writeDatedSnapshot(snap, `${dateKey}-baseline`);
  writeLatest(snap);
  console.log(
    `[redchip-backfill] ✅ 已写入 ${REDCHIP_LEADS_PATH} / ${REDCHIP_LATEST_PATH} / ${REDCHIP_DIR}/snapshots/${dateKey}-baseline.json`,
  );
  console.log("[redchip-backfill] 说明：未写 changelog（回填不是「新增」，不应污染变更历史）");

  if (!noPush) {
    try {
      execFileSync("git", ["add", REDCHIP_LEADS_PATH, `${REDCHIP_DIR}/snapshots/${dateKey}-baseline.json`], { stdio: "inherit" });
      execFileSync(
        "git",
        ["commit", "-m", `chore(redchip): 回填红筹台账基线 ${incoming.length} 家\n\n上游台账（listing_full.csv）的全量在册清单一次性并入线索库。\n此前 monitor 只有「今天+昨天」增量窗口，在册申请没有基线，线上长期空态。\n只取计数与枚举字段；上游原文摘录（含往来银行行名）不进入仓内产物。`],
        { stdio: "inherit" },
      );
      console.log("[redchip-backfill] 已提交（未推送 —— 推送须用户授权）");
    } catch {
      console.warn("[redchip-backfill] ⚠️ 自动提交失败，请手动提交（不影响已落盘产物）");
    }
  }
  return 0;
}

process.exit(main());
