/**
 * 红筹线索 → 卡片徽章 / 窗口判定（纯函数，零 IO）。
 *
 * 对应 `docs/plan-redchip-crawl-push.md` §2.2 / §3 / Trigger Matrix T2·T4·T7。
 *
 * 三层职责（严格分开，便于单测）：
 *   ① `matchRedchipLead` —— **实体匹配**（无状态源红线：只认编号/企业名/代码，
 *      绝不因「条目来自红筹源」而打标；匹配失败即不打标 = T7）；
 *   ② `redchipLabelOf` —— 判定档 → 徽章文案（红线「线索 ≠ 结论」，§3.1）；
 *   ③ `redchipBadgeOf` —— 叠加时间窗（§3.2）与变更标记（§3.3）产出 `ReportItem.redchip`。
 */

import type { ReportItem } from "../../contracts/report";
import type { RedchipBadge, RedchipChange, RedchipLead, RedchipReportRef } from "../../contracts/redchip";
import { GD_CITY_HIT_THRESHOLD, REDCHIP_LABELS } from "../../contracts/redchip";
import { REDCHIP_LIST_WINDOW_DAYS, REDCHIP_VOICE_WINDOW_DAYS } from "../../ipo-config";
import { dayGap } from "../../utils/time";
import { normalizeCompanyName } from "../redchip/classify";

/**
 * 港交所申请编号：出现在清单/申请版本 URL 的路径段里
 * （如 `…/app/sehk/2026/108870/2026091300120_c.htm` 与 `…/108870/documents/….pdf`）。
 *
 * 实测（2026-09-15）：真实日报里 5 条港交所条目**全部**带该编号，且与红筹 `appId` 完全一致
 * —— 故编号是**精确**匹配键，企业名仅作跨语言不可用时的兜底。
 */
const HKEX_APP_ID_RE = /hkexnews\.hk\/app\/(?:sehk|gem)\/\d{4}\/(\d{4,})/i;

/** 从条目 URL 提取港交所申请编号（officialUrl 优先，其次 url）。 */
export function hkexAppIdOf(item: Pick<ReportItem, "url" | "officialUrl">): string | undefined {
  for (const u of [item.officialUrl, item.url]) {
    const m = u ? HKEX_APP_ID_RE.exec(u) : null;
    if (m) return m[1];
  }
  return undefined;
}

/** 归一化企业名（与红筹判定/口播去重共用同一 `normalizeCompanyName`，避免两套口径）。 */
function normName(raw: string | undefined): string {
  const s = normalizeCompanyName(raw ?? "");
  return s.length >= 4 ? s : ""; // 过短（去后缀后只剩 3 字以内）不可作为匹配依据，防误配
}

/** 归一化股票代码（去前缀零/非数字）。 */
function normCode(raw: string | undefined): string {
  const s = (raw ?? "").replace(/[^0-9]/g, "").replace(/^0+/, "");
  return s.length >= 4 ? s : "";
}

/**
 * 实体匹配（T2 的前置）：按 **① 港交所编号 → ② 股票代码 → ③ 归一化企业名** 依次尝试。
 *
 * ⚠️ 企业名匹配**仅在同语言下有效**：港交所英文清单给出的是英文名，而中文条目标题是中文名，
 *    两者归一化后不会相等 → 这类情形必须靠编号（实测港交所条目 URL 均带编号，够用）。
 *    中英双名回填不在本步（属 §6 数据侧后续项），故此处退化为「同语言包含/相等」。
 */
export function matchRedchipLead(
  item: Pick<ReportItem, "url" | "officialUrl" | "title_cn" | "title_orig"> & { stockCode?: string },
  leads: RedchipLead[],
): RedchipLead | undefined {
  if (leads.length === 0) return undefined;

  const id = hkexAppIdOf(item);
  if (id) {
    const hit = leads.find((l) => l.leadId === id || l.appId === id);
    if (hit) return hit;
  }

  const code = normCode(item.stockCode);
  if (code) {
    const hit = leads.find((l) => normCode(l.stockCode) === code);
    if (hit) return hit;
  }

  const names = [normName(item.title_cn), normName(item.title_orig)].filter(Boolean);
  if (names.length) {
    const hit = leads.find((l) => {
      const cands = [normName(l.nameCn), normName(l.nameEn)].filter(Boolean);
      return cands.some((c) => names.some((n) => n === c || n.includes(c) || c.includes(n)));
    });
    if (hit) return hit;
  }

  return undefined; // T7：匹配失败 → 不打标
}

/** 证据完整（§3.1）：注册地非空 ∧ 广东词频达标 ∧ 有回原文的链接。 */
export function hasCompleteEvidence(lead: RedchipLead): boolean {
  return Boolean(lead.domicile) && lead.gdCityHits >= GD_CITY_HIT_THRESHOLD && Boolean(lead.sourceUrl);
}

/**
 * 判定档 → 徽章文案（§3.1）。
 *   `redchip` 证据完整 → 「红筹线索」；证据不齐 → 降级「红筹线索·待核」；
 *   `unverified` → 「红筹线索·待核」；`non-redchip` → 不打徽章（返回 ""）。
 */
export function redchipLabelOf(lead: RedchipLead): RedchipBadge["label"] | "" {
  if (lead.verdict === "redchip") {
    return hasCompleteEvidence(lead) ? REDCHIP_LABELS.redchip : REDCHIP_LABELS.unverified;
  }
  if (lead.verdict === "unverified") return REDCHIP_LABELS.unverified;
  return "";
}

/**
 * 线索日期键（窗口基准）：`submitDate` 优先，缺失回退 `discoveredAt` 的日期部分。
 * 两者都缺 → `undefined` → 不进任何窗口（**时间红线**：绝不用抓取时刻兜底）。
 */
export function leadDateKey(lead: RedchipLead): string | undefined {
  const isKey = (s: string | undefined): s is string => Boolean(s && /^\d{4}-\d{2}-\d{2}$/.test(s));
  if (isKey(lead.submitDate)) return lead.submitDate;
  const d = lead.discoveredAt?.slice(0, 10);
  return isKey(d) ? d : undefined;
}

/**
 * 窗口判定：**日差 ≤ days**（今天-days ~ 今天），与 `IPO_LIST_WINDOW_DAYS` 的
 * 2026-09-10 实锤口径一致（**不是**「含今天共 N 个日历日」）。
 */
export function inRedchipWindow(lead: RedchipLead, today: string, days: number): boolean {
  const key = leadDateKey(lead);
  if (!key) return false;
  const gap = dayGap(key, today);
  return gap >= 0 && gap <= days;
}

/** 进「IPO 动态」列表卡片的窗口（§3.2）。 */
export function inRedchipListWindow(lead: RedchipLead, today: string): boolean {
  return inRedchipWindow(lead, today, REDCHIP_LIST_WINDOW_DAYS);
}

/**
 * 进口播 / 横滑的窗口（§3.2）——比列表窗更窄，只播最新动向。
 * 注意：卡片展示**不受**此窗影响（沿用 `REDCHIP_LIST_WINDOW_DAYS`）。
 */
export function inRedchipVoiceWindow(lead: RedchipLead, today: string): boolean {
  return inRedchipWindow(lead, today, REDCHIP_VOICE_WINDOW_DAYS);
}

/** 徽章叠加所需的上下文（全部由调用方注入，服务层不读时钟/环境）。 */
export interface RedchipBadgeContext {
  /** 报告日（北京时间 YYYY-MM-DD），窗口基准。 */
  today: string;
  /** 本次快照 `added` → 角标「新」（§3.3）。 */
  isNew?: boolean;
  /** 本次该线索的变更记录（取 `changed` 生成字段标记与人话摘要）。 */
  changes?: RedchipChange[];
  /** 报告页入口（由 report-resolver 探测；缺省则卡片无入口）。 */
  reportUrl?: string;
  reportKind?: RedchipReportRef["kind"];
}

/**
 * 产出卡片徽章（T2）：`non-redchip` 或**不在展示窗口** → undefined（不打标）。
 */
export function redchipBadgeOf(
  lead: RedchipLead,
  ctx: RedchipBadgeContext,
): RedchipBadge | undefined {
  const label = redchipLabelOf(lead);
  if (!label) return undefined;
  if (!inRedchipListWindow(lead, ctx.today)) return undefined;

  const changed = (ctx.changes ?? []).filter((c) => c.type === "changed" && c.appId === lead.leadId);
  const changedFields = [...new Set(changed.map((c) => c.field).filter((f): f is string => Boolean(f)))];
  const changeSummary = changed.length
    ? changed
        .slice(0, 2)
        .map((c) => `${c.field ?? "字段"} ${c.from ?? "—"}→${c.to ?? "—"}`)
        .join("；")
    : undefined;

  return {
    leadId: lead.leadId,
    label,
    verdict: lead.verdict,
    isNew: Boolean(ctx.isNew),
    ...(changedFields.length ? { changedFields } : {}),
    ...(changeSummary ? { changeSummary } : {}),
    ...(ctx.reportUrl
      ? { reportUrl: ctx.reportUrl, reportKind: ctx.reportKind ?? "pre-meeting" }
      : {}),
    ...(lead.domicile ? { domicile: lead.domicile } : {}),
    gdCityHits: lead.gdCityHits,
  };
}
