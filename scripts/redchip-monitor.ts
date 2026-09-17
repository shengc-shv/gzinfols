/**
 * 红筹监测 CI 入口（骨架版）—— 抓取 → 判定 → 存储 → diff。
 *
 * 用法：
 *   tsx scripts/redchip-monitor.ts [--sample fixtures/redchip-sample.json] [--date YYYY-MM-DD] [--dry-run]
 *
 * ⏰ 日期口径（2026-09-15 用户口径：**只抓「今天 + 昨天」两天**）：
 *   默认窗口 = [今天, 昨天]（北京时间 REPORT_TZ 日历日），两天合并后按申请编号去重；
 *   两天都无数据（披露易发布滞后 1~2 天）→ **自动回退到最近有数据日**，避免恒空；
 *   显式 `--date X`（补跑）→ 只取 X 单日，精确复现历史某天。
 *   —— 不可用 Date.toISOString() 取日期（那是 UTC 日期，会在 12:00 北京跑时错成"今天"）。
 *
 * 📊 日志里「清单总量 N 条」是**源清单本身的条数**（披露易 AP&PHIP 全部在册申请），
 *    与实际抓取量无关：过滤后只对窗口命中的记录下载申请版本 PDF，且受 --limit 上限约束。
 *
 * 产出：data/redchip/latest.json、snapshots/<date>.json、changelog.jsonl、leads.json
 */
import {
  boardOf,
  docUrlOf,
  fetchListingLive,
  loadSampleListing,
  recordDateKey,
  type ListingRecord,
} from "../lib/adapters/redchip/hkex-client";
import { extractPdfText } from "../lib/adapters/redchip/pdf-text";
import {
  appendChanges,
  readChanges,
  readLatest,
  readLeads,
  writeDatedSnapshot,
  writeLatest,
  writeLeads,
} from "../lib/adapters/redchip/snapshot-store";
import { classifyProject } from "../lib/services/redchip/classify";
import { diffSnapshots } from "../lib/services/redchip/diff";
import { toLeads } from "../lib/services/redchip/leads";
import { mergeProjects } from "../lib/services/redchip/backfill";
import type { RedchipProject, RedchipSnapshot } from "../lib/contracts/redchip";
import { REPORT_TZ, prevDateKey, todayKey } from "../lib/utils/time";

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

async function main(): Promise<void> {
  const samplePath = arg("--sample", "fixtures/redchip-sample.json");
  const explicitDate = process.argv.includes("--date");
  const date = arg("--date", todayKey());
  const dryRun = process.argv.includes("--dry-run");

  const live = process.argv.includes("--live");
  const limit = Number(arg("--limit", "5"));
  let records: ListingRecord[];

  // 采信窗口（**用户 2026-09-15 口径：只抓「今天 + 昨天」两天**）。
  //   · 默认（无 --date）→ 窗口 = [今天, 昨天]，两天合并去重；
  //   · 显式 `--date X`（补跑用）→ 只取 X 单日，精确复现历史某天。
  // 另加「窗口全空 → 回退最近有数据日」的安全网（披露易滞后 1~2 天，见短板②）。
  let windowDates: string[] = [date];
  let dataDate = date;

  if (live) {
    // 实网模式：拉披露易 AP&PHIP **英文**清单 → 按日期窗口筛选 → 抽「申请版本」PDF 文本
    const all = await fetchListingLive();
    const onDate = (ds: string) => all.filter((r) => recordDateKey(r) === ds);
    // 去重主键 = 申请编号（同一条可能同时出现在 appactive / applisted / gem 等多份清单里）
    const dedupe = (rs: ListingRecord[]): ListingRecord[] => {
      const seen = new Set<string>();
      return rs.filter((r) => {
        const k = String(r.id ?? "");
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    };

    windowDates = explicitDate ? [date] : [date, prevDateKey(date)];
    let hit = dedupe(windowDates.flatMap(onDate));
    if (hit.length === 0 && !explicitDate) {
      // 短板②：披露易发布有 1~2 天滞后 → 两天窗口都空时，回退到「最近有数据日」，
      // 否则无递表的日子会恒空（实测 appactive 最新 09-13、目标日 09-14 命中 0）。
      const dates = Array.from(
        new Set(all.map((r) => recordDateKey(r)).filter((x): x is string => Boolean(x))),
      )
        .filter((d) => d <= date)
        .sort();
      const latest = dates[dates.length - 1];
      if (latest) {
        console.log(
          "[redchip] 窗口 " + windowDates.join("~") + " 无数据（披露易通常滞后 1~2 天）→ 回退到最近有数据日 " + latest,
        );
        windowDates = [latest];
        dataDate = latest;
        hit = dedupe(onDate(latest));
      }
    }
    console.log(
      "[redchip] 实网：清单总量 " + all.length + " 条（**源清单总量，不是抓取量**）→ 采信窗口 " +
        windowDates.join(" ~ ") + " 命中 " + hit.length + " 条，实际下载申请版本 PDF " +
        Math.min(hit.length, limit) + " 个（--limit " + limit + "）",
    );
    const enriched: ListingRecord[] = [];
    for (const r of hit.slice(0, limit)) {
      // 文档选取：ls[] 的「申请版本」（**不再用 w** —— 那是 1 页「警告聲明」，判不出注册地）
      const docUrl = docUrlOf(r);
      if (!docUrl) {
        console.log("[redchip] ⚠️ " + String(r.id) + " ls 里无 Application Proof 条目 → 不抽文本（宁缺毋滥）");
      }
      enriched.push({ ...r, docUrl, docText: docUrl ? await extractPdfText(docUrl) : "" });
    }
    console.log("[redchip] 实网：已抽取申请版本文本 " + enriched.length + " 条（--limit " + limit + "）");
    records = enriched;
  } else {
    records = loadSampleListing(samplePath);
  }

  const prev = readLatest();
  const prevMap = new Map((prev?.projects ?? []).map((p) => [p.appId, p]));
  const nowIso = beijingNowIso();

  const projects: RedchipProject[] = records.map((r) => {
    const appId = String(r.id ?? "");
    return classifyProject({
      appId,
      nameCn: r.a,
      nameEn: r.aEn,
      board: r.board ?? boardOf(r),
      status: r.s,
      stockCode: r.st,
      submitDate: recordDateKey(r) ?? r.d,
      docText: r.docText,
      sourceUrl: r.docUrl,
      discoveredAt: prevMap.get(appId)?.discoveredAt ?? nowIso,
    });
  });

  const snap: RedchipSnapshot = { capturedAt: nowIso, count: projects.length, projects };
  const changes = diffSnapshots(prev, snap);

  console.log("[redchip] 采信窗口：" + windowDates.join(" ~ ") + "（目标日 " + date + (explicitDate ? "，--date 显式指定单日" : "，默认今天+昨天") + "；时区 " + REPORT_TZ + "）");
  console.log("[redchip] 来源：" + (live ? "实网（披露易 AP&PHIP）" : "样本 " + samplePath + "（未发起网络请求）"));
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
  writeDatedSnapshot(snap, dataDate);
  appendChanges(changes);
  // 线索库（**入库**）：渲染侧（side-redchip）唯一读方。含全部判定字段 + 由 changelog
  // 归并的 lastChangedAt（展示/口播的「更新」标记依据）。与快照同源，故紧随其后写。
  //
  // ⚠️ 2026-09-17 修：必须**累积合并**（`mergeProjects`），不能直接用当日窗口覆盖 ——
  // 采信窗口只有「今天 + 昨天」，覆盖写入会把窗口外的在册线索（含基线）静默抹掉，
  // 这正是线上面板长期「共 1 家（红筹 0）」的直接根因。台账语义 = 在册状态的累积，
  // 不是每日快照；同日重复抓取时同 appId 覆盖、discoveredAt 保留最早值。
  const prevLeads = readLeads();
  const merged = mergeProjects(prevLeads, projects);
  writeLeads(toLeads(merged, readChanges()));
  console.log(
    "[redchip] 线索库累积：" + prevLeads.length + " → 合并后 " + merged.length +
      " 条（本次窗口 " + projects.length + " 条）",
  );
  console.log("[redchip] 已写入 data/redchip/{leads.json, latest.json, snapshots/" + dataDate + ".json, changelog.jsonl}");
}

main();
