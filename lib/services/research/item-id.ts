/**
 * 研报条目 ID（2026-10-21 sc：研报要有站内详情页）。
 *
 * 为什么不用 `itemIdOf(url)` 的 djb2：研报的 url 里带着**源站自带的主键**
 * （东财 infoCode / 新浪 rptid），直接用它可读、可排查（页面路径 `r/<id>.html`
 * 一眼能看出是哪篇），且比散列更稳——改 url 参数顺序不会换 id。
 *
 * 口径：`rs-<主键>`；两个源都取不到主键时回退 djb2（仍保持确定性）。
 * 纯函数、零依赖、不读时钟 → 服务层可安全调用（与 item-id.ts 同规矩）。
 */

/** 从 url 提取源站主键：东财 infocode / 新浪 rptid。 */
export function researchKeyOf(url: string | undefined): string {
  const u = url || "";
  const info = /[?&]infocode=([A-Za-z0-9]+)/.exec(u);
  if (info) return info[1];
  const rpt = /[?&]rptid=(\d+)/.exec(u);
  if (rpt) return rpt[1];
  // 新浪另一种形态：.../vReport_Show/kind/macro/rptid/<id>/index.phtml
  const path = /\/(?:rptid|reportid)\/(\d+)/.exec(u);
  if (path) return path[1];
  return "";
}

/** 研报条目 ID（`rs-<主键>`；无主键回退 djb2，仍确定性）。 */
export function researchItemId(url: string | undefined): string {
  const key = researchKeyOf(url);
  if (key) return `rs-${key}`;
  // 回退：与主项目同一散列，保证无主键时也跨构建稳定
  let h = 5381;
  const s = url || "";
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `rs-${(h >>> 0).toString(36)}`;
}
