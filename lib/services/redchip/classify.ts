/**
 * 红筹判定（纯函数，服务层）—— 阈值策略，保持简单可解释。
 *
 * 口径：红筹 = 境外注册 ∧ 广东运营实体词频 ≥ 3（GD_CITY_HIT_THRESHOLD）。
 * VIE 仅作画像，不参与判定；证据不足 → verdict = "unverified"（宁缺毋滥）。
 */
import {
  COVER_DOMICILE_PATTERNS,
  GD_CITIES,
  GD_CITY_HIT_THRESHOLD,
  OFFSHORE_JURISDICTIONS,
  VIE_KEYWORDS,
  type RedchipProject,
  type RedchipVerdict,
  type RedchipVie,
} from "../../contracts/redchip";

export interface ClassifyInput {
  appId: string;
  nameCn?: string;
  nameEn?: string;
  board?: string;
  status?: string;
  stockCode?: string;
  submitDate?: string;
  /** 招股书文本（适配器抽取，用于封面注册地与广东词频）。 */
  docText?: string;
  sourceUrl?: string;
  /** 发现时间（北京时间 ISO），由调用方注入（服务层不读时钟）。 */
  discoveredAt: string;
}

/** 企业名归一化（去后缀/标记/标点），用于同名二次递表识别。 */
export function normalizeCompanyName(raw: string): string {
  if (!raw) return "";
  let s = raw.toLowerCase();
  s = s.replace(/[（(][^）)]*[）)]/g, "");
  s = s.replace(/[-–—]\s*[wbs]\b/g, "");
  s = s.replace(/(股份有限公司|有限责任公司|有限公司|控股|集團|集团|國際|国际|科技|實業|实业|發展|发展|公司)/g, "");
  s = s.replace(/\b(holdings?|group|international|incorporated|inc|company|co|limited|ltd|corp|plc)\b\.?/g, "");
  s = s.replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
  return s;
}

/** 从封面页固定句式抽取注册地。 */
export function extractDomicile(text: string): string | undefined {
  if (!text) return undefined;
  for (const re of COVER_DOMICILE_PATTERNS) {
    const m = text.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return undefined;
}

/** 注册地是否属离岸法域。 */
export function isOffshoreDomicile(domicile: string | undefined): boolean {
  if (!domicile) return false;
  const d = domicile.trim().toLowerCase();
  return OFFSHORE_JURISDICTIONS.some((j) => d.includes(j.toLowerCase()));
}

/** 广东城市词频统计。 */
export function countGdCityHits(text: string): number {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const city of GD_CITIES) {
    const c = city.toLowerCase();
    let idx = lower.indexOf(c);
    while (idx !== -1) {
      hits++;
      idx = lower.indexOf(c, idx + c.length);
    }
  }
  return hits;
}

/** VIE 画像（不参与判定）。 */
export function detectVie(text: string): RedchipVie {
  if (!text) return "unverified";
  const hit = VIE_KEYWORDS.some((k) => text.includes(k));
  if (!hit) return "none";
  if (/已终止|已終止|terminated/i.test(text)) return "historical";
  return "current";
}

/** 综合判定：产出单个项目画像。 */
export function classifyProject(input: ClassifyInput): RedchipProject {
  const text = input.docText ?? "";
  const domicile = extractDomicile(text);
  const isOffshore = isOffshoreDomicile(domicile);
  const gdCityHits = countGdCityHits(text);
  const isGdConnected = gdCityHits >= GD_CITY_HIT_THRESHOLD;

  let verdict: RedchipVerdict;
  if (!text) verdict = "unverified";
  else if (isOffshore && isGdConnected) verdict = "redchip";
  else verdict = "non-redchip";

  return {
    appId: input.appId,
    nameCn: input.nameCn ?? "",
    nameEn: input.nameEn ?? "",
    board: input.board ?? "",
    status: input.status ?? "",
    stockCode: input.stockCode,
    submitDate: input.submitDate,
    domicile,
    isOffshore,
    gdCityHits,
    isGdConnected,
    vie: detectVie(text),
    verdict,
    discoveredAt: input.discoveredAt,
    sourceUrl: input.sourceUrl,
  };
}

/** 是否命中红筹口径（供筛选/展示复用）。 */
export function isRedchip(p: RedchipProject): boolean {
  return p.verdict === "redchip";
}
