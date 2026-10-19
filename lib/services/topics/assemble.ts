/**
 * 主题跟踪 · 装配层（2026-10-19）：给聚类结果附加质量分与视图标记。
 *
 * 单独一层的原因：`cluster.ts` 产出纯结构（不依赖今天是谁），质量分需要 `today`
 * 与全语料原始节点数 —— 放这里保持「聚类可复现、装配可注入」。
 */
import { clusterTopicsDetailed, type Topic } from "./cluster";
import { isActiveThisWeek, isDormant, qualityOf, qualityScore, type QualityBreakdown } from "./quality";
import type { SlimDay } from "./slim";

export interface EnrichedTopic extends Topic {
  /** 质量分 0~100 */
  q: number;
  /** 四因子明细（页面可展开「为什么排这里」） */
  qd: QualityBreakdown;
  /** 本周是否有新进展（默认视图判据） */
  active: boolean;
  /** 是否沉底（近 90 天无新节点 → 页面默认折叠） */
  dormant: boolean;
  /** 聚类前的原始节点数（密度因子用） */
  rawCount: number;
}

/** 聚类 + 质量分 + 视图标记（一步到位的装配入口）。 */
export function buildTopics(days: SlimDay[], today: string, opts: Parameters<typeof clusterTopicsDetailed>[1] = {}): EnrichedTopic[] {
  const detailed = clusterTopicsDetailed(days, opts);
  return detailed.map(({ topic, rawCount }) => {
    const qd = qualityOf(topic, Math.max(rawCount, topic.nodes.length), today);
    return {
      ...topic,
      q: qualityScore(qd),
      qd,
      active: isActiveThisWeek(topic, today),
      dormant: isDormant(topic, today),
      rawCount,
    };
  });
}

/** 默认视图：本周有进展且未沉底的主题，按质量分降序。 */
export function activeView(topics: EnrichedTopic[]): EnrichedTopic[] {
  return topics.filter((t) => t.active && !t.dormant).sort((a, b) => b.q - a.q || a.label.localeCompare(b.label));
}

/** 全部视图（含沉底）：质量分降序，沉底沉到最后。 */
export function fullView(topics: EnrichedTopic[]): EnrichedTopic[] {
  return [...topics].sort((a, b) => Number(a.dormant) - Number(b.dormant) || b.q - a.q || a.label.localeCompare(b.label));
}
