/**
 * 主题跟踪 · 自有语料快照（2026-10-19 sc 指示：数据要单独保存）。
 *
 * 为什么必须有它：主项目的 `history/` 有保留周期（`cleanup-history.mjs` 设计保留 7 天，
 * 远端现存累积 32 期纯因 CI 的 `git add history/` 不记录删除 —— 一旦修正就会掉到 7 天）。
 * 主题跟踪是**长窗口趋势观察**（不设天数窗口，见设计文档 §四），
 * 若语料跟着 history/ 被裁，主题就会「越跟越短」→ 趋势观察失去意义。
 *
 * 故本模块维护一份**独立于主项目归档周期**的语料快照：
 *  - 增量合并：每次只并入新一天的 slim 条目，已有条目（同 id）不重复；
 *  - 永久保留：不设天数裁剪，只随仓库增长；
 *  - 与 `data/redchip/` 同模式：本地/CI 提交回 main，下游构建期读取。
 *
 * 纯函数：零 IO、零时钟（合并逻辑可单测；读写由 scripts 入口负责）。
 */
import type { SlimDay, SlimItem } from "./slim";

/** 语料快照文件结构（`data/topics-corpus.json`）。 */
export interface TopicCorpus {
  /** 结构版本（1 = 2026-10-19 首版）。 */
  version: number;
  /** 最近一次合并的日期（YYYY-MM-DD）。 */
  updatedAt: string;
  /** 全量语料：日期 → 当期条目（日期升序由调用方保证）。 */
  days: Record<string, SlimDay>;
  /** 条目 id → 首次出现日期（跨期去重与 repeat 统计用）。 */
  firstSeen: Record<string, string>;
}

export function emptyCorpus(): TopicCorpus {
  return { version: 1, updatedAt: "", days: {}, firstSeen: {} };
}

/** 语料统计（周报与日志用）。 */
export interface CorpusStats {
  /** 期数（天数） */
  days: number;
  /** 去重后条目总数 */
  items: number;
  /** 出现过多期的条目数（= 有 repeat 的） */
  repeated: number;
  /** 语料日期跨度（首日 ~ 尾日） */
  span: string;
}

export function corpusStats(c: TopicCorpus): CorpusStats {
  const dates = Object.keys(c.days).sort();
  const ids = new Set<string>();
  let raw = 0;
  for (const d of dates) {
    for (const it of c.days[d]?.items ?? []) {
      ids.add(it.i);
      raw++;
    }
  }
  const repeated = Object.values(c.firstSeen).length > 0
    ? Object.keys(c.firstSeen).filter((id) => {
        let n = 0;
        for (const d of dates) if ((c.days[d]?.items ?? []).some((x) => x.i === id)) n++;
        return n > 1;
      }).length
    : 0;
  return {
    days: dates.length,
    items: ids.size,
    repeated,
    span: dates.length ? `${dates[0]} ~ ${dates[dates.length - 1]}` : "(空)",
  };
}

/**
 * 把新一天的（或若干天的）slim 数据增量合并进语料（纯函数，不 mutate 入参）。
 *
 * 规则：
 *  - **按日期覆盖同日**：同一日期重新合并时，用新数据替换该日（当天重跑/修正的场景）；
 *  - **按 id 记首见**：`firstSeen` 只记**最早**出现日期，不被后来的覆盖；
 *  - **不裁旧**：没有任何天数门槛 —— 这是与主项目 history/ 的本质区别。
 */
export function mergeCorpus(existing: TopicCorpus, incoming: SlimDay[]): TopicCorpus {
  const out: TopicCorpus = {
    version: 1,
    updatedAt: existing.updatedAt,
    days: { ...existing.days },
    firstSeen: { ...existing.firstSeen },
  };
  for (const day of incoming) {
    if (!day?.date) continue;
    const prev = out.days[day.date];
    // 同日重跑：以新数据为准（条目集合可能因渲染/修正变化）
    out.days[day.date] = day;
    for (const it of day.items ?? []) {
      if (!it.i) continue;
      // 首见日期取更早的（即使同日重跑也不改写历史）
      const seen = out.firstSeen[it.i];
      if (!seen || day.date < seen) out.firstSeen[it.i] = day.date;
    }
    if (!prev || day.date > out.updatedAt) out.updatedAt = day.date;
  }
  return out;
}

/** 语料 → 聚类输入的日期列表（升序；只给有条目的日期）。 */
export function corpusDays(c: TopicCorpus): SlimDay[] {
  return Object.keys(c.days ?? {})
    .sort()
    .map((d) => c.days[d])
    .filter((d): d is SlimDay => Boolean(d && (d.items?.length ?? 0) > 0));
}

/**
 * 条目在语料中的跨期出现次数（repeat）。
 * 与聚类层自己算的 repeat 同口径，但这里是**全语料口径** —— 用于主题卡的「持续 N 期」。
 */
export function repeatCountOf(c: TopicCorpus, itemId: string): number {
  let n = 0;
  for (const d of Object.keys(c.days)) {
    if ((c.days[d]?.items ?? []).some((x) => x.i === itemId)) n++;
  }
  return n;
}

/** 取某条目在全语料中**信息量最大**的一版（同 id 跨期标题可能被 AI 改写）。 */
export function bestVersionOf(c: TopicCorpus, itemId: string): SlimItem | null {
  let best: SlimItem | null = null;
  for (const d of Object.keys(c.days).sort()) {
    for (const it of c.days[d]?.items ?? []) {
      if (it.i !== itemId) continue;
      // 信息量 = 摘要长度 + 重要度加权；取最高者（标题被改写时保留最能说明问题的那版）
      const score = it.x.length + (it.m ?? 1) * 20;
      if (!best || score > (best.x.length + (best.m ?? 1) * 20)) best = it;
    }
  }
  return best;
}
