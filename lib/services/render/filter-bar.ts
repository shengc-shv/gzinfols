/**
 * 筛选条（chips）渲染：通用板块 / 股市 / 广东IPO 三种形态。
 *
 * 2026-09-14（C-1 Phase1）：自 `full.ts` **纯搬移**（行为零变化）。
 */
import { escapeHtml } from "./cards";
import { DEPT_TAGS } from "./report-item";
import { mapTagsToSegments, PRIORITY_SEGMENTS, OTHER_SEGMENT } from "../classify/customer-segment";
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
    // C1（2026-09-17）修正：原实现只取**第一个**命中的部门标签（`tags.find`），
    // 于是 `["信贷","客群"]` 这样的多归属条目只贡献「信贷」—— 业务线筛选条缺项，
    // 角色视图（私行部/零售银行部…）就会点到不存在的 chip。
    // 现收集**全部**命中标签：与 applyFilter 的「维度内 OR（命中其一即满足）」语义一致。
    let deptHit = false;
    for (const t of tags) {
      if (DEPT_TAGS.has(t)) {
        presentDepts.add(t);
        deptHit = true;
      }
    }
    if (!deptHit) hasOther = true;
  }
  const groups: FilterGroupDef[] = [{ title: "来源", chips: srcChips }];
  const tagChips: FilterChipDef[] = [];
  // 固定展示顺序：客群 / 私行 / 财富 / 信贷，仅保留有数据的
  for (const d of ["客群", "私行", "财富", "信贷"]) {
    if (presentDepts.has(d)) tagChips.push({ label: d, value: d, group: "tag" });
  }
  if (hasOther) tagChips.push({ label: "其他", value: "__none__", group: "tag" });
  if (tagChips.length > 0) groups.push({ title: "业务线", chips: tagChips });

  // C1（2026-09-17）：客群升为**一等筛选轴**（与来源/业务线并列）。
  // 只渲染本面板实际有数据的客群段位；段位判定与卡片 data-segs 同源（mapTagsToSegments）。
  const presentSegs = new Set<string>();
  for (const it of items) {
    for (const s of mapTagsToSegments(it.tags, it.title_cn || it.title_orig || "")) presentSegs.add(s);
  }
  const segChips: FilterChipDef[] = [];
  for (const s of PRIORITY_SEGMENTS) {
    if (presentSegs.has(s)) segChips.push({ label: SEG_FILTER_LABEL[s] ?? s, value: s, group: "seg" });
  }
  if (presentSegs.has(OTHER_SEGMENT)) {
    segChips.push({ label: "其他客群", value: OTHER_SEGMENT, group: "seg" });
  }
  // 客群轴只在「确实有多个段位可区分」时出现（单一段位没有筛选价值，徒增噪声）
  if (segChips.length > 1) groups.push({ title: "客群", chips: segChips });

  return renderFilterBar(groups);
}

/** 客群段位 → 筛选 chip 短文案（与商机洞察卡片上的 seg-chip 同口径）。 */
export const SEG_FILTER_LABEL: Record<string, string> = {
  "零售AUM": "零售AUM",
  "中高端客群(过亿资产)": "高端客户",
  "普惠小微贷款客户": "普惠小微",
  [OTHER_SEGMENT]: "其他",
};

/**
 * 「角色视图」预设（C1，2026-09-17）。
 *
 * 让 AI 打标的**业务线归属**直接变成「谁该看什么」：读者按自己所在条线一键切换，
 * 不必手工勾选筛选条。`tags` 对应卡片 `data-tags` 的业务线维度（与筛选条同一套匹配）。
 */
export const ROLE_VIEWS: Array<{ id: string; label: string; tags: string[] }> = [
  { id: "exec", label: "行长", tags: [] },
  { id: "biz", label: "零售银行部", tags: ["客群"] },
  { id: "private", label: "私行部", tags: ["私行"] },
  { id: "wealth", label: "财富管理部", tags: ["财富"] },
  { id: "credit", label: "零售信贷部", tags: ["信贷"] },
];

/** 渲染角色视图条（数据内联成 JSON 供脚本消费，避免两处维护预设）。 */
export function renderRoleBar(): string {
  const chips = ROLE_VIEWS.map(
    (r) =>
      `<button type="button" class="role-chip" data-role="${escapeHtml(r.id)}">${escapeHtml(r.label)}</button>`,
  ).join("");
  const data = JSON.stringify(ROLE_VIEWS).replace(/</g, "\\u003c");
  return `<div class="role-bar" id="role-bar">
  <span class="role-label">角色视图</span>
  ${chips}
  <span class="role-hint" id="role-hint">按条线一键筛选（再点一次取消）</span>
  <script type="application/json" id="role-views">${data}</script>
</div>`;
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
