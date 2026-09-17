/**
 * 商机成熟度徽章（C2 渲染侧，2026-09-17）。
 *
 * 纯展示：只读契约里的 `MaturityMark`，判定在 `classify/maturity`（确定性词表）。
 * 文案常量直接从那里取，不在渲染层再抄一份 —— 抄一份就会出现「同一个词两处不一致」。
 */
import type { MaturityMark, MaturityStage } from "../../contracts/report";
import { MATURITY_HINT, MATURITY_LABEL, MATURITY_ORDER } from "../classify/maturity";
import { escapeHtml } from "./cards";

/** 阶段进度点（●○○ / ●●○ / ●●●）——一眼看出「走到哪一步」。 */
function trackOf(stage: MaturityStage): string {
  const at = MATURITY_ORDER.indexOf(stage);
  return MATURITY_ORDER.map(
    (_, i) => `<i class="mt-dot${i <= at ? " mt-on" : ""}"></i>`,
  ).join("");
}

/**
 * 阶段徽章；无 maturity 时返回空串（老报告重渲染不显示，保持向后兼容）。
 *
 * tooltip 带**判定依据词**：读者能直接回原文核对「为什么说是推进阶段」，
 * 而不是只能选择相信机器。
 */
export function renderMaturityBadge(m?: MaturityMark): string {
  if (!m) return "";
  const hint =
    MATURITY_HINT[m.stage] + (m.evidence ? `｜判定依据：「${m.evidence}」（可回原文核对）` : "");
  return (
    `<span class="maturity maturity-${m.stage}" title="${escapeHtml(hint)}">` +
    `<span class="mt-track">${trackOf(m.stage)}</span>${escapeHtml(MATURITY_LABEL[m.stage])}</span>`
  );
}

/** 「下一步」行；无 nextStep 时空串。 */
export function renderNextStep(m?: MaturityMark): string {
  if (!m?.nextStep) return "";
  return `<p class="maturity-next"><b>下一步：</b>${escapeHtml(m.nextStep)}</p>`;
}

/**
 * 成熟度样式（拼进既有补丁样式区，不动 THEME_CSS 巨型串）。
 *
 * 配色刻意**不用**警示红/品牌红：成熟度是「进度」不是「风险」，
 * 与风险卡片的红色语义必须拉开距离。
 */
export const MATURITY_CSS = `
  /* C2 商机成熟度 (2026-09-17)：线索 → 推进 → 落地 */
  .maturity { display: inline-flex; align-items: center; gap: 4px; margin-left: 6px;
    padding: 0 6px; border-radius: 8px; font-size: 10px; font-weight: 700;
    line-height: 1.7; vertical-align: middle; white-space: nowrap; cursor: help; }
  .maturity-clue { color: #5b6472; background: #eceef1; }
  .maturity-progress { color: #1d4ed8; background: #e4ecfd; }
  .maturity-landed { color: #fff; background: #1e7e34; }
  .mt-track { display: inline-flex; gap: 2px; }
  .mt-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: .28; }
  .mt-dot.mt-on { opacity: 1; }
  .maturity-next { margin: .35rem 0 0; font-size: .82rem; color: var(--fg, #1a1a1f); }
  .maturity-next b { color: var(--muted, #797986); font-weight: 600; }
`;
