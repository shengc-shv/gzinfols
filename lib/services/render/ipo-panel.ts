/**
 * 广东 IPO 面板：阶段筛选条 / 进展条 / 分阶段分组渲染。
 *
 * 2026-09-14（C-1 Phase1）：自 `full.ts` **纯搬移**（行为零变化）。
 */
import { GD_IPO_STAGE_LABEL, IPO_STAGE_ORDER, type GdStage } from "../classify/gd-ipo";
import { gdIpoStageOf, companyNameOf } from "../classify/gd-ipo-spoken";
import { escapeHtml } from "./cards";
import {
  renderFilterBar,
  type FilterChipDef,
  type FilterGroupDef,
} from "./filter-bar";
import { renderReportItemHtml } from "./report-item";
import type { ReportItem } from "../../contracts/report";

/** 阶段组标题（「阶段待定」= 无阶段信号的条目，有数据才渲染）。 */
export function ipoStageGroupLabel(s: GdStage | ""): string {
  return s === "" ? "阶段待定" : GD_IPO_STAGE_LABEL[s] || "IPO";
}

/**
 * 广东IPO 面板筛选条（2026-09-10 用户）——**复用同级板块既有过滤机制**
 * （`renderFilterBar` + 卡片 `data-*` 属性 + 客户端 `applyFilter`）：
 *   - 维度「来源」：官方 / 媒体（与业务板块完全一致）；
 *   - 维度「阶段」：四阶段 + 阶段待定，**只渲染当前面板实际有数据的阶段**；
 *   - 维度内 OR、维度间 AND；全不选/全选 = 全部显示（既有语义）。
 */
export function renderIpoFilterBar(items: ReportItem[]): string {
  const groups: FilterGroupDef[] = [
    {
      title: "来源",
      chips: [
        { label: "官方", value: "official", group: "src" },
        { label: "媒体", value: "media", group: "src" },
      ],
    },
  ];
  const present = new Set<string>(items.map((it) => gdIpoStageOf(it)));
  const stageChips: FilterChipDef[] = IPO_STAGE_ORDER.filter((s) => present.has(s)).map((s) => ({
    label: GD_IPO_STAGE_LABEL[s],
    value: s,
    group: "stage",
  }));
  if (present.has("")) stageChips.push({ label: "阶段待定", value: "__none__", group: "stage" });
  if (stageChips.length > 0) groups.push({ title: "阶段", chips: stageChips });
  return renderFilterBar(groups);
}

/**
 * 广东IPO 面板正文：**四阶段分栏**（2026-09-10 用户决策③落地）。
 *
 * - 组顺序 = `IPO_STAGE_ORDER`（商机价值优先，与横滑同序）；
 * - 空阶段整组不渲染（不出现「辅导备案 0 家」这类空标题）；
 * - 组内卡片由 `renderReportItemHtml(it, true, stage)` 渲染，带 `data-stage` 供筛选条过滤；
 * - 组头带阶段色点 + 家数，便于「哪家在哪个阶段」一眼可读。
 */
/**
 * 同企业阶段进展链（P2-6，2026-09-10 回检收尾）。
 *
 * 底部列表用 `uniqueCompany:false` 刻意保留了同企业的多阶段条目（「已问询」与
 * 「注册生效」各占一条 URL），但此前只是各渲染一张卡，读者看不出这是**同一家的推进过程**。
 * 此处把同企业条目按日期升序连成「09/03 在审 → 09/07 注册发行」，只在**该企业最新一条**
 * 卡上渲染（避免每张卡重复整条链）；同阶段多次更新合并为一步（保留最新日期）。
 *
 * 少于 2 个不同阶段 → 返回空串（单阶段企业不显示进展条）。
 */
export function renderIpoProgress(item: ReportItem, all: ReportItem[]): string {
  const company = companyNameOf(item.title_cn || "");
  if (!company) return "";
  const chain = all
    .filter((it) => companyNameOf(it.title_cn || "") === company)
    .map((it) => ({ date: it.date, stage: gdIpoStageOf(it) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const steps: Array<{ date: string; stage: GdStage | "" }> = [];
  for (const c of chain) {
    const last = steps[steps.length - 1];
    if (last && last.stage === c.stage) {
      last.date = c.date; // 同阶段多次更新 → 合并为一步，保留最新日期
      continue;
    }
    steps.push({ ...c });
  }
  if (steps.length < 2) return "";
  const latest = steps[steps.length - 1];
  // 仅最新一条卡承载进展条（stage+date 双匹配，避免同日多条重复渲染）
  if (item.date !== latest.date || gdIpoStageOf(item) !== latest.stage) return "";
  const body = steps
    .map((s, i) => {
      const label = s.stage === "" ? "阶段待定" : GD_IPO_STAGE_LABEL[s.stage] || "IPO";
      const cls =
        i === steps.length - 1 ? "ipo-progress-step ipo-progress-step--cur" : "ipo-progress-step";
      const d = s.date ? `${escapeHtml(s.date)} ` : "";
      return `<span class="${cls}">${d}${escapeHtml(label)}</span>`;
    })
    .join('<span class="ipo-progress-arrow">→</span>');
  return `<div class="ipo-progress"><span class="ipo-progress-label">进展</span>${body}</div>`;
}

export function renderIpoPanelHtml(items: ReportItem[]): string {
  const byStage = new Map<string, ReportItem[]>();
  for (const it of items) {
    const s = gdIpoStageOf(it);
    const arr = byStage.get(s);
    if (arr) arr.push(it);
    else byStage.set(s, [it]);
  }
  const order: Array<GdStage | ""> = [...IPO_STAGE_ORDER, ""];
  return order
    .filter((s) => (byStage.get(s)?.length ?? 0) > 0)
    .map((s) => {
      const list = byStage.get(s)!;
      return `<section class="ipo-group" data-stage="${s}">
    <h4 class="ipo-group-head"><span class="ipo-group-dot ipo-stage--${s || "none"}"></span>${escapeHtml(
      ipoStageGroupLabel(s),
    )}<span class="ipo-group-n">${list.length}</span></h4>
    ${list.map((it) => renderReportItemHtml(it, true, s, renderIpoProgress(it, items))).join("\n")}
  </section>`;
    })
    .join("\n");
}
