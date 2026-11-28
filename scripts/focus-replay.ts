/**
 * 二期 · 经营重点加权回放（WP5 验收工具）。
 *
 * 用**真实历史报告**跑两遍同一套池构建：
 *   A 一期基线 = `buildTwoDayExecPool({...})`（不传 focus）
 *   B 二期加权 = `buildTwoDayExecPool({... focus })`
 * 输出两栏池排名差异、命中理由、加分，以及必读候选顺序变化。
 *
 * 用法：
 *   npx tsx scripts/focus-replay.ts --date 2026-11-28 --report /tmp/latest-1128.json
 *   npx tsx scripts/focus-replay.ts --date 2026-11-27 --report /tmp/latest-1127.json
 *   可选 --all  忽略生效窗口（沙盘全量启用，仅用于看极端效果）
 *
 * 🔴 本脚本**只读**：不改配置、不写 data/、不发布。唯一写盘是 deliverables 下的对比 JSON。
 * 🔴 沙盘口径：配置里的重点目前全部 inactive（等业务确认），回放默认**忽略 status**、
 *    仍按生效窗口筛 —— 即「假设这些重点今天都已启用」。输出会显式标注该假设。
 */
import "./_env";
import fs from "node:fs";
import path from "node:path";
import { readFocusConfigFiles } from "../lib/adapters/business-focus/config-store";
import { loadFocusConfig, isFocusInWindow } from "../lib/services/business-focus/config-loader";
import { buildTwoDayExecPool, type ExecPoolItem } from "../lib/services/enrich/exec-pool";
import { applyFocus } from "../lib/services/business-focus/focus-apply";
import { applyRelevanceGuardrail } from "../lib/services/enrich/executive-summary";
import { scoreBranchRelevance } from "../lib/services/select/filters/relevance-score";
import type { FocusItem } from "../lib/services/business-focus/types";
import type { DailyReport, ReportItem } from "../lib/contracts/report";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const date = arg("date");
const reportPath = arg("report");
if (!date || !reportPath) {
  console.error("用法: npx tsx scripts/focus-replay.ts --date 2026-11-28 --report /tmp/latest-1128.json [--all]");
  process.exit(2);
}

const raw = JSON.parse(fs.readFileSync(reportPath, "utf8")) as { date?: string; report?: DailyReport } & Partial<DailyReport>;
const report: DailyReport = (raw.report ?? raw) as DailyReport;
const history = JSON.parse(fs.readFileSync(path.resolve("data/article-history.json"), "utf8")) as Record<string, any>;

// ---- 生效重点（沙盘：忽略 status，按窗口筛；--all 则忽略窗口）----
const loaded = loadFocusConfig(readFocusConfigFiles(process.cwd()), { today: date });
const focuses: FocusItem[] = loaded.items
  .filter((it) => (flag("all") ? true : isFocusInWindow(it, date)))
  .map((it) => ({ ...it, status: "active" as const }));

// ---- 池构建：唯一变量是 focus ----
const now = new Date(`${date}T12:00:00+08:00`);
const base = { history, articles: [], report, today: date, now };
const poolA = buildTwoDayExecPool({ ...base });
const poolB = buildTwoDayExecPool({ ...base, focus: focuses });

const key = (it: ExecPoolItem): string => it.url ?? it.title;

/** 与 exec-pool 内部 scoreOf 完全同参（展示用；排序仍由池自身决定）。 */
function baseScoreOf(it: ExecPoolItem): number {
  return scoreBranchRelevance({
    title: it.title,
    ...(it.excerpt?.trim() ? { summary: it.excerpt } : it.summary ? { summary: it.summary } : {}),
    ...(it.subcategory ? { subcategory: it.subcategory } : {}),
  }).score;
}

interface Row {
  rankA: number;
  rankB: number;
  title: string;
  base: number;
  focus: number;
  final: number;
  hits: Array<{ name: string; layer: string; level: string; bonus: number; reason: string }>;
  guards: string[];
  inBody: boolean;
}

function rowsFor(cat: "finance" | "gz"): Row[] {
  const A = poolA[cat];
  const B = poolB[cat];
  const ra = new Map(A.map((it, i) => [key(it), i + 1]));
  const rb = new Map(B.map((it, i) => [key(it), i + 1]));
  const all = new Map<string, ExecPoolItem>();
  for (const it of [...A, ...B]) all.set(key(it), it);
  const rows: Row[] = [];
  for (const [k, it] of all) {
    const rankA = ra.get(k) ?? 999;
    const rankB = rb.get(k) ?? 999;
    const bs = baseScoreOf(it);
    const r = applyFocus({ title: it.title, ...(it.excerpt?.trim() ? { excerpt: it.excerpt } : {}) }, bs, focuses);
    rows.push({
      rankA,
      rankB,
      title: it.title,
      base: bs,
      focus: r.focusRelevance,
      final: r.finalScore,
      hits: r.matches.slice(0, 3).map((m) => ({
        name: m.name,
        layer: m.layer,
        level: m.matchLevel,
        bonus: r.counted.find((c) => c.match.focusId === m.focusId)?.bonus ?? 0,
        reason: m.reason,
      })),
      guards: r.guards,
      inBody: Boolean(it.inBody),
    });
  }
  return rows.sort((a, b) => a.rankB - b.rankB || a.rankA - b.rankA);
}

const finance = rowsFor("finance");
const gz = rowsFor("gz");

// ---- 必读候选顺序对比 ----
const poolArticles = (Object.values(report.sections ?? {}) as ReportItem[][])
  .flat()
  .filter((it) => it?.title_cn || it?.title_orig)
  .map((it) => ({ title: it.title_cn || it.title_orig || "", summary: it.summary, url: it.url }));

// 报告对象与 ExecutiveSummary 形状不完全一致（必读 title 可空）——回放只看顺序，显式转换
const execView = report as unknown as Parameters<typeof applyRelevanceGuardrail>[0];
const guardA = applyRelevanceGuardrail(execView, poolArticles);
const guardB = applyRelevanceGuardrail(execView, poolArticles, focuses);
const mrA = guardA.must_read?.map((m) => m.title) ?? [];
const mrB = guardB.must_read?.map((m) => m.title) ?? [];

// ---- 输出 ----
const P = (s: string) => process.stdout.write(`${s}\n`);
const LAYER: Record<string, string> = { annual: "年度", quarterly: "季度", temporary: "临时" };

P(`\n=== 经营重点加权回放 · ${date} ===`);
P(`配置版本 ${loaded.version}｜沙盘启用 ${focuses.length} 条（忽略 inactive${flag("all") ? "、忽略窗口" : "、按窗口"}）`);
for (const f of focuses) P(`  · [${LAYER[f.layer]}/${f.grade}] ${f.name} —— domains=${f.domains.join(",")}`);
if (!focuses.length) P("  ⚠️ 无生效重点，A/B 必然一致");

for (const [label, rows] of [
  ["finance（宏观政策 → 必读）", finance],
  ["gz（广州业务 → 商机）", gz],
] as const) {
  P(`\n--- ${label}｜A=${rows.filter((r) => r.rankA < 999).length} 条 B=${rows.filter((r) => r.rankB < 999).length} 条 ---`);
  P("B序 | A→B | 正文 | 基础 | 重点分 | 总分 | 标题 / 命中");
  for (const r of rows) {
    const arrow = r.rankA === r.rankB ? "  =" : `${String(r.rankA).padStart(3)}→${String(r.rankB).padEnd(3)}`;
    const hit = r.hits.length
      ? r.hits.map((h) => `${LAYER[h.layer]}${h.level}+${h.bonus}「${h.name}」`).join(" / ")
      : "—";
    P(`${String(r.rankB).padStart(3)} | ${arrow} | ${r.inBody ? " ✔ " : " — "} | ${String(r.base).padStart(3)} | ${String(r.focus).padStart(5)} | ${String(r.final).padStart(5)} | ${r.title.slice(0, 34)}${hit === "—" ? "" : `  ← ${hit}`}`);
  }
  const moved = rows.filter((r) => r.rankA !== r.rankB && r.rankA < 999 && r.rankB < 999);
  P(`排序变化 ${moved.length} 条`);
  for (const r of moved) {
    for (const h of r.hits) P(`  · ${r.title.slice(0, 30)}｜${LAYER[h.layer]}${h.level} +${h.bonus}｜${h.reason}`);
    for (const g of r.guards) P(`    ⚠ ${g}`);
  }
}

P(`\n--- 必读候选（前 ${Math.max(mrA.length, mrB.length)} 条）---`);
const n = Math.max(mrA.length, mrB.length);
for (let i = 0; i < n; i++) {
  const a = mrA[i] ?? "";
  const b = mrB[i] ?? "";
  P(`${String(i + 1).padStart(2)}. A: ${a.slice(0, 42)}`);
  if (a !== b) P(`    B: ${b.slice(0, 42)}${b && !a ? "  ← 新增" : ""}`);
}
P(`必读顺序是否变化：${JSON.stringify(mrA) === JSON.stringify(mrB) ? "否" : "是"}`);
P(`\n风险（独立通道，不参与加权）：${report.risk?.topic ?? "（当日无）"}`);

// ---- 落盘对比 JSON（供出对比页）----
const outDir = path.resolve("deliverables/focus-engine-2026-11-28");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `replay-${date}.json`);
fs.writeFileSync(
  outFile,
  JSON.stringify(
    {
      date,
      version: loaded.version,
      sandbox: { ignoreStatus: true, ignoreWindow: flag("all"), count: focuses.length },
      focuses: focuses.map((f) => ({ id: f.id, name: f.name, layer: f.layer, grade: f.grade })),
      pool: { finance, gz },
      mustRead: { before: mrA, after: mrB },
      risk: report.risk ?? null,
    },
    null,
    2,
  ),
);
P(`\n对比数据已写入 ${path.relative(process.cwd(), outFile)}`);
