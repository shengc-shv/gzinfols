/**
 * 红筹台账 · 基线回填与合并（纯函数，服务层，零 IO）。
 *
 * 背景（2026-09-17 实测）：本仓 `redchip-monitor` 只有「今天 + 昨天」增量窗口，
 * 在册申请（处理中 / 已上市）**没有基线** → 线上面板长期是「共 1 家（红筹 0）」。
 * 需要一次性把上游台账的全量在册清单回填进来，此后由每日增量维护。
 *
 * 🔴 红线（必须遵守）：
 * 上游台账含招股书**原文摘录**（`gd_opco` / `vie_evidence`），实测其中含
 * 「主要往来银行 中国银行广州番禺支行」这类**可定位银行主体**的信息。
 * 故本模块的输入类型 `UpstreamListingRow` **刻意不含这些字段** —— 从类型层面杜绝
 * 原文流入产物；只取计数与枚举（注册地标签、词频、VIE 布尔、PDF 直链）。
 */
import {
  GD_CITY_HIT_THRESHOLD,
  type RedchipProject,
  type RedchipVerdict,
  type RedchipVie,
} from "../../contracts/redchip";
import { isOffshoreDomicile } from "./classify";

/**
 * 上游台账行（**只允许这些字段**）。
 *
 * 与之对应的是上游 CSV 的以下列：id / name_cn / name_en / board / status /
 * stock_code / submit_date / domicile / gd_opco_count / is_vie / app_proof_url。
 * 明确**不**包含 `gd_opco` 与 `vie_evidence`（原文含行名）。
 */
export interface UpstreamListingRow {
  appId: string;
  nameCn?: string;
  nameEn?: string;
  board?: string;
  status?: string;
  stockCode?: string;
  /** YYYY-MM-DD */
  submitDate?: string;
  /** 注册地标签（封面页判定口径，如「开曼群岛」）。 */
  domicile?: string;
  /** 广东运营实体词频（上游口径；本仓阈值同为 ≥ 3）。 */
  gdOpcoCount: number;
  /** 上游 `is_vie` 原值（是 / 否 / 空）。 */
  vieFlag?: string;
  /** 申请版本 PDF 直链（回原文核对入口）。 */
  proofUrl?: string;
}

/** 上游 `is_vie` → 本仓 VIE 枚举（仅画像，不参与判定）。 */
export function vieOfFlag(flag: string | undefined): RedchipVie {
  const s = (flag ?? "").trim();
  if (s === "是" || s === "yes" || s === "true") return "current";
  if (s === "否" || s === "no" || s === "false") return "none";
  return "unverified";
}

/**
 * 上游行 → 本仓 `RedchipProject`（判定口径与 `classifyProject` **完全一致**：
 * 离岸注册 ∧ 广东运营词频 ≥ `GD_CITY_HIT_THRESHOLD`）。
 *
 * @param discoveredAt 发现时间（北京时间 ISO）——由调用方注入，服务层不读时钟。
 */
export function projectFromUpstreamRow(
  row: UpstreamListingRow,
  discoveredAt: string,
): RedchipProject {
  const isOffshore = isOffshoreDomicile(row.domicile);
  const gdCityHits = Math.max(0, Math.trunc(row.gdOpcoCount || 0));
  const isGdConnected = gdCityHits >= GD_CITY_HIT_THRESHOLD;
  const verdict: RedchipVerdict =
    isOffshore && isGdConnected ? "redchip" : "non-redchip";
  return {
    appId: row.appId,
    nameCn: row.nameCn ?? "",
    nameEn: row.nameEn ?? "",
    board: row.board ?? "",
    status: row.status ?? "",
    stockCode: row.stockCode || undefined,
    submitDate: row.submitDate || undefined,
    domicile: row.domicile,
    isOffshore,
    gdCityHits,
    isGdConnected,
    vie: vieOfFlag(row.vieFlag),
    verdict,
    discoveredAt,
    sourceUrl: row.proofUrl || undefined,
  };
}

/**
 * 台账合并（按 `appId` 覆盖，其余保留）——**在册申请是持续状态，不是每日快照**。
 *
 * 为什么必须合并：原实现每天用「今天+昨天」窗口的项目**直接覆盖** leads.json，
 * 窗口外的在册线索会被静默抹掉（这也是线上恒为「1 家」的直接原因）。
 *
 * 合并规则：
 * - 同一个 `appId`：**新数据覆盖旧数据**，但 `discoveredAt` 保留最早的一个
 *   （「发现时间」是台账属性，不该因为每天重抓而刷新）。
 * - 稳定的排序（按递表日倒序、再按 appId）→ git diff 稳定，便于人工核对。
 */
export function mergeProjects(
  prev: RedchipProject[],
  next: RedchipProject[],
): RedchipProject[] {
  const byId = new Map<string, RedchipProject>();
  for (const p of prev) if (p?.appId) byId.set(p.appId, p);
  for (const p of next) {
    if (!p?.appId) continue;
    const old = byId.get(p.appId);
    byId.set(
      p.appId,
      old?.discoveredAt ? { ...p, discoveredAt: old.discoveredAt } : p,
    );
  }
  return [...byId.values()].sort(
    (a, b) =>
      (b.submitDate ?? "").localeCompare(a.submitDate ?? "") ||
      a.appId.localeCompare(b.appId),
  );
}

/**
 * 台账过滤：只收「离岸注册 ∧ 广东运营词频达标」的线索（宁缺毋滥）。
 *
 * 非离岸（如境内 H 股）**整批不收** —— 396 家境内主体进库只会把面板稀释成噪声；
 * 离岸但词频不足的也不收（证据不足，收了就是猜测）。
 */
export function pickRedchipRows(rows: UpstreamListingRow[]): UpstreamListingRow[] {
  return rows.filter(
    (r) => isOffshoreDomicile(r.domicile) && (r.gdOpcoCount || 0) >= GD_CITY_HIT_THRESHOLD,
  );
}
