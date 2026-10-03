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
  RedchipGdAdjacent,
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
import { readChanges, readLatest, readLeads, readMeta } from "../../adapters/redchip/snapshot-store";
import { latestLeadAt, ledgerMarketCounts } from "../../services/redchip/leads";
import { redchipFreshnessNote } from "../../services/redchip/provenance";
import { resolveReports } from "../../adapters/redchip/report-resolver";

export interface RedchipInputs {
  leads: RedchipLead[];
  changes: RedchipChange[];
  /** 已探测到的实体报告（deep/manual/r）；无则回落到确定性会前版路径。 */
  reports: Map<string, RedchipReportRef[]>;
  /** 报告日（北京时间 YYYY-MM-DD），窗口基准。 */
  today: string;
  /** 数据时刻（面板页脚）。来路见 `capturedSource`。 */
  capturedAt?: string;
  /**
   * `capturedAt` 的来源（见 `RedchipPanel.capturedSource`）：
   * `snapshot` = 抓取元信息；`ledger` = 台账派生（措辞须降级）。
   */
  capturedSource?: "snapshot" | "ledger";
  /** 本期未取到数据的源 id（如 `["us"]`）→ 面板显式降级说明。 */
  failedSources?: string[];
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
    ...(lead.lastChangedAt ? { changedAt: lead.lastChangedAt } : {}),
    isNew: inputs.changes.some((c) => c.type === "added" && c.appId === lead.leadId),
    ...(changedFields.length ? { changedFields } : {}),
    matched: matchedIds.has(lead.leadId),
    ...(url ? { reportUrl: url } : {}),
    ...(lead.sourceUrl ? { sourceUrl: lead.sourceUrl } : {}),
  };
}

/**
 * 近窗内「**非红筹但广东相关**」的申请（境内/香港注册）—— **只作面板呈现**。
 *
 * 判据三层，全部复用既有口径、不新造规则：
 *   ① 判定档为空（`redchipLabelOf` → ""，即 non-redchip）——「非红筹」；
 *   ② `isGdConnected`（集团实体语境广东命中 ≥ `GD_CITY_HIT_THRESHOLD`）——「广东相关」，
 *      与红筹判定的广东侧**同一门槛**（不用裸提及 `gdCityMentions`，避免地址/中介噪声）；
 *   ③ 落在展示窗内（`inRedchipListWindow`，认递表日或最近变更日）。
 *
 * 它们进不了红筹卡片与口播（判定就没过），呈现出来是为了让「爬虫这批工作换来了什么」可见。
 */
function gdAdjacentOf(inputs: RedchipInputs): RedchipGdAdjacent[] {
  const activeAt = (l: RedchipLead): string => l.lastChangedAt?.slice(0, 10) ?? l.submitDate ?? "";
  return inputs.leads
    .filter((l) => !redchipLabelOf(l) && l.isGdConnected && inRedchipListWindow(l, inputs.today))
    .sort((a, b) => (activeAt(a) < activeAt(b) ? 1 : -1))
    .slice(0, 20) // 上限：极端情况下（窗口内大量境内申请）不淹没面板；超出部分台账页可见
    .map((l) => ({
      leadId: l.leadId,
      nameCn: l.nameCn,
      nameEn: l.nameEn,
      ...(l.submitDate ? { submitDate: l.submitDate } : {}),
      ...(l.domicile ? { domicile: l.domicile } : {}),
      gdCityHits: l.gdCityHits,
      ...(l.market ? { market: l.market } : {}),
      ...(l.sourceUrl ? { sourceUrl: l.sourceUrl } : {}),
    }));
}

/**
 * 面板：窗口内的红筹/待核线索（含未匹配到卡片的，T7），按**活跃时间**倒序。
 *
 * 「活跃时间」= `max(lastChangedAt, submitDate)`：窗内可能有「8 月递表、今天被受理」
 * 的在册线索，只按递表日排会把最新动向排到末尾。
 *
 * `ledgerCount` = **全量台账**里可展示的线索数（含窗口外）。窗口只约束「近期动向」的罗列，
 * 不该让读者以为「面板空 = 没有红筹商机」—— 故把台账总数一并给出，渲染层据此给台账入口。
 */
export function buildRedchipPanel(
  inputs: RedchipInputs,
  matchedIds: Set<string>,
): RedchipPanel {
  const activeAt = (e: RedchipPanelEntry): string => e.changedAt ?? e.submitDate ?? "";
  const entries = inputs.leads
    .map((l) => panelEntryOf(l, inputs, matchedIds))
    .filter((e): e is RedchipPanelEntry => Boolean(e))
    .sort((a, b) => (activeAt(a) < activeAt(b) ? 1 : -1));
  const ledgerCount = inputs.leads.filter((l) => redchipLabelOf(l)).length;
  const ledgerByMarket = ledgerMarketCounts(inputs.leads);
  const lastChangedAt = latestLeadAt(inputs.leads);
  const freshnessNote = redchipFreshnessNote({
    capturedAt: inputs.capturedAt,
    today: inputs.today,
    failedSources: inputs.failedSources,
  });
  const gdAdjacent = gdAdjacentOf(inputs);
  return {
    entries,
    ...(inputs.capturedAt
      ? { capturedAt: inputs.capturedAt, capturedSource: inputs.capturedSource ?? "snapshot" }
      : {}),
    ...(ledgerCount ? { ledgerCount } : {}),
    ...(lastChangedAt ? { lastChangedAt } : {}),
    ...(Object.keys(ledgerByMarket).length ? { ledgerByMarket } : {}),
    ...(freshnessNote ? { freshnessNote } : {}),
    ...(gdAdjacent.length ? { gdAdjacent } : {}),
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

/** 纯函数总入口：挂徽章 + 面板（面板无内容才不写字段，避免产出空面板）。 */
export function buildRedchip(report: DailyReport, inputs: RedchipInputs): DailyReport {
  const { report: withBadges, matchedIds } = applyRedchip(report, inputs);
  const panel = buildRedchipPanel(inputs, matchedIds);
  // 窗口内无动向**但台账有在册线索** → 仍写面板（渲染为「只列台账入口」的安静态）。
  // 整块消失会让读者把「近期无新动向」误读成「没有红筹商机」—— 这正是回填前线上
  // 页面一个「红筹」字样都没有的原因（38 家在册，却因为无窗口内动向而不可见）。
  // 「非红筹但广东相关」同理：只有它们时也要写，否则爬虫那部分工作完全不可见。
  if (panel.entries.length === 0 && !panel.ledgerCount && !panel.gdAdjacent?.length) {
    return withBadges;
  }
  return { ...withBadges, redchipPanel: panel };
}

/**
 * 「数据截至」解析：**在全部可用证据里取最新的那一个时刻**，并标明它来自哪种证据。
 *
 * 证据来源（按权威度排序，但**取最新者胜**）：
 *   ① `data/redchip/meta.json`（**入库**）—— 抓取元信息。唯一不依赖工作区残留的来路
 *      （CI runner 从零 checkout 也能读到；`latest.json` 做不到，见 .gitignore）。
 *   ② `data/redchip/latest.json`（不入库）—— 与 ① 取较新者；本地跑时可用。
 *   ③ `leads.json` 派生的 `max(lastChangedAt, discoveredAt)`（**入库**）。
 *
 * 🔴 为什么是「取最新」而不是「有 ①② 就用 ①②」：实测本地工作区留着一份
 * **09-17 的旧 `latest.json`**，而台账里明明有 10-03 的变更记录 —— 若按权威度硬取，
 * 面板会继续显示「数据截至 09-17」，**用户最初报的就是这个症状**。
 * 只要更晚的证据存在，就不能呈现更早的日期（「缺失/过期必须显式说明、不得静默沿用旧数字」）。
 *
 * `capturedSource` 的措辞差异（`snapshot` →「数据截至」/ `ledger` →「台账更新至」）见渲染层：
 * 台账派生只证明「台账里有这个时刻的记录」，**不等于**「那一刻跑过抓取」。
 *
 * 另收集「本期未取到数据的源」（`meta.sources[*].ok === false`）→ 面板显式降级说明。
 *
 * 导出仅为单测可直接覆盖解析链（IO 在 adapters，测试用 `setRedchipBaseDir` 隔离目录）。
 */
export function resolveRedchipCaptured(leads: RedchipLead[]): {
  capturedAt?: string;
  capturedSource?: "snapshot" | "ledger";
  failedSources: string[];
} {
  const meta = readMeta();
  const stamps: string[] = [];
  const failedSources: string[] = [];
  for (const [id, s] of Object.entries(meta?.sources ?? {})) {
    if (s?.capturedAt) stamps.push(s.capturedAt);
    if (s && s.ok === false) failedSources.push(id);
  }
  const fromLatest = readLatest()?.capturedAt;
  if (fromLatest) stamps.push(fromLatest);
  stamps.sort();

  const snapshotAt = stamps.length ? stamps[stamps.length - 1] : undefined;
  const ledgerAt = latestLeadAt(leads);

  if (snapshotAt && (!ledgerAt || snapshotAt >= ledgerAt)) {
    return { capturedAt: snapshotAt, capturedSource: "snapshot", failedSources };
  }
  if (ledgerAt) return { capturedAt: ledgerAt, capturedSource: "ledger", failedSources };
  return { capturedAt: undefined, capturedSource: undefined, failedSources };
}

/**
 * IO 包装：读线索库/变更日志、解析数据时刻、探测报告 → 纯函数主体。
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
  const captured = resolveRedchipCaptured(leads);
  const out = buildRedchip(report, {
    leads,
    changes,
    reports,
    today: ctx.date,
    ...captured,
  });
  const panel = out.redchipPanel;
  ctx.log.info(
    "redchip",
    `🚩 红筹旁路：线索 ${leads.length} 条 → 面板 ${panel?.entries.length ?? 0} 条` +
      `（已匹配卡片 ${panel?.entries.filter((e) => e.matched).length ?? 0} 条）` +
      `｜在册 ${panel?.ledgerCount ?? 0} 家 · 数据截至 ${panel?.capturedAt?.slice(0, 16) ?? "未知"}` +
      `（${panel?.capturedSource === "ledger" ? "台账派生" : "抓取元信息"}）` +
      `${panel?.freshnessNote ? `｜${panel.freshnessNote}` : ""}` +
      `${panel?.entries.length ? `｜${panel.entries.map((e) => `${e.nameCn || e.leadId}(${e.label})`).slice(0, 3).join("、")}` : ""}`,
  );
  return out;
}

/** 面板徽章文案（渲染层复用；避免渲染层再去 import 服务层常量）。 */
export { REDCHIP_LABELS };
