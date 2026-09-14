/**
 * 渲染原子：卡片级别的小工具（tag 色系 / 市场徽章 / 摘要截断 / 相对日）。
 *
 * 2026-09-14（C-1 Phase1）：自 `full.ts` **纯搬移**（行为零变化），
 * 供 `report-item.ts` / `ipo-panel.ts` / `full.ts` 共用，避免渲染层内互相 import 形成环。
 */
import { escapeHtml } from "./cards";
import { todayKey } from "../../utils/time";

/** 商机 tag 色系（与 sections.ts 保持一致） */
export function tagClsOf(tag: string): string {
  if (/财富|私行/.test(tag)) return "t-wealth";
  if (/代发|客群/.test(tag)) return "t-mass";
  if (/政银|住房|监管|政策/.test(tag)) return "t-policy";
  if (tag === "粤") return "t-gd";
  return "";
}

/** 股市动态面板：卡片市场徽标（A股/港股/美股）。 */
export const MARKET_BADGE: Record<string, { label: string; cls: string }> = {
  "a-share": { label: "A股", cls: "mkt-a" },
  hk: { label: "港股", cls: "mkt-hk" },
  us: { label: "美股", cls: "mkt-us" },
};


/** P2⑤ 板块卡「所以呢」摘要上限 50 字（首句即结论/落点，截断优先保留首句完整）。
 * 仅作用于板块卡（gz_local/biz/policy/tech/ipo），必读/商机/风险走其他渲染路径，不受影响。 */
export function capSummary(s: string, max = 50): string {
  const t = (s || "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastPunct = Math.max(
    cut.lastIndexOf("。"),
    cut.lastIndexOf("！"),
    cut.lastIndexOf("？"),
    cut.lastIndexOf("；"),
  );
  return (lastPunct > 4 ? cut.slice(0, lastPunct + 1) : cut) + "…";
}

/**
 * MM/DD → 「今天 / 昨天 / N 天前」（报告时区；P2 呈现）。
 *
 * 动机：卡片只印 `09/03`，读者容易把 7 天窗里的旧条目读成「今日动态」。
 * 跨年边界按「今年 → 去年」两次尝试（MM/DD 无年份）；>30 天或无法解析返回空串。
 */
export function relativeDayLabel(mmdd: string, today: string = todayKey()): string {
  const m = /^(\d{2})\/(\d{2})$/.exec(mmdd || "");
  if (!m) return "";
  const [ty, tm, td] = today.split("-").map(Number);
  if (!ty || !tm || !td) return "";
  const base = Date.UTC(ty, tm - 1, td);
  for (const y of [ty, ty - 1]) {
    const gap = Math.round((base - Date.UTC(y, Number(m[1]) - 1, Number(m[2]))) / 86400000);
    if (gap >= 0 && gap <= 30) return gap === 0 ? "今天" : gap === 1 ? "昨天" : `${gap} 天前`;
  }
  return "";
}
