/**
 * 增量三态徽章（A3 渲染侧，2026-09-17）。
 *
 * 纯展示：只读契约里的 `DeltaMark`，不做任何判定（判定在 `assemble/delta.ts`，
 * 那里复用事件记忆的判重链）。渲染层因此不反向依赖 memory 服务。
 */
import type { DeltaMark } from "../../contracts/report";
import { escapeHtml } from "./cards";

/** 三态 → 短文案。 */
export const DELTA_LABEL: Record<DeltaMark["state"], string> = {
  new: "新增",
  changed: "有进展",
  followup: "续报",
};

/** 三态的完整展示文案（续报带期号）。 */
export function deltaLabelOf(delta: DeltaMark): string {
  if (delta.state === "followup" && delta.issueNo && delta.issueNo > 1) {
    return `续报·第${delta.issueNo}期`;
  }
  return DELTA_LABEL[delta.state];
}

/** 悬浮说明：让读者知道这个徽章是**怎么来的**（可解释，不是随机标）。 */
export function deltaTitleOf(delta: DeltaMark): string {
  if (delta.state === "new") return "本期首次出现（此前 30 天记忆库中没有同类事件）";
  if (delta.state === "changed") {
    const extra = delta.highlights?.length ? `：${delta.highlights.join("、")}` : "";
    return `此前播报过，本期出现新进展${extra}`;
  }
  return delta.issueNo && delta.issueNo > 1
    ? `此前已播报 ${delta.issueNo - 1} 次，本期继续跟进（未发现实质新进展）`
    : "本期已提及过（同一次生成内重复）";
}

/** 徽章 HTML；无 delta 时返回空串（老报告重渲染不显示）。 */
export function renderDeltaBadge(delta?: DeltaMark): string {
  if (!delta) return "";
  return (
    `<span class="delta-badge delta-${delta.state}" title="${escapeHtml(deltaTitleOf(delta))}">` +
    `${escapeHtml(deltaLabelOf(delta))}</span>`
  );
}
