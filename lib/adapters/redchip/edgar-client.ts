/**
 * SEC EDGAR 客户端（美股红筹源唯一 IO 出口；仿 `hkex-client.ts` 分层）。
 *
 * 数据来源（官方、免鉴权、结构化）：
 *   ① F-1/F-1A 全文检索：https://efts.sec.gov/LATEST/search-index?q=…&forms=F-1
 *      （SEC 官方全文索引；按文件日期窗口取「新递表」，2026-10-01 实测命中
 *       近期大量开曼/中国发行人，如 LYC HEALTHCARE (CAYMAN)、707 Cayman Holdings）
 *   ② 主文档定位：https://data.sec.gov/submissions/CIK{cik}.json
 *      （检索结果只给 CIK+adsh，**没有文档 URL**；用 submissions 匹配 accession
 *       拿 primaryDocument，再拼 Archives 直链）
 *   ③ 主文档下载：https://www.sec.gov/Archives/edgar/data/{cik}/{adsh}/{primaryDoc}
 *      （F-1 主文档是 HTML `formf-1.htm`，2~8MB；文本抽取走 `html-text.ts`）
 *
 * 限流合规（SEC 官方要求）：UA 必须可辨识；限速 10 req/s。本客户端不做节流，
 * 由调用方（脚本层）按源窗口命中量控制并发与间隔。
 *
 * 时间红线：`file_date` 是 SEC 提交日（美东），窗口按 YYYY-MM-DD 字符串对齐北京
 * 日历日（今天+昨天）——文件日晚于北京日期半天属已知口径差，接受（与披露易滞后同理）。
 */
import { extractEdgarHtmlText } from "./html-text";

export const EDGAR_UA =
  "gzinfols-local/1.0 (local redchip us sync; contact: admin@example.com)";

/** 检索重试退避间隔（ms）。SEC 全文检索实测会间歇性 500，重试即恢复。 */
export const EDGAR_RETRY_DELAYS_MS = [800, 2000] as const;

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface EdgarFiling {
  /** 发行人 CIK（去前导零，如 2050183）。 */
  cik: string;
  /** 带横杠的 accession（如 0001493152-26-044696），用于匹配 submissions。 */
  adsh: string;
  /** YYYY-MM-DD（SEC 提交日）。 */
  fileDate: string;
  /** 展示名（含公司名，如 "LYC HEALTHCARE (CAYMAN) LTD (CIK 0002050183)"）。 */
  displayName: string;
  /** 主文档 URL（由 submissions 解析；未解析前为空）。 */
  primaryUrl?: string;
}

/** 检索 F-1/F-1A 主文档（近 N 天窗口），按 CIK 去重取最新。 */
export async function searchF1Filings(startDate: string, endDate: string): Promise<EdgarFiling[]> {
  const url =
    `https://efts.sec.gov/LATEST/search-index?q=%22F-1%22` +
    `&dateRange=custom&startdt=${startDate}&enddt=${endDate}&forms=F-1`;
  // 🔴 2026-10-04：SEC 全文检索**间歇性返回 HTTP 500**（实测同一 URL 重试即恢复）。
  //    原实现只 warn 后 `return []` → 与「窗口内真的 0 命中」**不可区分**，
  //    于是美股源连续 4 天空快照（`data/redchip-us/*.json` 全是 `count:0`）而无人察觉。
  //    现在：5xx / 网络错 → 按 `EDGAR_RETRY_DELAYS_MS` 退避重试；仍失败则**抛错**，
  //    由调用方决定不写盘（绝不用空快照覆盖上一份有效数据）。
  let res: Response | null = null;
  let lastErr = "";
  for (let attempt = 0; attempt <= EDGAR_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleepMs(EDGAR_RETRY_DELAYS_MS[attempt - 1]!);
    try {
      res = await fetch(url, { headers: { "User-Agent": EDGAR_UA } });
    } catch (err) {
      lastErr = (err as Error).message;
      console.warn(`[edgar] 检索异常（第 ${attempt + 1} 次）：${lastErr}`);
      continue;
    }
    if (res.ok) break;
    // 4xx（除 429）是请求本身有问题，重试无意义 → 立刻失败
    if (res.status < 500 && res.status !== 429) {
      throw new Error(`[edgar] 检索失败 HTTP ${res.status}（不可重试的客户端错误）`);
    }
    lastErr = `HTTP ${res.status}`;
    console.warn(`[edgar] 检索失败 ${lastErr}（第 ${attempt + 1} 次）`);
    res = null;
  }
  if (!res) {
    throw new Error(
      `[edgar] 检索连续 ${EDGAR_RETRY_DELAYS_MS.length + 1} 次失败（${lastErr}）——` +
        `已放弃本轮，**不写空快照**（避免覆盖上一份有效数据）`,
    );
  }
  const data = (await res.json()) as {
    hits?: { hits?: { _source?: Record<string, unknown> }[] };
  };
  const raw = data.hits?.hits ?? [];

  // 只收主文档：form 与 file_type 都是 F-1/F-1/A（排除 EX-FILING FEES / CORRESP 等附属件）
  const isMain = (f: string | undefined) => f === "F-1" || f === "F-1/A";
  const seen = new Map<string, EdgarFiling>();
  for (const h of raw) {
    const s = h._source ?? {};
    const form = String(s.form ?? "");
    const fileType = String(s.file_type ?? "");
    if (!isMain(form) || !isMain(fileType)) continue;
    const ciks = s.ciks as string[] | undefined;
    const cik = ciks?.[0] ? String(ciks[0]).replace(/^0+/, "") : "";
    const adsh = String(s.adsh ?? "");
    const fileDate = String(s.file_date ?? "");
    if (!cik || !adsh || !fileDate) continue;
    const key = cik;
    const prev = seen.get(key);
    // 同 CIK 多份（F-1 + F-1/A）→ 保留 fileDate 最新
    if (!prev || (prev.fileDate < fileDate) || (prev.fileDate === fileDate && prev.adsh < adsh)) {
      seen.set(key, {
        cik,
        adsh,
        fileDate,
        displayName: String((s.display_names as string[] | undefined)?.[0] ?? ""),
      });
    }
  }
  return [...seen.values()].sort((a, b) => b.fileDate.localeCompare(a.fileDate));
}

/** 用 submissions API 解析主文档直链（按 accession 精确匹配）。 */
export async function resolvePrimaryDocUrl(f: EdgarFiling): Promise<string | undefined> {
  const url = `https://data.sec.gov/submissions/CIK${String(f.cik).padStart(10, "0")}.json`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": EDGAR_UA } });
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      filings?: { recent?: { accessionNumber?: string[]; primaryDocument?: string[] } };
    };
    const recent = data.filings?.recent;
    const accs = recent?.accessionNumber ?? [];
    const docs = recent?.primaryDocument ?? [];
    const idx = accs.findIndex((a) => a === f.adsh);
    if (idx < 0 || !docs[idx]) return undefined;
    const adshNoDash = f.adsh.replace(/-/g, "");
    return `https://www.sec.gov/Archives/edgar/data/${f.cik}/${adshNoDash}/${docs[idx]}`;
  } catch {
    return undefined;
  }
}

/** 下载 F-1 主文档并抽取文本（失败返回空串）。 */
export async function extractEdgarDoc(url: string): Promise<string> {
  return extractEdgarHtmlText(url);
}
