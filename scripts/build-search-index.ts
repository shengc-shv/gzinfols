/**
 * 构建期「每期 slim 索引」（B1 检索 + 主题化归档的地基，2026-09-17）。
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
import type { DailyReport, ReportItem } from "../lib/contracts/report";
import { assignItemIds } from "../lib/services/assemble/item-id";
import { recalibrateImportance } from "../lib/services/assemble/importance";
import { stripCryptoNews } from "../lib/services/assemble/safety";
import { REPORT_TZ } from "../lib/utils/time";
import { itemIdOf } from "../lib/utils/item-id";

/** 输出目录（构建产物，不入库）。 */
const OUT = "build/search-index";
/** 报告 JSON 的读取来源（与 build-site 同序：当日产物优先，其次历史归档）。 */
const SRC_DIRS = ["daily_reports", "history"];

/** 摘要截断长度（检索页只显示首句，全文在原文/详情页）。 */
const SUMMARY_MAX = 90;

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

export interface SlimItem {
  /** 条目 ID（与页面锚点同源） */
  i: string;
  /** 标题 */
  t: string;
  /** 来源 */
  s: string;
  /** 展示日期 MM/DD */
  d: string;
  /** 重要度 1–3（渲染重标定后的口径） */
  m: number;
  /** 板块键 */
  k: string;
  /** 标签（含客群段位） */
  g: string[];
  /** 摘要（截断） */
  x: string;
  /** 原文链接（兜底：详情页缺失时直链） */
  u: string;
}

export interface SlimDay {
  date: string;
  hero: string;
  items: SlimItem[];
  /**
   * 该期页面是否带有条目锚点（A2 之前生成的老页面没有）。
   * false → 检索结果只链到当期页（不拼 #itm- 锚点），避免死链；
   * 想让老期次也能锚点直达，需重渲染它们（`npm run render`）。
   */
  anchored?: boolean;
}

/**
 * 主题跟踪时间线（B2，2026-09-17）。
 *
 * 行长要的不是「今天有哪些条」，而是「**这件事后来怎么样了**」。事件记忆库只覆盖
 * 4 个播报板块（hero/must/insight/risk），正文条目不在其中 —— 故在**构建期**用
 * 跨期条目的主题标签聚类，得到主题级时间线（零 LLM、零后端，纯静态）。
 *
 * 聚类规则（保守，宁可主题少而准）：
 *  - **泛标签先剔除**：出现率 ≥ `commonRatio` 的标签（如「客群」「市场」）不参与建主题，
 *    否则半个版面会被聚成一个巨型主题；
 *  - 两个条目同主题 ⟺ 特征标签交集 ≥2（或一方只有 1 个特征标签且相同，或标题前 12 字相同）；
 *  - **只保留跨 ≥2 期的主题**（单期出现谈不上「跟踪」），节点按日期升序（= 进展顺序）。
 */
export interface TopicNode {
  date: string;
  i: string;
  t: string;
  s?: string;
  k: string;
  x?: string;
  /** 同一标题共出现几期（>1 即「持续跟踪中」；时间线只保留最早一条）。 */
  repeat?: number;
}

export interface Topic {
  id: string;
  label: string;
  tags: string[];
  /** 出现过的期次（升序）。 */
  dates: string[];
  /** 跨度天数（含首尾；构建期算好，页面不再解析日期 —— 与项目时间口径纪律一致）。 */
  spanDays: number;
  /** 进展节点（按日期升序 = 时间线顺序）。 */
  nodes: TopicNode[];
}

export interface ClusterOpts {
  /** 至少跨几期才算「跟踪中」的主题（默认 2）。 */
  minDates?: number;
  /** 最多输出多少个主题（默认 30）。 */
  maxTopics?: number;
  /** 每个主题最多保留多少节点（默认 12）。 */
  maxNodes?: number;
  /** 标签出现率超过该比例即视为泛标签，不参与聚类（默认 0.35）。 */
  commonRatio?: number;
}

/** 主题标签 → 读者可读名称（标签是机器口径，个别需要改写才好读）。 */
const LABEL_ALIAS: Record<string, string> = {
  粤: "广东IPO动态",
  零售AUM: "零售AUM客群",
  "中高端客群(过亿资产)": "中高端客群",
};

/**
 * 两个 YYYY-MM-DD 的自然日差（纯字符串运算，不涉时区换算 —— 与 `prevDateKey` 同口径）。
 * 放在构建期算，页面只显示结果，避免前端再解析日期。
 */
function dayGapKey(a: string, b: string): number {
  const pa = Date.parse(`${a}T00:00:00Z`);
  const pb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(pa) || Number.isNaN(pb)) return 0;
  return Math.max(0, Math.round((pb - pa) / 86_400_000));
}

/** 标题归一（取前 12 字，去空白）——聚类兜底信号。 */
function titleKeyOf(t: string): string {
  return String(t ?? "").replace(/\s+/g, "").slice(0, 12);
}

/** 稳定短哈希（djb2 → base36），保证主题 id 跨构建不变（与条目 ID 同源思路）。 */
function topicIdOf(label: string): string {
  let h = 5381;
  for (let i = 0; i < label.length; i++) h = ((h << 5) + h + label.charCodeAt(i)) | 0;
  return `tp-${(h >>> 0).toString(36)}`;
}

/**
 * 节点按标题去重（导出以便单测）：同一条新闻跨期重复出现 → 只留**最早**一条，
 * 并在 `repeat` 上记下共出现几期（时间线读起来是「进展」，不是「同一行刷两遍」）。
 */
export function dedupeNodesByTitle(
  nodes: Array<TopicNode & { repeat?: number }>,
): Array<TopicNode & { repeat?: number }> {
  const byTitle = new Map<string, TopicNode & { repeat?: number }>();
  for (const n of nodes) {
    const key = titleKeyOf(n.t);
    const prev = byTitle.get(key);
    if (prev) {
      prev.repeat = (prev.repeat ?? 1) + 1;
      continue;
    }
    byTitle.set(key, { date: n.date, i: n.i, t: n.t, s: n.s, k: n.k, x: n.x });
  }
  return [...byTitle.values()];
}

/** 跨期主题聚类（纯函数，可测）。 */
export function clusterTopics(days: SlimDay[], opts: ClusterOpts = {}): Topic[] {
  const minDates = opts.minDates ?? 2;
  const maxTopics = opts.maxTopics ?? 30;
  const maxNodes = opts.maxNodes ?? 12;
  const commonRatio = opts.commonRatio ?? 0.35;

  type RawNode = TopicNode & { tags: string[] };
  const all: RawNode[] = [];
  for (const d of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const it of d.items ?? []) {
      all.push({ date: d.date, i: it.i, t: it.t, s: it.s, k: it.k, x: it.x, tags: it.g ?? [] });
    }
  }
  if (all.length === 0) return [];

  // 泛标签识别（出现率过高 → 不参与建主题，避免「客群」吞掉半个版面）
  const tagFreq = new Map<string, number>();
  for (const n of all) for (const g of n.tags) tagFreq.set(g, (tagFreq.get(g) ?? 0) + 1);
  const common = new Set<string>();
  for (const [g, n] of tagFreq) {
    // 双条件：**出现 ≥3 次**且比例超阈值。只看比例会在小样本期（刚上线 1~2 期）把
    // 真正有区分度的标签误判为泛标签 —— 那样反而会聚不出任何主题。
    if (n >= 3 && n / all.length >= commonRatio) common.add(g);
  }

  const clusters: Array<{ feats: string[]; nodes: RawNode[] }> = [];
  for (const n of all) {
    const feats = n.tags.filter((g) => !common.has(g));
    if (feats.length === 0) continue; // 只有泛标签 → 不成主题（宁缺毋滥）
    // ⚠️ 簇的特征标签**不再吸收新标签**：早期版本边聚边扩，会让「财富」这类高频标签
    // 滚雪球式吞掉半个版面（实测把国资委支付账款、养老客群都吸进「财富」主题）。
    // 阈值取 **交集 ≥3**（而非 2）：索引里的标签是「业务线 + 客群 + 主题词」混装，
    // 交集 2 太容易命中（实测把理财打新、美债和信贷格局混成一个「客群」主题）。
    const hit = clusters.find((c) => {
      const overlap = c.feats.filter((f) => feats.includes(f)).length;
      if (overlap >= 3) return true;
      return Boolean(c.nodes[0] && titleKeyOf(c.nodes[0].t) === titleKeyOf(n.t));
    });
    if (!hit) {
      clusters.push({ feats: feats.slice(0, 6), nodes: [n] });
      continue;
    }
    hit.nodes.push(n);
  }

  // 同名主题合并（不同簇常落到同一高频标签 → 否则页面上会出现三个「客群」主题卡）
  const merged = new Map<string, { feats: string[]; nodes: RawNode[] }>();
  for (const c of clusters) {
    const key = [...c.feats].sort().join("|");
    const prev = merged.get(key);
    if (prev) prev.nodes.push(...c.nodes);
    else merged.set(key, { feats: [...c.feats], nodes: [...c.nodes] });
  }
  clusters.length = 0;
  clusters.push(...merged.values());

  const built: Topic[] = [];
  for (const c of clusters) {
    const dates = [...new Set(c.nodes.map((n) => n.date))].sort();
    // ⚠️ 节点**先去重再判数量**：两条同标题的跨期新闻去重后只剩 1 个节点，
    // 那不是「主题跟踪」而是一条新闻的重复（实测会产出「信贷」×3 这种单节点主题）。
    const rawNodes = [...c.nodes].sort((a, b) => a.date.localeCompare(b.date) || a.t.localeCompare(b.t));
    const deduped = dedupeNodesByTitle(rawNodes);
    if (dates.length < minDates || deduped.length < 2) continue;
    const inCluster = new Map<string, number>();
    for (const n of c.nodes) for (const f of c.feats) if (n.tags.includes(f)) inCluster.set(f, (inCluster.get(f) ?? 0) + 1);
    const tags = [...c.feats].sort(
      (a, b) => (inCluster.get(b) ?? 0) - (inCluster.get(a) ?? 0) || a.localeCompare(b),
    );
    // 主题名取**区分度最高**的标签（全局出现率最低），而不是簇内最高频的：
    // 「客群」「财富」这类高频标签当标题毫无信息量（实测出现三个「客群」主题卡）。
    const distinctive = [...tags].sort(
      (a, b) => (tagFreq.get(a) ?? 0) - (tagFreq.get(b) ?? 0) || a.localeCompare(b),
    );
    const label = LABEL_ALIAS[distinctive[0] ?? ""] ?? distinctive[0] ?? "（未命名主题）";
    const first = deduped[0];
    built.push({
      // id 掺入首节点：跨构建稳定（与条目 ID 同源思路），也保证同名主题合并前各自可寻址。
      id: topicIdOf(`${label}|${first?.i ?? first?.t ?? ""}`),
      label,
      tags,
      dates,
      spanDays: dayGapKey(dates[0] ?? "", dates[dates.length - 1] ?? "") + 1,
      nodes: deduped.slice(0, maxNodes),
    });
  }

  // 同名主题合并：读者视角里「同名 = 同一个主题」，页面上出现两个「信贷」只会让人困惑。
  const byLabel = new Map<string, Topic>();
  for (const t of built) {
    const prev = byLabel.get(t.label);
    if (!prev) {
      byLabel.set(t.label, t);
      continue;
    }
    prev.nodes = dedupeNodesByTitle([...prev.nodes, ...t.nodes]).slice(0, maxNodes);
    prev.dates = [...new Set([...prev.dates, ...t.dates])].sort();
    prev.spanDays = dayGapKey(prev.dates[0] ?? "", prev.dates[prev.dates.length - 1] ?? "") + 1;
    prev.tags = [...new Set([...prev.tags, ...t.tags])].slice(0, 6);
  }
  const topics = [...byLabel.values()];
  for (const t of topics) {
    const first = t.nodes[0];
    t.id = topicIdOf(`${t.label}|${first?.i ?? first?.t ?? ""}`);
  }
  return topics
    .sort((a, b) => b.nodes.length - a.nodes.length || a.label.localeCompare(b.label))
    .slice(0, maxTopics);
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

function clip(s: string): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > SUMMARY_MAX ? `${t.slice(0, SUMMARY_MAX)}…` : t;
}

function toSlim(it: ReportItem, section: string): SlimItem {
  return {
    i: it.id ?? "",
    t: it.title_cn || it.title_orig || "",
    s: it.source ?? "",
    d: it.date ?? "",
    m: it.importance ?? 1,
    k: section,
    g: (it.tags ?? []).filter(Boolean),
    x: clip(it.summary ?? ""),
    u: it.url ?? "",
  };
}

/** 报告 → 当期 slim 索引（与渲染同源：红线过滤 → 重要度重标定 → 补 ID）。 */
export function buildSlimDay(report: DailyReport): SlimDay {
  const prepared = assignItemIds(recalibrateImportance(stripCryptoNews(report)));
  const items: SlimItem[] = [];

  // ① 五大板块正文
  const secs: [string, ReportItem[] | undefined][] = [
    ["gz_local", prepared.sections?.gz_local],
    ["biz_insight", prepared.sections?.biz_insight],
    ["policy_market", prepared.sections?.policy_market],
    ["tech", prepared.sections?.tech],
    ["ipo", prepared.sections?.ipo],
  ];
  for (const [key, list] of secs) {
    for (const it of list ?? []) if (it.id) items.push(toSlim(it, key));
  }

  // ② 今日必读 / 风险提示 / 股市快讯：不在 sections 内（装配期未补 id），
  //    用与卡片同源的 itemIdOf(url) 派生 —— 保证锚点与索引一致
  for (const m of prepared.must_read ?? []) {
    items.push({
      i: itemIdOf(m.url),
      t: m.title ?? "",
      s: "今日必读",
      d: prepared.date?.slice(5).replace("-", "/") ?? "",
      m: 3,
      k: "must",
      g: [],
      x: clip(m.why ?? ""),
      u: m.url ?? "",
    });
  }
  // risk 在契约里是**单条对象**（RiskItem，非数组）；url 取其首个来源
  const risk = prepared.risk;
  if (risk) {
    const url = (risk as { sources?: { url?: string }[] }).sources?.[0]?.url ?? "";
    items.push({
      i: itemIdOf(url),
      t: (risk as { topic?: string }).topic ?? "风险提示",
      s: "风险提示",
      d: prepared.date?.slice(5).replace("-", "/") ?? "",
      m: 3,
      k: "risk",
      g: [],
      x: clip((risk as { impact?: string }).impact ?? ""),
      u: url,
    });
  }
  for (const s of prepared.stock_news ?? []) {
    if (!s.url) continue;
    items.push({
      i: itemIdOf(s.url),
      t: s.title_cn ?? "",
      s: s.source ?? "股市动态",
      d: s.date ?? "",
      m: 1,
      k: "stock",
      g: [],
      x: clip(s.summary ?? ""),
      u: s.url,
    });
  }

  // ③ 商机洞察：客群段位并入标签（C1 客群视图的同一数据源）
  for (const ins of prepared.insights ?? []) {
    const url = ins.sources?.[0]?.url ?? "";
    items.push({
      i: itemIdOf(url),
      t: ins.topic ?? "",
      s: "商机洞察",
      d: prepared.date?.slice(5).replace("-", "/") ?? "",
      m: 3,
      k: "insight",
      g: [...(ins.tags ?? []), ...(ins.segments ?? [])].filter(Boolean),
      x: clip(ins.impact ?? ""),
      u: url,
    });
  }

  return { date: prepared.date, hero: clip(prepared.hero_line ?? ""), items };
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
  const slimDays: SlimDay[] = []; // 供 B2 主题聚类（保留锚点过滤后的条目）
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
    slimDays.push({ date, hero: slim.hero, items, anchored });
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
  // —— B2 主题跟踪时间线：跨期聚类（依赖 B1 索引与 F1 的节点保留）——
  const topics = clusterTopics(slimDays);
  fs.writeFileSync(
    path.join(out, "topics.json"),
    JSON.stringify({ version: 1, generatedAt: manifest.generatedAt, topics }, null, 0) + "\n",
    "utf8",
  );
  console.log(
    `[search-index] ✅ ${dates.length} 期 / ${total} 条 / ${manifest.tags.length} 个标签 → ${out}/` +
      `；主题时间线 ${topics.length} 个（跨期）`,
  );
  return 0;
}

// 仅当被直接执行时才跑 main（被测试 import 时不得执行、更不得 process.exit）
const invokedDirectly = (() => {
  const entry = process.argv[1] ?? "";
  return /build-search-index\.(ts|js|mjs)$/.test(entry);
})();
if (invokedDirectly) process.exit(main());
