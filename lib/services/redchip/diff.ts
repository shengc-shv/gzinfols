/**
 * 红筹快照比对（纯函数）—— 产出「新增 / 移除 / 字段变更」三类可追溯变更。
 */
import type { RedchipChange, RedchipProject, RedchipSnapshot } from "../../contracts/redchip";

/** 参与比对的字段（变更即记一条）。 */
const WATCHED_FIELDS: Array<{ key: keyof RedchipProject; label: string }> = [
  { key: "status", label: "状态" },
  { key: "domicile", label: "注册地" },
  { key: "isOffshore", label: "境外注册" },
  { key: "gdCityHits", label: "广东词频" },
  { key: "isGdConnected", label: "广东连接" },
  { key: "vie", label: "VIE" },
  { key: "verdict", label: "判定结果" },
];

function str(v: unknown): string | undefined {
  return v === undefined || v === null ? undefined : String(v);
}

/**
 * 比对两份快照。新增项目沿用其 discoveredAt 作为发现时间；
 * 移除/变更的时间取当前快照的 capturedAt。
 */
export function diffSnapshots(
  prev: RedchipSnapshot | null,
  curr: RedchipSnapshot,
): RedchipChange[] {
  const changes: RedchipChange[] = [];
  if (!prev) {
    for (const p of curr.projects) {
      changes.push({
        at: p.discoveredAt || curr.capturedAt,
        type: "added",
        appId: p.appId,
        nameCn: p.nameCn,
        sourceUrl: p.sourceUrl,
      });
    }
    return changes;
  }

  const prevMap = new Map(prev.projects.map((p) => [p.appId, p]));
  const currMap = new Map(curr.projects.map((p) => [p.appId, p]));

  for (const p of curr.projects) {
    const old = prevMap.get(p.appId);
    if (!old) {
      changes.push({
        at: p.discoveredAt || curr.capturedAt,
        type: "added",
        appId: p.appId,
        nameCn: p.nameCn,
        sourceUrl: p.sourceUrl,
      });
      continue;
    }
    for (const f of WATCHED_FIELDS) {
      const a = str(old[f.key]);
      const b = str(p[f.key]);
      if (a !== b) {
        changes.push({
          at: curr.capturedAt,
          type: "changed",
          appId: p.appId,
          nameCn: p.nameCn,
          field: f.label,
          from: a,
          to: b,
          sourceUrl: p.sourceUrl,
        });
      }
    }
  }

  for (const p of prev.projects) {
    if (!currMap.has(p.appId)) {
      changes.push({
        at: curr.capturedAt,
        type: "removed",
        appId: p.appId,
        nameCn: p.nameCn,
        sourceUrl: p.sourceUrl,
      });
    }
  }
  return changes;
}

/** 变更日志行序列化（JSONL，append-only）。 */
export function serializeChange(c: RedchipChange): string {
  return JSON.stringify(c);
}
