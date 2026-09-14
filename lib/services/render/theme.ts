/**
 * 渲染主题（M3-C 拆分自 lib/output/render.ts）：
 * 全站 CSS（THEME_CSS，静态无插值）与源等级角标配色（TIER_COLORS）。
 *
 * 2026-09-14 拆分：原 1206 行单模板串按 CSS 段落切分为 6 个子模块
 * （theme-{tokens,base,cards,panels,trading,interactive}.ts），本文件只做**拼接与 re-export**。
 * 拼接顺序即原串顺序 —— 有渲染产物指纹（sha256）测试把关，确保逐字节一致。
 */
import type { SourceTier } from "../../contracts/source";
import { THEME_TOKENS_CSS } from "./theme-tokens";
import { THEME_BASE_CSS } from "./theme-base";
import { THEME_CARDS_CSS } from "./theme-cards";
import { THEME_PANELS_CSS } from "./theme-panels";
import { THEME_TRADING_CSS } from "./theme-trading";
import { THEME_INTERACTIVE_CSS } from "./theme-interactive";

export const TIER_COLORS: Record<SourceTier, string> = {
    T1: "#c0392b",
    "T1.5": "#b9770e",
    T2: "#6b7280",
};

/** 全站样式（renderHtml 的 <style> 内容，静态文本、无插值）—— 由 6 个 CSS 段落拼接而成。 */
export const THEME_CSS =
  `${THEME_TOKENS_CSS}${THEME_BASE_CSS}${THEME_CARDS_CSS}${THEME_PANELS_CSS}${THEME_TRADING_CSS}${THEME_INTERACTIVE_CSS}`;

export {
  THEME_TOKENS_CSS,
  THEME_BASE_CSS,
  THEME_CARDS_CSS,
  THEME_PANELS_CSS,
  THEME_TRADING_CSS,
  THEME_INTERACTIVE_CSS,
};
