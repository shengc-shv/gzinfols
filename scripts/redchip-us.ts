/**
 * 美股红筹增量同步（SEC EDGAR 源）—— 独立红筹源之一。
 *
 * 用法：
 *   npx tsx scripts/redchip-us.ts [--dry-run] [--limit N] [--date YYYY-MM-DD]
 *
 * 定位：与港股红筹源（scripts/redchip-monitor.ts）平级的**独立源**，共用同一套
 * 红筹判定（`classifyProject`：离岸注册 ∧ 广东运营词频≥3）与台账（data/redchip/leads.json，
 * 条目带 market:"us" 区分），快照独立归档到 data/redchip-us/。
 *
 * 采信窗口（与港股源同口径）：**今天 + 昨天**两个北京日历日；SEC 文件日（美东）
 * 与北京日期差半天属已知口径差（披露易滞后同理，接受）。
 *
 * 只要广东企业：判定只收 verdict=redchip（离岸 ∧ 广东词频≥3）——非广东/非离岸
 * 不进台账（与 backfill 的 pickRedchipRows 同款纪律，宁缺毋滥）。
 *
 * 限流合规：SEC 官方要求可辨识 UA + 10 req/s。窗口命中通常 ≤ 10 家，每家
 * 1 次 submissions + 1 次主文档下载；脚本串行执行天然低于限流阈值。
 *
 * ⏰ 时间红线：publishedAt/submitDate = SEC 官方文件日，绝不抓取日兜底。
 */
import fs from "node:fs";
import path from "node:path";
import { classifyProject } from "../lib/services/redchip/classify";
import { mergeProjects } from "../lib/services/redchip/backfill";
import { searchF1Filings, resolvePrimaryDocUrl, extractEdgarDoc } from "../lib/adapters/redchip/edgar-client";
import { readLeads, writeLeads, writeMetaSource } from "../lib/adapters/redchip/snapshot-store";
import { toLeads } from "../lib/services/redchip/leads";
import type { RedchipProject, RedchipSnapshot } from "../lib/contracts/redchip";
import { REPORT_TZ, prevDateKey, todayKey } from "../lib/utils/time";

/** 美股红筹快照独立归档目录（与港股 data/redchip/ 分开）。 */
const US_DIR = path.resolve(process.cwd(), "data/redchip-us");
const US_LATEST_PATH = path.join(US_DIR, "latest.json");

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

/** SEC displayName（"LYC HEALTHCARE (CAYMAN) LTD (CIK 0002050183)"）→ 公司名。 */
function nameOfDisplay(displayName: string): string {
  return (displayName || "").replace(/\s*\(CIK\s*\d+\)\s*$/i, "").trim();
}

/** 窗口参数。 */
function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const limit = Number(arg("--limit", "20"));
  const date = process.argv.includes("--date") ? arg("--date", todayKey()) : todayKey();
  const startDate = prevDateKey(date); // 昨天
  const endDate = date; // 今天

  const nowIso = beijingNowIso();
  // 🔴 源失败与「真的 0 命中」必须区分：检索失败时**直接退出、不写盘**，
  //    否则会用 `count:0` 的空快照覆盖上一份有效数据（实测 10-01~10-04 连 4 天空快照，
  //    根因就是 SEC 间歇 500 被当成「0 命中」）。台账与 meta 均保持上一份有效状态。
  let filings: Awaited<ReturnType<typeof searchF1Filings>>;
  try {
    filings = await searchF1Filings(startDate, endDate);
  } catch (err) {
    console.error(`[redchip-us] ❌ ${(err as Error).message}`);
    console.error("[redchip-us] 本轮放弃写盘（保留上一份有效快照与台账）");
    process.exitCode = 1;
    return;
  }
  console.log(
    `[redchip-us] 窗口 ${startDate} ~ ${endDate}（今天+昨天）检索 F-1/F-1A 主文档 ${filings.length} 家（按 CIK 去重）`,
  );

  // 串行处理（SEC 限流 10 req/s；命中量小，串行足够）
  const projects: RedchipProject[] = [];
  const todo = filings.slice(0, limit);
  for (const f of todo) {
    const docUrl = await resolvePrimaryDocUrl(f);
    if (!docUrl) {
      console.log(`[redchip-us] ⚠️ ${f.displayName} 未解析到主文档 URL → 跳过`);
      continue;
    }
    const text = await extractEdgarDoc(docUrl);
    const p = classifyProject({
      appId: "us-" + f.cik,
      nameCn: nameOfDisplay(f.displayName),
      board: "美股",
      status: "F-1/F-1A",
      submitDate: f.fileDate,
      docText: text,
      sourceUrl: docUrl,
      discoveredAt: nowIso,
    });
    const withMarket: RedchipProject = { ...p, market: "us" };
    projects.push(withMarket);
    console.log(
      `  · us-${f.cik} ${withMarket.nameCn.slice(0, 34)} | ${f.fileDate} | 离岸=${withMarket.isOffshore} | 广东词频=${withMarket.gdCityHits} | 判定=${withMarket.verdict}${withMarket.domicile ? " | 注册地=" + withMarket.domicile : ""}`,
    );
  }

  // 只要广东企业：只收 verdict=redchip（离岸 ∧ 广东≥3）
  const redchip = projects.filter((p) => p.verdict === "redchip");
  console.log(`[redchip-us] 窗口命中 ${projects.length} 家 → 判定红筹（广东企业）${redchip.length} 家`);

  // 可观测：源 0 命中必须自己喊出来（本链路常被前端判为「美股 0 条」却无人知晓）
  if (filings.length === 0) {
    console.log(`::warning::[redchip-us] SEC 源窗口 ${startDate} ~ ${endDate} 检索到 0 家（源不可达或窗口无申报）`);
  } else if (redchip.length === 0) {
    console.log(`::warning::[redchip-us] SEC 源命中 ${projects.length} 家，但无一判定为红筹（离岸 ∧ 广东词频≥3）`);
  }

  if (dryRun) {
    console.log("[redchip-us] --dry-run：不写盘");
    return;
  }

  // 独立快照归档（data/redchip-us/），与港股 data/redchip/ 分开
  const snap: RedchipSnapshot = { capturedAt: nowIso, count: redchip.length, projects: redchip };
  fs.mkdirSync(path.join(US_DIR, "snapshots"), { recursive: true });
  fs.writeFileSync(US_LATEST_PATH, JSON.stringify(snap, null, 2) + "\n", "utf8");
  fs.writeFileSync(
    path.join(US_DIR, "snapshots", `${date}-us.json`),
    JSON.stringify(snap, null, 2) + "\n",
    "utf8",
  );

  // 共享台账合并（leads.json，market:"us" 区分）
  const prevLeads = readLeads();
  const merged = mergeProjects(prevLeads, redchip);
  writeLeads(toLeads(merged));

  console.log(
    `[redchip-us] 线索库累积：${prevLeads.length} → ${merged.length} 条（本次新增红筹 ${redchip.length}）`,
  );

  // 元信息（**入库**）：与港股源**按源合并**写同一份 meta.json（港股那一格不被覆盖）。
  writeMetaSource(
    "us",
    { capturedAt: nowIso, ok: redchip.length > 0, scanned: filings.length, redchip: redchip.length },
    nowIso,
  );
  console.log(`[redchip-us] 已写入 data/redchip/leads.json + data/redchip/meta.json(源 us) + data/redchip-us/{latest.json, snapshots/${date}-us.json}`);
}

main();
