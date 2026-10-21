/**
 * 研报台账合并（纯函数，零 IO、零时钟 —— 可单测）。
 *
 * 2026-10-19 sc 口径：**主题与研报都是「独立 + 全量」**，目录固定、每次更新往里并集合并，
 * 合并后做去重与窗口收敛。与 `lib/services/topics/corpus.ts` 的 mergeCorpus 同构。
 *
 * 与主题语料的一处刻意差异：
 *  - 主题语料**不裁旧**（长窗口趋势观察，裁了会「越跟越短」）；
 *  - 研报台账**按发布日期滚 90 天**——研报是时效观点，90 天外的研报对「今天怎么打」无参考价值，
 *    且不设上限会让 JSON 无限增长（3 天窗口 × 每天 1~3 条，年增约 500 条，可接受但没必要）。
 *
 * 去重口径：
 *  - 主键 = `url`（东财 infoCode 全局唯一）；
 *  - url 缺失时用「标题归一化」兜底（同题不同版不重复入库）；
 *  - **保留首见版本的元数据**（机构/研究员可能被源修正，但标题口径以首见为准，避免同文两版并存）。
 */
import type { ResearchLedger, ResearchLedgerItem, ResearchPanelItem } from "../../contracts/research";

/** 台账保留天数（按 publishedAt 滚动）。 */
export const RESEARCH_LEDGER_DAYS = 90;

export function emptyResearchLedger(): ResearchLedger {
  return { version: 1, updatedAt: "", items: [] };
}

function normTitle(title: string): string {
  return title.toLowerCase().replace(/[\s\p{P}]+/gu, "");
}

function keyOf(it: ResearchPanelItem): string {
  return it.url ? `u:${it.url}` : `t:${normTitle(it.title)}`;
}

/** 把某次抓取的条目并集合并进台账（不 mutate 入参）。 */
export function mergeResearchLedger(
  existing: ResearchLedger,
  incoming: ResearchPanelItem[],
  opts: { today: string; keepDays?: number },
): ResearchLedger {
  const keepDays = opts.keepDays ?? RESEARCH_LEDGER_DAYS;
  const byKey = new Map<string, ResearchLedgerItem>();
  /** 标题归一化 → 主键（跨 infoCode 的重复发布兜底，实测东财同文会发两个 infoCode）。 */
  const titleIndex = new Map<string, string>();

  for (const it of existing.items ?? []) {
    if (!it?.title || !it?.publishedAt) continue;
    const tk = normTitle(it.title);
    // 历史脏数据（同标题多 infoCode）也在这里收敛：只保留先出现的一条
    if (titleIndex.has(tk)) continue;
    const k = keyOf(it);
    byKey.set(k, it);
    titleIndex.set(tk, k);
  }

  for (const it of incoming) {
    if (!it?.title || !it?.url || !it?.publishedAt) continue;
    const uk = keyOf(it);
    const tk = normTitle(it.title);
    const hit = byKey.has(uk) ? uk : titleIndex.get(tk);
    if (hit) {
      // 🔴 firstSeen = 「最早一次抓到它的**抓取日**」，不是发布日期。
      //    首版曾拿 it.publishedAt 与 prev.firstSeen 比较 → 发布日早于抓取日（常态）时
      //    会把首见日错误前移，且破坏幂等（同批数据合并两次结果不同）。
      //    正确口径：拿本次抓取日 opts.today 与已有首见日比较，只有补跑更早批次才前移。
      const prev = byKey.get(hit) as ResearchLedgerItem;
      const seen = prev.firstSeen || opts.today;
      if (opts.today < seen) byKey.set(hit, { ...prev, firstSeen: opts.today });
      // 2026-10-21：老条目**补缺失的 pdfUrl**（确定性派生值，不存在「两版冲突」，
      // 故不受「元数据以首见为准」约束）；不覆盖已有值。
      if (!prev.pdfUrl && it.pdfUrl) byKey.set(hit, { ...prev, pdfUrl: it.pdfUrl });
      continue;
    }
    byKey.set(uk, { ...it, firstSeen: opts.today });
    titleIndex.set(tk, uk);
  }

  // 窗口收敛：按发布日期滚动 keepDays（today 为抓取日）
  const cutoff = cutDate(opts.today, keepDays);
  const items = [...byKey.values()]
    .filter((it) => it.publishedAt >= cutoff)
    .sort((a, b) =>
      a.publishedAt === b.publishedAt
        ? a.title.localeCompare(b.title, "zh")
        : b.publishedAt.localeCompare(a.publishedAt),
    );

  return { version: 1, updatedAt: opts.today, items };
}

/** YYYY-MM-DD 减去 n 天（纯字符串日期运算，不引入时钟）。 */
export function cutDate(today: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!m) return today;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** 台账 → 按发布日期分组（研报主页渲染用，日期降序）。 */
export function groupByPublishedDate(
  items: ResearchLedgerItem[],
): Array<{ date: string; items: ResearchPanelItem[] }> {
  const map = new Map<string, ResearchPanelItem[]>();
  for (const it of items ?? []) {
    if (!it?.publishedAt) continue;
    const arr = map.get(it.publishedAt) ?? [];
    arr.push(it);
    map.set(it.publishedAt, arr);
  }
  return [...map.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, list]) => ({ date, items: list }));
}
