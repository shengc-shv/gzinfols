/**
 * 红筹线索归并（纯函数，零 IO）—— `RedchipProject[]` + changelog → `RedchipLead[]`。
 *
 * 与 IO 分离的原因：归并规则（时间线 / 报告引用）要能单测；写盘只在
 * `adapters/redchip/snapshot-store` 一处。
 */
import type {
  RedchipChange,
  RedchipLead,
  RedchipProject,
  RedchipReportRef,
} from "../../contracts/redchip";
import { redchipLabelOf } from "../classify/redchip";

/** 每个 appId 的最近变更时刻（取 changelog 内最大 `at`）。 */
export function lastChangedAtMap(changes: RedchipChange[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of changes) {
    if (!c?.appId || !c.at) continue;
    const prev = out.get(c.appId);
    if (!prev || c.at > prev) out.set(c.appId, c.at);
  }
  return out;
}

/** 每个 appId 的变更历史（按时间正序，供报告页时间线）。 */
export function changesByLead(changes: RedchipChange[]): Map<string, RedchipChange[]> {
  const out = new Map<string, RedchipChange[]>();
  for (const c of changes) {
    if (!c?.appId) continue;
    const arr = out.get(c.appId) ?? [];
    arr.push(c);
    out.set(c.appId, arr);
  }
  for (const arr of out.values()) arr.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return out;
}

/**
 * 快照项目 → 线索（补 `leadId` / `lastChangedAt` / 报告引用）。
 *
 * 判定字段**原样透传**（不再复制计算），避免与 `classifyProject` 两套口径漂移。
 *
 * 🔴 **schema 归一（2026-10-03）**：`market` 一律写出（缺省 `hk`，与契约「缺省视为 hk」同口径）。
 * 此前它只在美股源写入 → `leads.json` 里实测存在**三套字段集**（38 条无 `market`、
 * 12 条有 `gdCityMentions`、2 条两者都有）。归一"可确定的"字段，才谈得上「单 schema」。
 * ⚠️ `domicile` / `gdCityMentions` 保持可选：它们对早期回填条目**本就未知** ——
 * 未知 ≠ 缺失，不得为了「字段齐整」编造默认值（时间/证据红线同源）。
 */
export function toLeads(
  projects: RedchipProject[],
  changes: RedchipChange[] = [],
  reports?: Map<string, RedchipReportRef[]>,
): RedchipLead[] {
  const changedAt = lastChangedAtMap(changes);
  return projects.map((p) => {
    const leadId = p.appId;
    const lastChangedAt = changedAt.get(leadId);
    const refs = reports?.get(leadId);
    return {
      ...p,
      leadId,
      market: p.market ?? "hk",
      ...(lastChangedAt ? { lastChangedAt } : {}),
      ...(refs && refs.length ? { reports: refs } : {}),
    };
  });
}

/** 条目「新旧」判据：最近变更时刻优先，其次发现时刻（都缺则该条视为最旧）。 */
function recencyOf(l: RedchipLead): string {
  return l.lastChangedAt ?? l.discoveredAt ?? "";
}

/** 逐条合并两份**同一 appId** 的线索：新者覆盖、旧者补空、发现时间取最早。 */
function mergeLeadPair(a: RedchipLead, b: RedchipLead): RedchipLead {
  const [newer, older] = recencyOf(a) >= recencyOf(b) ? [a, b] : [b, a];
  const out: Record<string, unknown> = { ...older, ...newer };
  // 补空：新者缺（undefined/""）的字段用旧者填 —— 防「后写的脚本字段更少」把信息抹掉。
  for (const [k, v] of Object.entries(older)) {
    if (v === undefined || v === null || v === "") continue;
    const cur = out[k];
    if (cur === undefined || cur === null || cur === "") out[k] = v;
  }
  // 发现时间是**台账属性**，不该因为每天重抓而刷新 → 取两者最早。
  const times = [a.discoveredAt, b.discoveredAt].filter((t): t is string => Boolean(t)).sort();
  if (times.length) out.discoveredAt = times[0];
  out.leadId = newer.leadId || newer.appId;
  out.market = out.market ?? "hk";
  return out as unknown as RedchipLead;
}

/**
 * 台账**并集合并**（纯函数，零 IO）—— 多份 `leads.json` 按 `appId` 逐条合。
 *
 * 为什么需要：台账有**两个写入者**（线下爬虫 / CI 归档），且 CI 归档原先用
 * `git merge -X ours` 做**整文件级**冲突处理 —— 冲突时保住 CI 侧，会把爬虫刚提交的
 * 新数据整份覆盖（实测 10-03 06:34 爬虫提交、06:38 CI 归档仅差 4 分钟）。
 * 逐条合并把「冲突」下沉到条目粒度：**每个 appId 各自取新者并互补字段**，
 * 两边的新增都不会丢。与 `mergeProjects` 的区别：后者是「prev + next 覆盖」的单向语义，
 * 这里是**任意多份来源的并集**。
 *
 * 排序与 `mergeProjects` 一致（递表日倒序、再按 appId）→ git diff 稳定，便于人工核对。
 */
export function mergeLeadSets(sets: RedchipLead[][]): RedchipLead[] {
  const byId = new Map<string, RedchipLead>();
  for (const set of sets) {
    for (const l of set ?? []) {
      const id = l?.leadId || l?.appId;
      if (!id) continue;
      // 归一 `market`（与 `toLeads` 同口径）→ 单份输入时本函数也起「统一 schema」的作用。
      const normalized: RedchipLead = { ...l, leadId: id, market: l.market ?? "hk" };
      const prev = byId.get(id);
      byId.set(id, prev ? mergeLeadPair(prev, normalized) : normalized);
    }
  }
  return [...byId.values()].sort(
    (a, b) =>
      (b.submitDate ?? "").localeCompare(a.submitDate ?? "") ||
      a.appId.localeCompare(b.appId),
  );
}

/**
 * 台账「最近一次有记录的时刻」= `max(lastChangedAt, discoveredAt)`（北京时间 ISO）。
 *
 * 为什么需要它：报告要呈现的「数据截至」原本只来自 `latest.json` / `meta.json`，
 * 而这两个文件在 CI 侧可能不存在（`latest.json` 被 `.gitignore` 拦、`meta.json` 取决于
 * 爬虫是否写过）。`leads.json` 是**入库文件**且两个字段都在里面 —— 于是它成了
 * 「即使什么都拿不到，也还能说清数据到哪天」的最后一道兜底。
 *
 * ⚠️ 语义边界（呈现层必须区分）：这是**台账记录时刻**，不等于「那一刻跑过抓取」。
 * 时间红线：两个字段都是真实事件时刻（变更/发现），不是抓取日兜底 → 可用于对外措辞。
 */
export function latestLeadAt(leads: RedchipLead[]): string | undefined {
  let max: string | undefined;
  for (const l of leads) {
    for (const t of [l?.lastChangedAt, l?.discoveredAt]) {
      if (typeof t === "string" && t && (!max || t > max)) max = t;
    }
  }
  return max;
}

/**
 * 在册线索按来源市场分布（默认 `hk`，与契约「缺省视为 hk」同口径）。
 *
 * 只统计**可展示**的线索（`redchipLabelOf` 非空），与 `ledgerCount` 同口径 ——
 * 否则「在册 38 家」旁边会冒出「港股 52 家」，两个数字对不上。
 */
export function ledgerMarketCounts(leads: RedchipLead[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of leads) {
    if (!redchipLabelOf(l)) continue;
    const k = l.market ?? "hk";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
