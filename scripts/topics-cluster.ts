/**
 * 主题跟踪 · 聚类入口（2026-10-19 独立子模块）。
 *
 * 与主项目的关系（sc 架构指示：**不得干扰主项目其他板块**）：
 *  - **只读** `daily_reports/` + `history/` 的既有产物，不写它们、不改它们；
 *  - **不 import** daily 管线任何模块（pipeline / orchestrator / enrich / select…）；
 *    只复用少数无副作用纯函数（itemIdOf / stripCryptoNews 等，经 slim.ts）；
 *  - 自己维护语料快照 `data/topics-corpus.json`（**不受主项目 7 天归档周期影响**，
 *    否则长窗口趋势观察会「越跟越短」）；
 *  - 产物写 `build/topics/topics.json`（构建期中间物）+ `data/topics.json`（提交回 main，
 *    供 daily 的 build-site 渲染；与 data/redchip/ 同模式）。
 *
 * 窗口口径（sc 2026-10-19：**不受 2/3/7 天限制**）：
 *  不设天数窗口 —— 主题跟踪是周更 + 纯离线 + 零 LLM，没有每日处理量压力；
 *  「趋势」的本质就是长窗口。老主题由质量分的「新近度」自然沉底（不消失）。
 *
 * 用法：
 *   npx tsx scripts/topics-cluster.ts            # 聚类 + 写 build/topics/ + data/topics.json
 *   npx tsx scripts/topics-cluster.ts --dry-run  # 只聚类打印，不写任何文件
 */
import fs from "node:fs";
import path from "node:path";
import { REPORT_TZ } from "../lib/utils/time";
import { buildSlimDay, type SlimDay } from "../lib/services/topics/slim";
import { buildTopics, activeView, fullView, type EnrichedTopic } from "../lib/services/topics/assemble";
import {
  emptyCorpus,
  mergeCorpus,
  corpusDays,
  corpusStats,
  type TopicCorpus,
} from "../lib/services/topics/corpus";
import type { DailyReport } from "../lib/contracts/report";

/** 报告 JSON 的读取来源（与 build-site / build-search-index 同序：当日优先，其次历史）。 */
const SRC_DIRS = ["daily_reports", "history"];
/** 自有语料快照（永久保留，不受 history/ 归档周期影响）。 */
const CORPUS_PATH = path.resolve("data/topics-corpus.json");
/** 聚类中间产物（不入库；daily 的 build-site 读 data/topics.json）。 */
const OUT_DIR = "build/topics";
/** 提交回 main 的数据（build-site 渲染 topics.html 时优先读它）。 */
const DATA_OUT = path.resolve("data/topics.json");

/** 今天的北京日期（唯一时钟来源：REPORT_TZ 常量，不回落系统时区）。 */
function todayKey(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .replace(/-/g, "-");
}

function parseArgs(): { dryRun: boolean } {
  return { dryRun: process.argv.slice(2).includes("--dry-run") };
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
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** 读语料快照（不存在 / 损坏 → 空语料，绝不让坏文件阻断聚类）。 */
function loadCorpus(): TopicCorpus {
  try {
    if (!fs.existsSync(CORPUS_PATH)) return emptyCorpus();
    const raw = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8")) as TopicCorpus;
    if (!raw || typeof raw !== "object" || !raw.days) return emptyCorpus();
    return { ...emptyCorpus(), ...raw };
  } catch (e) {
    console.warn(`[topics] 语料快照读取失败，按空语料处理：${(e as Error).message}`);
    return emptyCorpus();
  }
}

/** 把现成报告 JSON 转成当天 slim（与搜索侧同源，但不做锚点过滤 —— 那是 IO 层的事）。 */
function collectIncoming(): SlimDay[] {
  const picked = new Map<string, string>();
  for (const dir of SRC_DIRS) {
    for (const { date, file } of reportPaths(dir)) if (!picked.has(date)) picked.set(date, file);
  }
  const out: SlimDay[] = [];
  for (const [date, file] of [...picked.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    try {
      const report = JSON.parse(fs.readFileSync(file, "utf8")) as DailyReport;
      out.push(buildSlimDay({ ...report, date: report.date ?? date } as DailyReport));
    } catch (e) {
      console.warn(`[topics] ${file} 解析失败，跳过：${(e as Error).message}`);
    }
  }
  return out;
}

/** 上一版产物里的主题数（读不到 / 损坏 → 0，表示「没有可保护的历史版本」）。 */
function previousTopicCount(): number {
  try {
    if (!fs.existsSync(DATA_OUT)) return 0;
    const prev = JSON.parse(fs.readFileSync(DATA_OUT, "utf8")) as { topics?: unknown[] };
    return Array.isArray(prev?.topics) ? prev.topics.length : 0;
  } catch {
    return 0;
  }
}

function main(): number {
  const { dryRun } = parseArgs();
  const today = todayKey();

  // ① 语料：现成产物 → 增量合并进自有快照（永久保留）
  const existing = loadCorpus();
  const incoming = collectIncoming();
  const corpus = mergeCorpus(existing, incoming);
  const days = corpusDays(corpus);
  const st = corpusStats(corpus);
  console.log(
    `[topics] 语料 ${st.days} 期 / ${st.items} 条（去重）/ 跨期出现 ${st.repeated} 条 / 跨度 ${st.span}` +
      `；本次新并入 ${incoming.length} 天`,
  );

  // ② 聚类 + 质量分（零 LLM）
  const topics = buildTopics(days, today);
  const act = activeView(topics);
  console.log(
    `[topics] 主题 ${topics.length} 个（本周有进展 ${act.length} 个）；` +
      `Top5：${fullView(topics).slice(0, 5).map((t) => `${t.label}(${t.q})`).join(" / ")}`,
  );

  if (dryRun) {
    console.log("[topics] --dry-run：不写任何文件");
    printDigest(topics, act);
    return 0;
  }

  // ③ 失败保护（P17 同类红线：**「0 主题」必须能与「真的没有」区分**）
  //   语料快照损坏 / 报告全读不到时，`emptyCorpus()` 会让主题数变 0 —— 若无条件写盘，
  //   就会用「空主题列表」覆盖上一版有效产物（SEC 曾照写空快照覆盖有效数据）。
  //   → 上次有主题、本次算 0：判定异常，**放弃写盘并退出 1**（CI 侧 continue-on-error，
  //     页面继续用上一版 data/topics.json，主题页不会突然变空）。
  if (topics.length === 0) {
    const prev = previousTopicCount();
    if (prev > 0) {
      console.error(
        `[topics] ✗ 本次聚类 0 个主题（上一版 ${prev} 个）→ 判定异常，放弃写盘、保留上一版 ${DATA_OUT}`,
      );
      return 1;
    }
    console.warn("[topics] ⚠ 本次 0 个主题且无上一版产物 —— 按「真的没有」写盘");
  }

  // ④ 写语料快照（提交回 main）
  fs.mkdirSync(path.dirname(CORPUS_PATH), { recursive: true });
  fs.writeFileSync(CORPUS_PATH, JSON.stringify(corpus, null, 0) + "\n", "utf8");

  // ④ 写聚类产物：build/topics（中间物）+ data/topics.json（build-site 消费）
  const bundle = {
    version: 2,
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
    today,
    corpus: { days: st.days, items: st.items, span: st.span },
    topics: topics.map((t) => ({
      ...t,
      sections: undefined,
    })),
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "topics.json"), JSON.stringify(bundle, null, 0) + "\n", "utf8");
  fs.writeFileSync(DATA_OUT, JSON.stringify(bundle, null, 0) + "\n", "utf8");
  console.log(`[topics] ✅ 已写 ${CORPUS_PATH} / ${path.join(OUT_DIR, "topics.json")} / ${DATA_OUT}`);
  printDigest(topics, act);
  return 0;
}

function printDigest(topics: EnrichedTopic[], act: EnrichedTopic[]): void {
  console.log(`\n—— 本周有进展（默认视图，${act.length} 个）——`);
  for (const t of act) {
    const last = t.dates[t.dates.length - 1];
    console.log(
      `  ${String(t.q).padStart(3)} 分 [${t.label}] 最新 ${last} · ${t.nodes.length} 节点 / 跨 ${t.dates.length} 期`,
    );
  }
  const dormant = topics.filter((t) => t.dormant);
  if (dormant.length) console.log(`  💤 沉底（近 90 天无进展）：${dormant.map((t) => t.label).join("、")}`);
}

const invokedDirectly = (() => {
  const entry = process.argv[1] ?? "";
  return /topics-cluster\.(ts|js|mjs)$/.test(entry);
})();
if (invokedDirectly) process.exit(main());
