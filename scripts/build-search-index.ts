/**
 * 构建期「每期 slim 索引」（B1 检索的地基，2026-09-17）。
 *
 * ⚠️ 2026-10-19 拆分：**主题聚类已迁出**到 `lib/services/topics/`（独立子模块，见
 * `scripts/topics-cluster.ts`）。本脚本现在只负责搜索索引；slim 数据层也改为
 * import 共享实现（`lib/services/topics/slim.ts`），两边同源不漂移。
 *
 * 为什么需要它：`site/` 此前只有 HTML —— 读者可见的归档**内容不可检索**
 * （PRD 诊断「站内无搜索」）。评估已澄清：**不需要**「延长历史正文保留期」前置工程，
 * gh-pages 上的归档本就无限累积，缺的只是「站点根有结构化数据」。
 *
 * 设计纪律：
 *  - **与渲染同源**：条目 ID / 重要度 / 加密红线一律复用渲染入口同一条纯函数链
 *    （`stripCryptoNews → recalibrateImportance → assignItemIds`），
 *    保证索引里的 id 与当日页面上的锚点 `itm-xxx` **逐字一致**（否则检索结果是死链）；
 *  - **不入库**：产物写在 `build/search-index/`（.gitignore），由 `build-site.mjs`
 *    搬进 `site/data/`，保持「build-site 是 site/ 的唯一写者」；
 *  - slim：每期只留检索/归档必需字段（约 3–6 KB/期），不搬正文全文。
 *
 * 用法：npx tsx scripts/build-search-index.ts [--out=<dir>]
 */
import fs from "node:fs";
import path from "node:path";
import type { DailyReport } from "../lib/contracts/report";
import { REPORT_TZ } from "../lib/utils/time";
import { itemIdOf } from "../lib/utils/item-id";
// slim 数据层与主题聚类同在 topics 子模块（2026-10-19 拆出）；搜索侧只消费 slim。
import {
  buildSlimDay,
  clip,
  toSlim,
  type SlimDay,
  type SlimItem,
} from "../lib/services/topics/slim";

/** 输出目录（构建产物，不入库）。 */
const OUT = "build/search-index";
/** 报告 JSON 的读取来源（与 build-site 同序：当日产物优先，其次历史归档）。 */
const SRC_DIRS = ["daily_reports", "history"];


/**
 * 只保留**页面上真有锚点**的条目（否则检索结果是死链）。
 *
 * 为什么必须做这一层：页面在渲染时做了跨板块去重（一文一卡），且「今日必读 / 风险提示 /
 * 股市快讯」并不都有正文卡片；索引若照单全收，链接 `#itm-xxx` 会指向不存在的元素
 * （点了只是跳到当期页顶部，看着像坏了）。故以**页面实际锚点集合**为准做交集。
 */
export function filterToAnchors(day: SlimDay, anchors: Set<string>): SlimDay {
  return { ...day, items: day.items.filter((it) => it.i && anchors.has(it.i)) };
}

/** 从已渲染的 HTML 里抽取全部条目锚点 id（itm-xxx）。 */
export function anchorsOfHtml(html: string): Set<string> {
  const out = new Set<string>();
  const re = /id="(itm-[A-Za-z0-9]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.add(m[1]);
  return out;
}

export interface SearchManifest {
  version: number;
  /** 生成时刻（报告时区，北京时间）。 */
  generatedAt: string;
  dates: string[];
  total: number;
  /** 全部出现过的标签（去重、按出现次数降序）。 */
  tags: { t: string; n: number }[];
}

function parseArgs(): { out: string } {
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--out=")) return { out: a.slice("--out=".length) };
  }
  return { out: OUT };
}

/** 目录下形如 `<date>/<date>.json` 的报告。 */
function reportPaths(dir: string): { date: string; file: string }[] {
  if (!fs.existsSync(dir)) return [];
  const out: { date: string; file: string }[] = [];
  for (const d of fs.readdirSync(dir)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const f = path.join(dir, d, `${d}.json`);
    if (fs.existsSync(f)) out.push({ date: d, file: f });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/** 当期已渲染 HTML 的路径（daily_reports 优先，其次 history）。 */
function htmlPathOf(date: string): string | null {
  for (const dir of SRC_DIRS) {
    const f = path.join(dir, date, `${date}.html`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function main(): number {
  const { out } = parseArgs();
  const picked = new Map<string, string>();
  for (const dir of SRC_DIRS) {
    for (const { date, file } of reportPaths(dir)) if (!picked.has(date)) picked.set(date, file);
  }
  if (picked.size === 0) {
    console.warn(`[search-index] 未找到任何报告 JSON（已尝试 ${SRC_DIRS.join(" / ")}）→ 跳过`);
    return 0;
  }
  fs.mkdirSync(out, { recursive: true });

  const tagCount = new Map<string, number>();
  const dates: string[] = [];
  let total = 0;
  for (const [date, file] of [...picked.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
    let report: DailyReport;
    try {
      report = JSON.parse(fs.readFileSync(file, "utf8")) as DailyReport;
    } catch (e) {
      console.warn(`[search-index] ${file} 解析失败，跳过：${(e as Error).message}`);
      continue;
    }
    // 以**页面实际锚点**为准：只索引页面上真有卡片的条目（避免死链）
    const htmlFile = htmlPathOf(date);
    if (!htmlFile) {
      console.warn(`[search-index] ${date} 未找到已渲染 HTML → 无法校验锚点，跳过该期`);
      continue;
    }
    const slim = buildSlimDay({ ...report, date: report.date ?? date } as DailyReport);
    const base = slim.items.filter((it: SlimItem) => it.i && it.t);
    const anchors = anchorsOfHtml(fs.readFileSync(htmlFile, "utf8"));
    // A2（条目 ID）之前生成的老页面一个锚点都没有 → 不按锚点过滤（否则整期消失），
    // 但标记 anchored=false，检索结果只链到当期页、不带锚点。
    const anchored = anchors.size > 0;
    const items = anchored ? filterToAnchors({ ...slim, items: base }, anchors).items : base;
    for (const it of items) for (const g of it.g) tagCount.set(g, (tagCount.get(g) ?? 0) + 1);
    fs.writeFileSync(
      path.join(out, `${date}.json`),
      JSON.stringify({ date, hero: slim.hero, items, anchored }, null, 0) + "\n",
      "utf8",
    );
    dates.push(date);
    total += items.length;
  }

  const manifest: SearchManifest = {
    version: 1,
    generatedAt: new Intl.DateTimeFormat("en-CA", {
      timeZone: REPORT_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .format(new Date())
      .replace(", ", "T"),
    dates: dates.sort((a, b) => b.localeCompare(a)),
    total,
    tags: [...tagCount.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([t, n]) => ({ t, n })),
  };
  fs.writeFileSync(
    path.join(out, "manifest.json"),
    JSON.stringify(manifest, null, 0) + "\n",
    "utf8",
  );
  console.log(
    `[search-index] ✅ ${dates.length} 期 / ${total} 条 / ${manifest.tags.length} 个标签 → ${out}/` +
      `（主题跟踪已拆至 topics 子模块，见 scripts/topics-cluster.ts）`,
  );
  return 0;
}

// 仅当被直接执行时才跑 main（被测试 import 时不得执行、更不得 process.exit）
const invokedDirectly = (() => {
  const entry = process.argv[1] ?? "";
  return /build-search-index\.(ts|js|mjs)$/.test(entry);
})();
if (invokedDirectly) process.exit(main());
