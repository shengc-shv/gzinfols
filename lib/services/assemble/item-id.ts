/**
 * 条目 ID 填充（A2 地基，2026-09-16）——纯函数、幂等。
 *
 * 为什么单独一步：ID 必须在**组装期**写入契约（供渲染、详情页、二期检索共用），
 * 但又不能要求上游（采集 / 富集）感知它——那样改动面太大。故在渲染前统一补齐：
 *   - 已有 id → 原样保留（老报告重渲染不重新编号，保证链接不变）；
 *   - 缺 id  → 由 `itemIdOf(url)` 派生。
 *
 * 幂等 & 无副作用：不 mutate 入参，返回新对象；同一报告跑两次结果逐字节一致。
 */
import type { DailyReport, ReportItem, ReportSectionKey } from "../../contracts/report";
import { itemIdOf } from "../../utils/item-id";

/** 给单个条目补 id（缺失时派生）。 */
export function itemIdFor(it: ReportItem): string {
  return it.id ?? itemIdOf(it.url);
}

/** 给报告内所有板块条目补齐 id（幂等；不 mutate 入参）。 */
export function assignItemIds(report: DailyReport): DailyReport {
  const sections = report.sections ?? ({} as DailyReport["sections"]);
  const next: Partial<Record<ReportSectionKey, ReportItem[]>> = {};
  let touched = false;
  for (const key of Object.keys(sections) as ReportSectionKey[]) {
    const list = sections[key] ?? [];
    next[key] = list.map((it) => {
      if (it.id) return it;
      touched = true;
      return { ...it, id: itemIdOf(it.url) };
    });
  }
  return touched ? { ...report, sections: next as DailyReport["sections"] } : report;
}
