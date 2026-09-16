/**
 * CSS 产物处理（纯函数）。
 *
 * 独立成模块的原因（2026-09-16 A2）：`stripCssComments` 同时被 `full.ts`（报告页）与
 * `detail.ts`（站内详情页）需要；若留在 full.ts 会形成
 * `full → report-item → detail → full` 的循环依赖。抽出后依赖方向单向。
 */

/**
 * 剥离 CSS 块注释。
 *
 * 为什么必须做：`THEME_CSS` / `AUDIO_HIGHLIGHT_CSS` 是模板字符串，其中的注释会
 * **原样进入渲染产物**，而产物是公开页面（源码注释是给维护者看的，不该发上去）。
 */
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}
