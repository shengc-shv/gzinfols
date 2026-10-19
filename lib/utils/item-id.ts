/**
 * 条目 ID（A2 地基，2026-09-16）——**全链路唯一来源**。
 *
 * 为什么需要稳定的条目 ID：B1 检索落点 / A3 增量标注 / B2 主题时间线 / C1 客群视图 /
 * E2 导出 / A4 口播跳段，全部需要「同一条资讯**跨期可比、可寻址**」。此前只有渲染期
 * 派生的锚点（`render/atoms`），组装期不可见，二期全部要返工。
 *
 * 生成口径：**由 url 确定性派生**（djb2 → base36）
 *   - 同一 url 在任何一期、任何机器上得到同一 id → 跨期稳定（B2 时间线的前提）；
 *   - 纯函数、零依赖、不读时钟，服务层可安全调用；
 *   - 不用 node:crypto（服务层禁 node:，且无需加密强度）。
 *
 * ⚠️ 放在 utils 而非 render：`assemble` 不得依赖 `render`（架构红线），而 ID 必须在
 * 组装期写入契约。渲染侧（`render/atoms`）反过来复用本函数，保证锚点与 ID 同源。
 */

/** 条目 ID 本体（`itm-<base36>`）。url 为空时返回 `itm-0`（不编造、不抛错）。 */
export function itemIdOf(url: string | undefined): string {
  if (!url) return "itm-0";
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) | 0;
  return `itm-${(h >>> 0).toString(36)}`;
}

/**
 * 卡片 DOM 锚点 id。
 * 与 `itemIdOf` 同值（历史上锚点即由此派生），保留独立命名以表达「DOM 锚点」语义；
 * 两者**必须同源**，否则摘要区「见正文」跳转与详情页链接会指向不同目标。
 */
export const itemAnchorId = itemIdOf;

/**
 * **无原文 url 的摘要卡**锚点 id（必读 / 商机 / 风险）。
 *
 * 为什么不能直接用 `itemIdOf("")`：那会返回固定的 `itm-0` —— 多张「无来源」的摘要卡
 * 会撞成同一个 id，既互相覆盖锚点，又会在主题侧被误认成同一条而合并（2026-10-19 实测：
 * 一条「跨境融资商机」就是这么变成 `itm-0` 的，页面里根本没有该锚点）。
 *
 * 口径：`kind` 区分卡片类型（insight/must/risk），`text` 用卡片自身文案（商机用 topic）——
 * 纯函数、不读时钟，同一张卡跨构建稳定。⚠️ **渲染层与 slim 层必须同源**（都调本函数），
 * 否则主题节点会指向一个页面上不存在的 id。
 */
export function summaryAnchorId(kind: "insight" | "must" | "risk", text: string): string {
  return itemIdOf(`${kind}:${text ?? ""}`);
}
