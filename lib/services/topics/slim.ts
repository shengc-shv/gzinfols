/**
 * 主题跟踪 · 共享 slim 数据层（2026-10-19 独立子模块改造）。
 *
 * 为什么抽出来：`slim`（报告 → 检索/聚类用的最小条目集）原先住在
 * `scripts/build-search-index.ts` 里，主题聚类因此**寄居在搜索脚本内** ——
 * 违反「主题跟踪是独立子模块、不得与主项目互相干扰」的架构指示（2026-10-19 sc）。
 * 本模块把它提为 services 层纯函数，搜索脚本与 topics 脚本**共用同一份实现**：
 * 共享数据但不共享代码路径，任一侧改口径两边同时生效（同向，不是耦合风险）。
 *
 * 纪律（与搜索侧逐字对齐，否则两边 id 会漂移）：
 *  - **与渲染同源**：条目 id 复用 `itemIdOf(url)`，保证主题页锚点与当日页面一致；
 *  - slim：只留聚类/检索必需字段，不搬正文全文；
 *  - 纯函数：零 IO、零时钟、零 env（IO 全在 scripts 入口）。
 */
import type { DailyReport, ReportItem } from "../../contracts/report";
import { recalibrateImportance } from "../assemble/importance";
import { stripCryptoNews } from "../assemble/safety";
import { assignItemIds } from "../assemble/item-id";
import { itemIdOf, summaryAnchorId } from "../../utils/item-id";

/** 摘要截断长度（主题卡只显示首句，全文在原文/详情页）。 */
export const SUMMARY_MAX = 90;

export interface SlimItem {
  /** 条目 ID（与页面锚点同源）—— **跨期去重的主键**（2026-10-19 A 型修复）。 */
  i: string;
  /** 标题 */
  t: string;
  /** 来源 */
  s: string;
  /** 展示日期 MM/DD（2026-10-19 B 型修复：原先聚类时漏传，节点日期全 undefined） */
  d: string;
  /** 重要度 1–3（渲染重标定后的口径） */
  m: number;
  /** 板块键 */
  k: string;
  /** 标签（含客群段位） */
  g: string[];
  /** 摘要（截断） */
  x: string;
  /** 原文链接 */
  u: string;
}

export interface SlimDay {
  date: string;
  hero: string;
  items: SlimItem[];
}

/** 摘要截断（检索/主题页只显示首句）。 */
export function clip(s: string): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > SUMMARY_MAX ? `${t.slice(0, SUMMARY_MAX)}…` : t;
}

/** 报告条目 → slim 条目。 */
export function toSlim(it: ReportItem, section: string): SlimItem {
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

/** 板块键 → 中文名（主题页与主题卡共用；tech 恒无数据时该键自然不出现）。 */
export const SECTION_NAMES: Record<string, string> = {
  gz_local: "广州本地",
  biz_insight: "业务启示",
  policy_market: "政策与市场",
  tech: "科技前沿",
  ipo: "广东IPO",
  must: "今日必读",
  insight: "商机洞察",
  risk: "风险提示",
  stock: "股市动态",
};

/**
 * 报告 → 当期 slim 索引（与渲染同源：红线过滤 → 重要度重标定 → 补 ID）。
 *
 * ⚠️ 与搜索版 `buildSlimDay` 的差异仅一处：**不做锚点过滤**（那是 IO 层的事，
 * 需要读已渲染 HTML）。锚点过滤由调用方（scripts 入口）在拿到 HTML 后自行做。
 */
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

  // ② 今日必读 / 风险提示：不在 sections 内（装配期未补 id），用同源 itemIdOf 派生
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
  // risk 在契约里是单条对象（RiskItem，非数组）；url 取其首个来源
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

  // ③ 股市快讯：只进搜索索引；主题聚类侧因无标签（g=[]）自然不成主题，无需额外排除
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

  // ④ 商机洞察：客群段位并入标签（与 C1 客群视图同一数据源）
  //
  // 🔴 落点口径（2026-10-19 sc）：商机卡是 LLM 的二次加工，读者点进去应落到**正文那张资讯卡**。
  // 原实现只取 `sources[0].url` —— 实测 61 条商机里大量 sources[0] 并不在正文，
  // 而 sources[1]/[2] 才是正文条目，于是节点 id 与正文卡对不上（点了只能落在摘要区）。
  // 现改为：**优先取「第一个在正文 sections 里的来源」**，没有才退回 sources[0]。
  // 命中时 id = 正文卡 id → dedupeById 自动合并成一条（商机内容 + 客群标签并进去），
  // 读者点进去就是那条资讯卡；未命中则保持独立节点（页面上摘要卡本身也有锚点）。
  const bodyUrls = new Set<string>();
  for (const [, list] of secs) for (const it of list ?? []) if (it.url) bodyUrls.add(it.url);
  for (const ins of prepared.insights ?? []) {
    const urls = (ins.sources ?? []).map((s) => s?.url).filter((u): u is string => Boolean(u));
    const url = urls.find((u) => bodyUrls.has(u)) ?? urls[0] ?? "";
    items.push({
      // 无 url 时不能用 itemIdOf("")（恒 itm-0，多张卡会撞成同一条）→ 用卡片文案派生
      i: url ? itemIdOf(url) : summaryAnchorId("insight", ins.topic ?? ""),
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
