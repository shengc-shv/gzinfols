/**
 * 二期 · 经营重点加权「历史语料回放」（规格 8.3 / 11.3）。
 *
 * 与 `focus-replay.ts` 的分工：
 *   focus-replay.ts        单日**报告池**复现（最贴近生产，但样本仅一两天）
 *   focus-replay-corpus.ts 30~90 天**历史语料**统计（看整体分布与 False Boost）
 *
 * 数据源：`data/topics-corpus.json`（76 天，每天当日展示条目；字段 t=标题、d=日期、u=url）。
 * 🔴 只用**标题**做匹配与评分：语料里的 `x` 是 AI 摘要，喂回评分会形成自证循环（S5）。
 * 🔴 只读：不改配置、不写 data/；写盘仅 deliverables 下的回放结果。
 *
 * 用法：
 *   npx tsx scripts/focus-replay-corpus.ts --days 30 [--all]
 */
import "./_env";
import fs from "node:fs";
import path from "node:path";
import { readFocusConfigFiles } from "../lib/adapters/business-focus/config-store";
import { loadFocusConfig, isFocusInWindow } from "../lib/services/business-focus/config-loader";
import { applyFocus } from "../lib/services/business-focus/focus-apply";
import { scoreBranchRelevance } from "../lib/services/select/filters/relevance-score";
import type { FocusItem } from "../lib/services/business-focus/types";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (n: string): boolean => process.argv.includes(`--${n}`);

const daysWanted = Number(arg("days", "30"));
const corpus = JSON.parse(fs.readFileSync(path.resolve("data/topics-corpus.json"), "utf8")) as {
  days: Record<string, { date: string; items: Array<{ t?: string; u?: string; d?: string; m?: number; k?: string }> }>;
};

const dates = Object.keys(corpus.days).sort().slice(-daysWanted);
if (!dates.length) {
  console.error("语料库为空");
  process.exit(2);
}
const lastDate = dates[dates.length - 1];

const loaded = loadFocusConfig(readFocusConfigFiles(process.cwd()), { today: lastDate });
const focuses: FocusItem[] = loaded.items
  .filter((it) => (flag("all") ? true : isFocusInWindow(it, lastDate)))
  .map((it) => ({ ...it, status: "active" as const }));

const LAYER: Record<string, string> = { annual: "年度", quarterly: "季度", temporary: "临时" };

interface Row {
  date: string;
  cat: "finance" | "gz";
  title: string;
  url?: string;
  base: number;
  focus: number;
  final: number;
  rankA: number;
  rankB: number;
  hits: Array<{ id: string; name: string; layer: string; grade: string; level: string; bonus: number }>;
}

/**
 * section → 池栏目。与 `exec-pool.ts#SECTION_TO_CAT` 同一口径：
 * policy_market 进 finance 栏，gz_local/biz_insight 进 gz 栏，tech/ipo 不进 exec 池。
 * 🔴 必须分栏排名：生产里两栏分别喂 LLM、互不竞争。混合排名会造出「广交会被宏观稿挤下去」
 * 这类**伪问题**（两者根本不在同一栏），据此调参就是调错方向。
 */
const SECTION_TO_CAT: Record<string, "finance" | "gz" | null> = {
  policy_market: "finance",
  gz_local: "gz",
  biz_insight: "gz",
  tech: null,
  ipo: null,
};

const all: Row[] = [];
let itemCount = 0;
let hitCount = 0;
let skipped = 0;
const levelCount = { M3: 0, M2: 0, M1: 0 };
const perFocus = new Map<string, { name: string; layer: string; grade: string; hits: number; top5: number }>();

for (const d of dates) {
  const items = (corpus.days[d].items ?? []).filter((it) => (it.t ?? "").trim());
  if (!items.length) continue;
  const scored = items.map((it, idx) => {
    const title = it.t!.trim();
    const cat = SECTION_TO_CAT[it.k ?? ""] ?? null;
    const base = scoreBranchRelevance({ title }).score;
    const r = applyFocus({ title }, base, focuses);
    return { idx, title, url: it.u, cat, base, focus: r.focusRelevance, final: r.finalScore, r };
  });
  for (const cat of ["finance", "gz"] as const) {
    const group = scored.filter((x) => x.cat === cat);
    skipped += scored.length - group.length === 0 ? 0 : 0;
    if (!group.length) continue;
    // 两条排序都用「分数降序 + 原序」稳定比较，唯一变量是 focus
    const byA = [...group].sort((a, b) => b.base - a.base || a.idx - b.idx);
    const byB = [...group].sort((a, b) => b.final - a.final || a.idx - b.idx);
    const ra = new Map(byA.map((x, i) => [x.idx, i + 1]));
    const rb = new Map(byB.map((x, i) => [x.idx, i + 1]));
    for (const x of group) {
      const rankA = ra.get(x.idx)!;
      const rankB = rb.get(x.idx)!;
      const hits = x.r.counted.map((c) => ({
        id: c.match.focusId,
        name: c.match.name,
        layer: c.match.layer,
        grade: c.match.grade,
        level: c.match.matchLevel,
        bonus: c.bonus,
      }));
      itemCount++;
      if (x.r.matches.length) hitCount++;
      for (const m of x.r.matches) levelCount[m.matchLevel]++;
      for (const h of hits) {
        const p = perFocus.get(h.id) ?? { name: h.name, layer: h.layer, grade: h.grade, hits: 0, top5: 0 };
        p.hits++;
        if (rankB <= 5) p.top5++;
        perFocus.set(h.id, p);
      }
      all.push({ date: d, cat, title: x.title, url: x.url, base: x.base, focus: x.focus, final: x.final, rankA, rankB, hits });
    }
  }
  skipped += scored.filter((x) => x.cat === null).length;
}

const P = (s: string) => process.stdout.write(`${s}\n`);
const moved = all.filter((r) => r.rankA !== r.rankB);
const up = [...moved].sort((a, b) => a.rankB - a.rankA - (b.rankB - b.rankA));
const down = [...moved].sort((a, b) => b.rankB - b.rankA - (a.rankB - a.rankA));
// False Boost：基础分低（<40）**且是加权把它送进前 3**（rankA>3 → rankB≤3）。
// 只看 rankB≤3 会把「该栏当天本来就只有低分条」也算进来，那是数据现状不是加权之过。
const falseBoost = all.filter((r) => r.base < 40 && r.rankA > 3 && r.rankB <= 3);
// 被重点机制挤出前 3 的高分条目（应只有同分竞争，不应有真高分被挤）
const squeezed = all.filter((r) => r.base >= 70 && r.rankA <= 3 && r.rankB > 3);

P(`\n=== 经营重点加权 · 历史语料回放（最近 ${dates.length} 天：${dates[0]} ~ ${lastDate}）===`);
P(`配置版本 ${loaded.version}｜沙盘启用 ${focuses.length} 条（忽略 inactive${flag("all") ? "、忽略窗口" : "、按最近日期窗口"}）`);
P(`\n[总览] 进池条目 ${itemCount}（tech/ipo 不进 exec 池，已排除 ${skipped} 条）｜命中至少一个重点 ${hitCount}（${((hitCount / Math.max(itemCount, 1)) * 100).toFixed(1)}%）`);
P(`  等级分布：M3 ${levelCount.M3}｜M2 ${levelCount.M2}｜M1 ${levelCount.M1}`);
P(`  排序发生变化 ${moved.length} 条（${((moved.length / Math.max(itemCount, 1)) * 100).toFixed(1)}%）`);
P(`  False Boost（base<40 进前 3）${falseBoost.length} 条｜高分被挤出前 3（base≥70）${squeezed.length} 条`);

P(`\n[重点覆盖]`);
for (const [, v] of [...perFocus].sort((a, b) => b[1].hits - a[1].hits)) {
  P(`  ${LAYER[v.layer]}/${v.grade} ${v.name}：命中 ${v.hits} 条，其中进当日前 5 共 ${v.top5} 条`);
}
const never = focuses.filter((f) => !perFocus.has(f.id));
if (never.length) P(`  ⚠️ 零命中重点：${never.map((f) => f.name).join("、")}`);

P(`\n[提升最大 12 条]`);
for (const r of up.slice(0, 12)) {
  P(`  ${r.date}[${r.cat}] ${r.rankA}→${r.rankB}（基础 ${r.base} + 重点 ${r.focus}）${r.title.slice(0, 32)}`);
  for (const h of r.hits) P(`      ← ${LAYER[h.layer]}${h.level} +${h.bonus}「${h.name}」`);
}

P(`\n[压低最大 8 条]`);
for (const r of down.slice(0, 8)) {
  P(`  ${r.date}[${r.cat}] ${r.rankA}→${r.rankB}（基础 ${r.base} + 重点 ${r.focus}）${r.title.slice(0, 32)}`);
}

if (falseBoost.length) {
  P(`\n🔴 [False Boost 明细]`);
  for (const r of falseBoost) P(`  ${r.date}[${r.cat}] 基础 ${r.base}→第 ${r.rankB}｜${r.title.slice(0, 32)}`);
}
if (squeezed.length) {
  P(`\n⚠️ [高分被挤出前 3]（判定：谁把它挤下去的，被挤者的 base 是否明显高于挤人者）`);
  for (const r of squeezed) {
    P(`  ${r.date}[${r.cat}] 基础 ${r.base} 第 ${r.rankA}→${r.rankB}｜${r.title.slice(0, 30)}`);
    const rivals = all
      .filter((x) => x.date === r.date && x.cat === r.cat && x.rankB < r.rankB && x.rankA > r.rankA)
      .sort((a, b) => a.rankB - b.rankB);
    for (const v of rivals) {
      const gap = r.base - v.base;
      const flagTxt = gap > 10 ? "  🔴 跨档（低分靠加权越过）" : gap > 0 ? "  ⚠️ 低分越过" : "  ✓ 同分/更高分";
      P(`      ↑ 被 ${v.title.slice(0, 26)}（基础 ${v.base}，差 ${gap > 0 ? "+" : ""}${gap}）${flagTxt}`);
    }
  }
}

const outDir = path.resolve("deliverables/focus-engine-2026-11-28");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `corpus-replay-${daysWanted}d.json`);
fs.writeFileSync(
  outFile,
  JSON.stringify(
    {
      window: { from: dates[0], to: lastDate, days: dates.length },
      version: loaded.version,
      sandbox: { ignoreStatus: true, count: focuses.length },
      summary: { itemCount, hitCount, levelCount, movedCount: moved.length, falseBoost: falseBoost.length, squeezed: squeezed.length },
      perFocus: [...perFocus].map(([id, v]) => ({ id, ...v })),
      up: up.slice(0, 40),
      down: down.slice(0, 20),
      falseBoost,
      squeezed,
    },
    null,
    2,
  ),
);
P(`\n回放数据已写入 ${path.relative(process.cwd(), outFile)}`);
