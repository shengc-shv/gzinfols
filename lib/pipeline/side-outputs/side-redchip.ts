/**
 * 红筹旁路（side-output，plan-redchip-crawl-push §2.2 / §5.1 / Trigger T2·T4·T5·T6·T7）。
 *
 * 职责：把 `leads.json` 里的红筹线索**按实体匹配**挂到 IPO 板块的条目上（T2），
 * 并产出面板块数据（`report.redchipPanel`）。匹配失败者不打标（T7，无状态源红线），
 * 但仍进面板可见，避免线索静默消失。
 *
 * 分层：纯函数 `buildRedchip`（可单测）+ IO 包装 `buildRedchipFromStore`（读磁盘）。
 */

import type { DailyReport } from "../../contracts/report";
import type { PipelineContext } from "../../contracts/pipeline";
import type {
  RedchipChange,
  RedchipLead,
  RedchipPanel,
  RedchipPanelEntry,
  RedchipReportRef,
} from "../../contracts/redchip";
import { REDCHIP_LABELS } from "../../contracts/redchip";
import {
  inRedchipListWindow,
  matchRedchipLead,
  redchipBadgeOf,
  redchipLabelOf,
} from "../../services/classify/redchip";
import { readChanges, readLatest, readLeads } from "../../adapters/redchip/snapshot-store";
import { resolveReports } from "../../adapters/redchip/report-resolver";

export interface RedchipInputs {
  leads: RedchipLead[];
  changes: RedchipChange[];
  /** 已探测到的实体报告（deep/manual/r）；无则回落到确定性会前版路径。 */
  reports: Map<string, RedchipReportRef[]>;
  /** 报告日（北京时间 YYYY-MM-DD），窗口基准。 */
  today: string;
  /** 快照抓取时刻（面板页脚）。 */
  capturedAt?: string;
}

/**
 * 选定报告入口（T6：`manual` > `deep` > 会前版本）。
 *
 * 会前版本**不依赖探测**：其路径是确定性的（`redchip/r/<leadId>.html`），
 * 由 `build-site` 对本轮所有 `verdict ≠ non-redchip` 的线索保证生成（100% 覆盖）。
 */
function entryRefOf(
  leadId: string,
  reports: Map<string, RedchipReportRef[]>,
): { url: string; kind: RedchipReportRef["kind"] } {
  const refs = reports.get(leadId) ?? [];
  const best =
    refs.find((r) => r.kind === "manual") ?? refs.find((r) => r.kind === "deep");
  if (best) return { url: best.url, kind: best.kind };
  return { url: `redchip/r/${leadId}.html`, kind: "pre-meeting" };
}

/** 单个线索的可展示面板条目（判定档为空 = 不打徽章 → 不进面板）。 */
function panelEntryOf(
  lead: RedchipLead,
  inputs: RedchipInputs,
  matchedIds: Set<string>,
): RedchipPanelEntry | undefined {
  const label = redchipLabelOf(lead);
  if (!label) return undefined; // non-redchip
  if (!inRedchipListWindow(lead, inputs.today)) return undefined;
  const { url } = entryRefOf(lead.leadId, inputs.reports);
  const changedFields = [
    ...new Set(
      inputs.changes
        .filter((c) => c.type === "changed" && c.appId === lead.leadId && c.field)
        .map((c) => c.field as string),
    ),
  ];
  return {
    leadId: lead.leadId,
    nameCn: lead.nameCn,
    nameEn: lead.nameEn,
    board: lead.board,
    status: lead.status,
    verdict: lead.verdict,
    label,
    ...(lead.domicile ? { domicile: lead.domicile } : {}),
    gdCityHits: lead.gdCityHits,
    vie: lead.vie,
    ...(lead.submitDate ? { submitDate: lead.submitDate } : {}),
    isNew: inputs.changes.some((c) => c.type === "added" && c.appId === lead.leadId),
    ...(changedFields.length ? { changedFields } : {}),
    matched: matchedIds.has(lead.leadId),
    ...(url ? { reportUrl: url } : {}),
    ...(lead.sourceUrl ? { sourceUrl: lead.sourceUrl } : {}),
  };
}

/** 面板：窗口内的红筹/待核线索（含未匹配到卡片的，T7），按递表日倒序。 */
export function buildRedchipPanel(
  inputs: RedchipInputs,
  matchedIds: Set<string>,
): RedchipPanel {
  const entries = inputs.leads
    .map((l) => panelEntryOf(l, inputs, matchedIds))
    .filter((e): e is RedchipPanelEntry => Boolean(e))
    .sort((a, b) => (a.submitDate ?? "") < (b.submitDate ?? "") ? 1 : -1);
  return {
    entries,
    ...(inputs.capturedAt ? { capturedAt: inputs.capturedAt } : {}),
  };
}

/**
 * 纯函数主体：给 IPO 条目挂徽章 + 产面板。
 *
 * @returns `report`（新对象）与 `matchedIds`（供面板标注「已匹配卡片」）。
 */
export function applyRedchip(
  report: DailyReport,
  inputs: RedchipInputs,
): { report: DailyReport; matchedIds: Set<string> } {
  const matchedIds = new Set<string>();
  const items = report.sections?.ipo ?? [];
  if (!items.length || !inputs.leads.length) return { report, matchedIds };

  let attached = 0;
  const next = items.map((it) => {
    const lead = matchRedchipLead(it, inputs.leads);
    if (!lead) return it; // T7：匹配失败 → 不打标
    const isNew = inputs.changes.some((c) => c.type === "added" && c.appId === lead.leadId);
    const { url, kind } = entryRefOf(lead.leadId, inputs.reports);
    const badge = redchipBadgeOf(lead, {
      today: inputs.today,
      isNew,
      changes: inputs.changes,
      reportUrl: url,
      reportKind: kind,
    });
    if (!badge) return it; // 窗口外 / 判定不打标
    matchedIds.add(lead.leadId);
    attached++;
    return { ...it, redchip: badge };
  });

  if (attached === 0) return { report, matchedIds };
  return { report: { ...report, sections: { ...report.sections, ipo: next } }, matchedIds };
}

/** 纯函数总入口：挂徽章 + 面板（面板为空则不写字段，避免产出空面板）。 */
export function buildRedchip(report: DailyReport, inputs: RedchipInputs): DailyReport {
  const { report: withBadges, matchedIds } = applyRedchip(report, inputs);
  const panel = buildRedchipPanel(inputs, matchedIds);
  if (panel.entries.length === 0) return withBadges;
  return { ...withBadges, redchipPanel: panel };
}

/**
 * IO 包装：读线索库/变更日志、探测报告 → 纯函数主体。
 *
 * 降级口径：`leads.json` 缺失/损坏 → 空数组 → 直接返回原 report
 * （「今日无红筹线索」，**不阻断日报发布**）。
 */
export function buildRedchipFromStore(report: DailyReport, ctx: PipelineContext): DailyReport {
  const leads = readLeads();
  if (leads.length === 0) {
    ctx.log.info("redchip", "ℹ️ 无 leads.json（红筹监测未产出），跳过红筹挂标");
    return report;
  }
  const changes = readChanges();
  const reports = resolveReports(leads.map((l) => l.leadId));
  const out = buildRedchip(report, {
    leads,
    changes,
    reports,
    today: ctx.date,
    capturedAt: readLatest()?.capturedAt,
  });
  const panel = out.redchipPanel;
  ctx.log.info(
    "redchip",
    `🚩 红筹旁路：线索 ${leads.length} 条 → 面板 ${panel?.entries.length ?? 0} 条` +
      `（已匹配卡片 ${panel?.entries.filter((e) => e.matched).length ?? 0} 条）` +
      `${panel?.entries.length ? `｜${panel.entries.map((e) => `${e.nameCn || e.leadId}(${e.label})`).slice(0, 3).join("、")}` : ""}`,
  );
  return out;
}

/** 面板徽章文案（渲染层复用；避免渲染层再去 import 服务层常量）。 */
export { REDCHIP_LABELS };
