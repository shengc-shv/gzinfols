/**
 * 筛选条（chips）渲染：通用板块 / 股市 / 广东IPO 三种形态。
 *
 * 2026-09-14（C-1 Phase1）：自 `full.ts` **纯搬移**（行为零变化）。
 */
import { escapeHtml } from "./cards";
import { DEPT_TAGS } from "./report-item";
import type { ReportItem } from "../../contracts/report";

export interface FilterChipDef {
  /** 展示文案 */
  label: string;
  /** 与卡片 data-source / data-tags 对应的匹配值 */
  value: string;
  /** 维度分组键（同组 OR，不同组 AND） */
  group: string;
}
export interface FilterGroupDef {
  /** 维度标题（仅在 UI 展示，如「来源」「业务线」） */
  title: string;
  chips: FilterChipDef[];
}

/**
 * 默认筛选维度（业务资讯板块统一复用，2026-08-22 用户规则）：
 * - 第一维度「来源」：官方 / 媒体 —— 组内 OR；
 * - 第二维度「业务线」：客群 / 私行 / 财富 / 信贷 —— 组内 OR；
 * - 两维度之间取交集（AND）；无任何选中或全选 → 全部显示。
 */
export const DEFAULT_FILTER_GROUPS: FilterGroupDef[] = [
  {
    title: "来源",
    chips: [
      { label: "官方", value: "official", group: "src" },
      { label: "媒体", value: "media", group: "src" },
    ],
  },
  {
    title: "业务线",
    chips: [
      { label: "客群", value: "客群", group: "tag" },
      { label: "私行", value: "私行", group: "tag" },
      { label: "财富", value: "财富", group: "tag" },
      { label: "信贷", value: "信贷", group: "tag" },
      // 「其他」= 未命中 4 部门零售标签的条目（2026-08-22 用户：无标签信息放队列
      // 最后，想看才通过此选项查看）。
      { label: "其他", value: "__none__", group: "tag" },
    ],
  },
];

/**
 * 渲染板块内筛选条（可复用组件：传入自定义 groups 即可用于其它板块）。
 * 默认渲染 DEFAULT_FILTER_GROUPS；维度内 OR、维度间 AND；全空 / 全选 → 全部显示。
 */
export function renderFilterBar(groups: FilterGroupDef[] = DEFAULT_FILTER_GROUPS): string {
  const groupsHtml = groups
    .map((g) => {
      const chips = g.chips
        .map(
          (c) =>
            `<button type="button" class="filter-chip" data-group="${c.group}" data-filter="${escapeHtml(c.value)}">${escapeHtml(c.label)}</button>`,
        )
        .join("");
      return `<div class="filter-group">
        <span class="filter-gtitle">${escapeHtml(g.title)}</span>
        ${chips}
      </div>`;
    })
    .join("");
  return `<div class="filter-bar">
    <span class="filter-label">筛选</span>
    ${groupsHtml}
    <button type="button" class="filter-reset">重置</button>
  </div>`;
}

/**
 * 面板级筛选条（2026-08-23 用户）：来源维度（官方/媒体）固定保留；
 * 业务线维度**动态**——只渲染当前面板实际存在数据的部门标签
 * （客群/私行/财富/信贷 无数据则不出现），有非部门标签或无标签卡片才追加「其他」；
 * 全无业务线数据时整个业务线维度不渲染。
 */
export function renderFilterBarForPanel(items: ReportItem[]): string {
  const srcChips: FilterChipDef[] = [
    { label: "官方", value: "official", group: "src" },
    { label: "媒体", value: "media", group: "src" },
  ];
  const presentDepts = new Set<string>();
  let hasOther = false;
  for (const it of items) {
    const tags = it.tags ?? [];
    const deptHit = tags.find((t) => DEPT_TAGS.has(t));
    if (deptHit) presentDepts.add(deptHit);
    else hasOther = true;
  }
  const groups: FilterGroupDef[] = [{ title: "来源", chips: srcChips }];
  const tagChips: FilterChipDef[] = [];
  // 固定展示顺序：客群 / 私行 / 财富 / 信贷，仅保留有数据的
  for (const d of ["客群", "私行", "财富", "信贷"]) {
    if (presentDepts.has(d)) tagChips.push({ label: d, value: d, group: "tag" });
  }
  if (hasOther) tagChips.push({ label: "其他", value: "__none__", group: "tag" });
  if (tagChips.length > 0) groups.push({ title: "业务线", chips: tagChips });
  return renderFilterBar(groups);
}

/**
 * 股市动态面板筛选条（2026-08-25 用户）：单一「市场」维度，按 A股 / 港股 / 美股 过滤。
 * 维度内 OR（选中多个市场取并集）；全选或全不选 → 全部显示（复用 renderFilterBar 交互）。
 */
export function renderStockFilterBar(): string {
  const chips = [
    { label: "A股", value: "a-share" },
    { label: "港股", value: "hk" },
    { label: "美股", value: "us" },
  ]
    .map(
      (c) =>
        `<button type="button" class="filter-chip" data-group="market" data-filter="${c.value}">${c.label}</button>`,
    )
    .join("");
  return `<div class="filter-bar">
    <span class="filter-label">市场</span>
    ${chips}
    <button type="button" class="filter-reset">重置</button>
  </div>`;
}
