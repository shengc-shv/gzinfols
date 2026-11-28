/**
 * 领域专题索引（二期 WP10 · 2026-11-28）· 纯函数、零 IO、零 LLM、零时钟。
 *
 * 用途：把跨期语料（`data/topics-corpus.json`）按**六大经营领域**聚合成一页数据，
 * 让「财富管理这三个月在发生什么」可以被一次看完 —— 首页的领域模块只按日给几条，
 * 跨期视角此前没有落点。
 *
 * 三条口径：
 *  1. **判定复用生产函数**：领域用 `classifyBusinessDomain`（title + 摘要 + 既有标签），
 *     ⛔ 不在构建期另写一套关键词匹配 —— 否则同一篇稿在日报里属「零售信贷」、
 *     在专题页属「财富管理」，读者会当成 bug；
 *  2. **二级主题只做分组**（`classifySubtopic`），不改变任何报告字段与排序；
 *  3. **同一条跨期只出现一次**：语料按 `id` 去重、保留**最近一次**出现的期次
 *     （专题页的阅读动机是「最近怎么样」，不是「最早什么时候出现」）。
 *
 * 时间基准：一律取**语料里最新的期次日**，不看系统时钟（补跑/回放时时钟不可信）。
 */
import type { SlimItem } from "../topics/slim";
import { BUSINESS_DOMAINS, classifyBusinessDomain, classifySubtopic } from "./business-domains";

/** 专题页里的一条资讯（已裁剪到展示所需字段）。 */
export interface DomainIndexItem {
  /** 条目 id（跨期去重主键） */
  id: string;
  /** 最近一次出现的期次（YYYY-MM-DD） */
  date: string;
  title: string;
  url: string;
  source: string;
  /** 板块键（gz_local / policy_market / ...） */
  section: string;
  /** 二级主题；未命中为 null（页面归入「其他」） */
  subtopic: string | null;
  tags: string[];
  /** 展示日期（语料原始 MM/DD） */
  itemDate: string;
}

export interface DomainIndexDomain {
  id: string;
  name: string;
  short: string;
  /** 窗口内该领域条目数（去重后） */
  count: number;
  /** 二级主题计数（全窗口口径，不受 items 截断影响） */
  subtopics: Array<{ name: string; count: number }>;
  /** 以下三项来自 `config/business-domains.json`，纯展示 */
  segments: string[];
  products: string[];
  eventTypes: string[];
  items: DomainIndexItem[];
}

export interface DomainIndex {
  version: 1;
  /** 语料里最新的期次日（不是生成时钟） */
  generatedAt: string;
  /** 覆盖期数（语料按期次推进，假日无期次，故不是日历天数） */
  windowRuns: number;
  /** 窗口内条目总数 */
  total: number;
  /** 命中六大领域的条数（其余为「无可靠关联」，按红线不硬凑） */
  classified: number;
  domains: DomainIndexDomain[];
}

/**
 * 每个领域最多保留多少条明细。
 *
 * 80 条按当前语料量（约 40 条/期）足以覆盖两周里该领域的全部条目，
 * 再多的阅读价值低于体积成本（整页会到几百 KB）。
 */
export const MAX_ITEMS_PER_DOMAIN = 80;

export function buildDomainIndex(input: {
  days: Record<string, { items?: SlimItem[] } | undefined>;
  windowRuns?: number;
  maxItemsPerDomain?: number;
}): DomainIndex {
  const windowRuns = Math.max(1, Math.floor(input.windowRuns ?? 30));
  const cap = Math.max(1, Math.floor(input.maxItemsPerDomain ?? MAX_ITEMS_PER_DOMAIN));
  const allDates = Object.keys(input.days ?? {}).sort(); // 升序
  const dates = allDates.slice(-windowRuns).reverse(); // 取最近 N 期，降序
  const generatedAt = dates[0] ?? "";

  /** id → 最近一次出现的条目（降序遍历 → 首次写入即最新） */
  const byId = new Map<string, { date: string; item: SlimItem }>();
  for (const date of dates) {
    for (const it of input.days[date]?.items ?? []) {
      if (!it || !it.i || !it.t) continue;
      if (byId.has(it.i)) continue; // 已由更近的期次登记
      byId.set(it.i, { date, item: it });
    }
  }

  const buckets = new Map<
    string,
    { items: Array<{ date: string; item: SlimItem; subtopic: string | null }>; subs: Map<string, number> }
  >();
  for (const d of BUSINESS_DOMAINS) buckets.set(d.id, { items: [], subs: new Map() });

  let total = 0;
  let classified = 0;
  // 降序日期 + 原始顺序 → 每个领域里天然是「新在前」
  for (const rec of byId.values()) {
    total += 1;
    const it = rec.item;
    const cls = classifyBusinessDomain({ title: it.t, summary: it.x, tags: it.g });
    if (!cls) continue; // 无可靠关联：不硬凑进任何领域（与生产判定同一红线）
    classified += 1;
    const bucket = buckets.get(cls.primary_domain);
    if (!bucket) continue;
    // 🔴 标题命中优先：摘要里的「基金/理财/客户」这类泛词极容易把一条宏观稿拽进
    // 「代销与中收」这类分组（实测「A股缩量震荡·银行板块走强」曾因摘要里的「基金」被归到
    // 代销）。标题是作者给的唯一确定性主谓，摘要只作兜底。
    // 两级门槛：标题命中 1 个词即可；退回摘要时必须命中 ≥2 个词
    //（摘要里「基金」「客户」这类泛词单命中就能把任何宏观稿拽进某个分组）。
    const sub =
      classifySubtopic(cls.primary_domain, { title: it.t }) ??
      classifySubtopic(cls.primary_domain, { title: it.t, summary: it.x, tags: it.g }, { minHits: 2 });
    if (sub) bucket.subs.set(sub, (bucket.subs.get(sub) ?? 0) + 1);
    bucket.items.push({ date: rec.date, item: it, subtopic: sub });
  }

  const domains: DomainIndexDomain[] = BUSINESS_DOMAINS.map((d) => {
    const bucket = buckets.get(d.id)!;
    const ordered = bucket.items
      .slice()
      .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1))
      .slice(0, cap)
      .map(({ date, item, subtopic }) => ({
        id: item.i,
        date,
        title: item.t,
        url: item.u,
        source: item.s,
        section: item.k,
        subtopic,
        tags: item.g ?? [],
        itemDate: item.d ?? "",
      }));
    return {
      id: d.id,
      name: d.name,
      short: d.short,
      count: bucket.items.length,
      // 二级主题按计数降序、同数按配置顺序（稳定）
      subtopics: [...bucket.subs.entries()]
        .map(([name, count], idx) => ({ name, count, idx }))
        .sort((a, b) => b.count - a.count || a.idx - b.idx)
        .map(({ name, count }) => ({ name, count })),
      segments: [...d.segments],
      products: [...d.products],
      eventTypes: [...d.event_types],
      items: ordered,
    };
  });

  return { version: 1, generatedAt, windowRuns, total, classified, domains };
}
