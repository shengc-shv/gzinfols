/**
 * 红筹数据抓取适配器（唯一 IO 出口之一）。
 *
 * 两种来源：
 *  - **样本模式**（骨架阶段）：`loadSampleListing(path)` 读固定样本，**不发起网络请求**。
 *  - 实网模式：`fetchListingLive()` 拉披露易 AP&PHIP 静态 JSON（red 已验证地址）。
 *
 * ⚠️ 2026-09-15 关键修正（实网排查结论，见 docs/plan-redchip-crawl-push.md §1.2）：
 *  1. **只读英文清单（`*_e.json`）**：港交所中英各一套清单；中文版 PDF 用抽取器会得到
 *     CID 乱码（中文全成 `[ ]`），英文版抽取完整。故统一走英文通道（red 同款结论：
 *     「中文版 PDF 用 pypdf 提取会出现 CID 编码乱码，英文版提取完整」）。
 *  2. **`w` 字段不是申请版本**：它指向「警告聲明」单页（如 `warn26091300122.pdf`，1 页），
 *     **不含注册地句式**。真正的申请版本在 `ls[]`：`nF="Application Proof (1st submission)"`
 *     → `u1`=全文 PDF、`u2`=多檔案索引 htm。
 */
import fs from "node:fs";

/** `ls[]` 单条文档条目（披露易清单的文档目录）。 */
export interface ListingDocEntry {
  /** 文档日 DD/MM/YYYY。 */
  d?: string;
  /** 文档类型名，如 "Application Proof (1st submission)" / "申請版本（第一次呈交）"。 */
  nF?: string;
  /** 子类型，如 "Full Version" / "全文檔案"。 */
  nS1?: string;
  /** "Multi-Files" 标记。 */
  nS2?: string;
  /** 文档相对路径（全文/单档）。 */
  u1?: string;
  /** 多檔案索引 htm 相对路径。 */
  u2?: string;
}

export interface ListingRecord {
  /** 港交所申请编号（真实数据是**数字**，如 108870）。 */
  id?: string | number;
  /** 日期（披露易 d 字段）。 */
  d?: string;
  /** 公司名（英文清单为英文名）。 */
  a?: string;
  aEn?: string;
  st?: string;
  board?: string;
  /** 状态。 */
  s?: string;
  /** ⚠️ 这是**文件相对路径**（通常指向「警告聲明」单页），**不是申请版本**。 */
  w?: string;
  /** 递表日。 */
  sD?: string;
  postingDate?: string;
  /** 文档目录（申请版本等在此）。 */
  ls?: ListingDocEntry[];
  /** 判定用的文档直链（由 applicationProofUrlOf 填充）。 */
  docUrl?: string;
  /** PDF 抽取文本（样本模式直接给；实网模式由 pdf-text 抽取）。 */
  docText?: string;
}

const APP_BASE = "https://www1.hkexnews.hk/app/";
const EDS_BASE = "https://www1.hkexnews.hk/ncms/json/eds/";

/**
 * 清单文件：**英文版**（`_e`）。
 * 中文版（`_c`）的文档抽取会得到 CID 乱码（中文丢失），故不采用。
 */
const EDS_FILES = [
  "appactive_app_sehk_e.json",
  "appactive_app_gem_e.json",
  "applisted_sehk_e.json",
  "applisted_gem_e.json",
];

/** 申请版本条目的类型名识别（英文清单 / 中文清单兼容）。 */
const APP_PROOF_RE = /application proof|申請版本|申请版本/i;
/** 全文檔案子类型（优先，若同时存在多檔案）。 */
const FULL_VERSION_RE = /full version|全文檔案|全文档案/i;

/**
 * 申请版本 PDF 直链 —— **从 `ls[]` 里选**，而不是用 `w`（那是警告页）。
 * 选中规则：`nF` 命中「申请版本」的条目（若多条，优选取 `nS1` 为全文檔案的）→ `u1` 拼绝对地址。
 * 找不到申请版本 → 返回 `undefined`（**不回落警告页**：那是 1 页免责声明，抽了也判不出，
 * 徒增下载与误标 `unverified` 的噪声）。
 */
export function applicationProofUrlOf(r: ListingRecord): string | undefined {
  const entries = r.ls ?? [];
  const proofs = entries.filter((e) => e.u1 && APP_PROOF_RE.test(String(e.nF ?? "")));
  if (proofs.length === 0) return undefined;
  const preferred = proofs.find((e) => FULL_VERSION_RE.test(String(e.nS1 ?? ""))) ?? proofs[0];
  return APP_BASE + preferred.u1;
}

/**
 * 申请版本对应的**多檔案索引 htm** 直链（`u2`）。
 * 用途：只下「封面/重要提示/公司資料」等**小分册**（~100KB / 1 页 / ~3s），
 * 比下整份申请版本（5~11MB / 30~60s）便宜一个数量级（red 已验证）。
 */
export function multiFilesUrlOf(r: ListingRecord): string | undefined {
  const entries = r.ls ?? [];
  const proofs = entries.filter((e) => e.u2 && APP_PROOF_RE.test(String(e.nF ?? "")));
  if (proofs.length === 0) return undefined;
  return APP_BASE + proofs[0].u2;
}

/** 文档直链（= 申请版本；用于判定与回原文核对）。 */
export function docUrlOf(r: ListingRecord): string | undefined {
  return applicationProofUrlOf(r);
}

/** d 字段 "DD/MM/YYYY" → "YYYY-MM-DD"（用于按目标日期筛选）。 */
export function recordDateKey(r: ListingRecord): string | undefined {
  const m = String(r.d ?? "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? m[3] + "-" + m[2] + "-" + m[1] : undefined;
}

/**
 * 板块（由文档路径前缀判定）：`gem` → GEM，`sehk` → 主板。
 * 优先用 `ls[].u1`（申请版本路径），回退 `w`。
 */
export function boardOf(r: ListingRecord): string {
  const p = String((r.ls ?? []).find((e) => e.u1)?.u1 ?? r.w ?? "").toLowerCase();
  if (p.startsWith("gem") || p.includes("/gem/")) return "GEM";
  if (p.startsWith("sehk") || p.includes("/sehk/")) return "主板";
  return "";
}

/** 样本模式：读固定样本，零网络。 */
export function loadSampleListing(path: string): ListingRecord[] {
  const raw = fs.readFileSync(path, "utf8");
  const data = JSON.parse(raw) as { app?: ListingRecord[] };
  return data.app ?? [];
}

/** 实网模式：拉披露易 AP&PHIP 英文静态 JSON。 */
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
