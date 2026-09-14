/**
 * 红筹数据抓取适配器（唯一 IO 出口之一）。
 *
 * 两种来源：
 *  - **样本模式**（骨架阶段）：`loadSampleListing(path)` 读固定样本，**不发起网络请求**。
 *  - 实网模式：`fetchListingLive()` 拉披露易 AP&PHIP 静态 JSON（red 已验证地址）。
 *    骨架阶段不调用；后续接入时按「当次 CI 运行日期」过滤。
 */
import fs from "node:fs";

export interface ListingRecord {
  id?: string;
  /** 日期（披露易 d 字段）。 */
  d?: string;
  /** 公司名（披露易 a 字段）。 */
  a?: string;
  aEn?: string;
  st?: string;
  board?: string;
  /** 状态。 */
  s?: string;
  /** 板块。 */
  w?: string;
  /** 递表日。 */
  sD?: string;
  postingDate?: string;
  /** 申请版本文件地址（骨架阶段由样本提供；实网由 doc 目录拼出）。 */
  docUrl?: string;
  /** PDF 抽取文本（样本模式直接给；实网模式由 pdf-text 抽取）。 */
  docText?: string;
}

const APP_BASE = "https://www1.hkexnews.hk/app/";
const EDS_BASE = "https://www1.hkexnews.hk/ncms/json/eds/";

/** 申请版本文件地址（w 字段是相对路径，如 sehk/2013/2013101501/documents/xxx_c.pdf）。 */
export function docUrlOf(r: ListingRecord): string | undefined {
  return r.w ? APP_BASE + r.w : undefined;
}

/** d 字段 "DD/MM/YYYY" → "YYYY-MM-DD"（用于按目标日期筛选）。 */
export function recordDateKey(r: ListingRecord): string | undefined {
  const m = String(r.d ?? "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? m[3] + "-" + m[2] + "-" + m[1] : undefined;
}

/** 板块（由文件路径前缀判定）。 */
export function boardOf(r: ListingRecord): string {
  const w = String(r.w ?? "").toLowerCase();
  if (w.startsWith("gem")) return "GEM";
  if (w.startsWith("sehk")) return "主板";
  return "";
}
const EDS_FILES = [
  "appactive_app_sehk_c.json",
  "appactive_app_gem_c.json",
  "applisted_sehk_c.json",
  "applisted_gem_c.json",
];

/** 样本模式：读固定样本，零网络。 */
export function loadSampleListing(path: string): ListingRecord[] {
  const raw = fs.readFileSync(path, "utf8");
  const data = JSON.parse(raw) as { app?: ListingRecord[] };
  return data.app ?? [];
}

/** 实网模式：拉披露易 AP&PHIP 静态 JSON（当前骨架阶段未启用）。 */
export async function fetchListingLive(): Promise<ListingRecord[]> {
  const out: ListingRecord[] = [];
  for (const f of EDS_FILES) {
    const res = await fetch(EDS_BASE + f);
    if (!res.ok) continue;
    const data = (await res.json()) as { app?: ListingRecord[] };
    out.push(...(data.app ?? []));
  }
  return out;
}
