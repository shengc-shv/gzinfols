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
      ...(lastChangedAt ? { lastChangedAt } : {}),
      ...(refs && refs.length ? { reports: refs } : {}),
    };
  });
}
