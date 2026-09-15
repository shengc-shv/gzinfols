/**
 * 红筹判定（纯函数，服务层）—— 阈值策略，保持简单可解释。
 *
 * 口径：红筹 = 境外注册 ∧ 广东运营实体词频 ≥ 3（GD_CITY_HIT_THRESHOLD）。
 * 广东词频**只统计「集团实体语境」句**内的命中（`countGdCityHits`）——裸提及会把董事住址、
 * 中介地址、交易所名称算进来（2026-09-15 实抽单册 127 次里仅 10 次属实体语境），
 * 使阈值恒成立、判定退化为「只看是否离岸」。裸提及保留在 `countGdCityMentions` 供展示。
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

/** 紧凑化：只留字母 + 小写。
 *  2026-09-15（实网排查）：PDF 抽取常在**词内插空格/字距断点**（"Cayman Isl ands"、
 *  "People ’s"），直接写带 \s 的正则必然失配。故先只留字母、统一小写后再匹配
 *  （red 已验证的同款技巧）。 */
export function compactCoverText(text: string): string {
  return (text ?? "").replace(/[^A-Za-z]/g, "").toLowerCase();
}

/** 英文封面句式（紧凑化后匹配）：严格版要求 `with limited liability` 收尾。 */
const COVER_COMPACT_STRICT_RE =
  /(?:incorporated|registered|established|continued)(?:asanexemptedcompany)?(?:in|underthelawsof)(?:the)?(caymanislands|bermuda|peoplesrepublicofchina|republicofchina|prc|hongkong)[^.]{0,40}?withlimitedliability/;

/** 放宽版：允许 `with limited liability` 缺失（少数文件用作废句）。 */
const COVER_COMPACT_RELAXED_RE =
  /(?:incorporated|registered|established|continued)(?:asanexemptedcompany)?(?:in|underthelawsof)(?:the)?(caymanislands|bermuda|peoplesrepublicofchina|republicofchina|prc|hongkong)/;

/** 紧凑匹配到的法域名 → 展示标签（与 OFFSHORE_JURISDICTIONS / 判定口径一致）。 */
const COMPACT_JUR_LABEL: Record<string, string> = {
  caymanislands: "开曼群岛",
  bermuda: "百慕大",
  peoplesrepublicofchina: "中国(境内)",
  republicofchina: "中国(境内)",
  prc: "中国(境内)",
  hongkong: "香港",
};

/** 放宽版只在前 800 个紧凑字符内采信（封面标题区），避免正文里的子公司/股东提及误配。 */
const COMPACT_RELAXED_WINDOW = 800;

/**
 * 严格版也只在封面区窗口内采信。
 * 实测：真封面句出现在紧凑文本第 ~466 字符（`incorporatedinthepeoplesrepublicofchina`）；
 * 而正文里「股东基金在开曼注册」之类的提及出现在 ~30 万字符处（`incorporatedinthe…` 变体命中，
 * 2026-09-15 实测被误采信）→ 必须设窗口，否则注册地会被股东主体带偏。
 */
const COMPACT_STRICT_WINDOW = 20_000;

/** 把任意注册地原文归一为展示标签（开曼群岛 / 百慕大 / 中国(境内) / 香港 / 原文）。 */
function labelOfDomicile(raw: string): string {
  const s = (raw ?? "").toLowerCase();
  if (/cayman|開曼|开曼/.test(s)) return "开曼群岛";
  if (/bermuda|百慕大|百慕達/.test(s)) return "百慕大";
  if (/peoples republic of china|republic of china|\bprc\b|中華人民共和國|中华人民共和国/.test(s))
    return "中国(境内)";
  if (/hong kong|香港/.test(s)) return "香港";
  if (/british virgin|bvi|英屬維爾京|英属维尔京/.test(s)) return "英属维尔京群岛";
  return (raw ?? "").trim();
}

/**
 * 从封面页/扉页抽注册地（**只采信封面句式**，不做全文优先级推断——全文提及会假阳性）。
 *
 * 主通道 = **英文封面句式 + 紧凑化匹配**（英文版文档抽取完整）；
 * 兜底 = 中文封面句式（仅当 PDF 中文文本层可用时；港交所申请版本中文常因 CID 抽取失败而拿不到）。
 */
export function extractDomicile(text: string): string | undefined {
  if (!text) return undefined;
  const compact = compactCoverText(text);
  const m =
    COVER_COMPACT_STRICT_RE.exec(compact.slice(0, COMPACT_STRICT_WINDOW)) ??
    COVER_COMPACT_RELAXED_RE.exec(compact.slice(0, COMPACT_RELAXED_WINDOW));
  if (m && m[1]) return COMPACT_JUR_LABEL[m[1]];
  // 兜底：**中文**封面句式（仅当 PDF 有可用中文文本层时；港交所中文版常因 CID 抽取失败而拿不到）。
  // 注意：契约里的前两条 COVER_DOMICILE_PATTERNS 其实是**英文**句式，已由上面的紧凑匹配覆盖，
  // 这里跳过它们，避免绕过封面窗口把正文远处的提及捞回来（2026-09-15 实测踩过）。
  const zhWindow = text.slice(0, 2000);
  for (const re of COVER_DOMICILE_PATTERNS) {
    if (!/[\u4e00-\u9fff]/.test(re.source)) continue;
    const mm = zhWindow.match(re);
    if (mm && mm[1]) return labelOfDomicile(mm[1]);
  }
  return undefined;
}

/** 注册地是否属离岸法域。 */
export function isOffshoreDomicile(domicile: string | undefined): boolean {
  if (!domicile) return false;
  const d = domicile.trim().toLowerCase();
  return OFFSHORE_JURISDICTIONS.some((j) => d.includes(j.toLowerCase()));
}

/**
 * 交易所名称掩码 —— 其中的城市名**不是**运营地线索。
 * 实测（2026-09-15）：`It is a subsidiary of a company listed on the Shenzhen Stock Exchange.`
 * 会让「深圳」被计入广东连接；同类还有「港交所 / 聯交所 / 上海证券交易所」。
 */
const EXCHANGE_NAME_RE =
  /(?:\b(?:shenzhen|shanghai|hong\s*kong|beijing|guangzhou|new\s+york)\s+)?stock\s+exchange|聯交所|联交所|深交所|港交所|證券交易所|证券交易所/gi;

function maskExchangeNames(text: string): string {
  return text.replace(EXCHANGE_NAME_RE, " ");
}

/**
 * 「集团实体语境」判据（**句子级**）——只有落在这种句子里的城市词才算「广东运营连接」。
 *
 * 为什么需要：裸词频会把三类噪音算进来（2026-09-15 实抽：单册 127 次命中里仅 10 次属实体语境）——
 *   ① 董事/高管**住址**（`Unit 1203, Block E … Bao'an District Shenzhen Guangdong Province PRC Chinese Mr.`）
 *   ② 中介机构地址（保荐人/律师楼在深圳、广州）
 *   ③ 交易所名称（深交所）—— 已由 `maskExchangeNames` 先剔除
 *
 * ⚠️ **勿放宽为裸词** `group` / `subsidiary`：red 实测 `Guangzhou Finance Holding **Group** Co., Ltd.`
 *    （第三方名称）与 `It is a **subsidiary** of a company listed on …` 都会被误判为集团自述。
 *    故只认「所属表达」（our / we / 本集团…）。
 */
const ENTITY_CONTEXT_RE = new RegExp(
  [
    // 英文：our + 实体/场所（可带 principal/PRC/wholly-owned 等限定词）
    String.raw`\bour\s+(?:principal\s+|primary\s+|main\s+|major\s+|prc\s+|indirect\s+|wholly[-\s]owned\s+)*(?:subsidiar(?:y|ies)|operating\s+entit(?:y|ies)|entit(?:y|ies)|group|business(?:es)?|operations?|facilit(?:y|ies)|plants?|factor(?:y|ies)|offices?|headquarters?|bases?|sites?|manufactur\w*)`,
    String.raw`\bour\s+Group\b`,
    String.raw`\bwe\s+(?:operate|operates|operated|operating|establish(?:ed|es)?|maintain(?:s|ed)?|conduct(?:s|ed)?|carr(?:y|ies)|have|has|own(?:s|ed)?|hold(?:s)?|are\s+headquartered|are\s+based|are\s+located)`,
    String.raw`\bwholly[-\s]owned\s+(?:subsidiar(?:y|ies)|entit(?:y|ies))`,
    String.raw`\bWFOE\b|wholly\s+foreign[-\s]owned\s+enterprise`,
    String.raw`\bprincipal\s+(?:prc\s+)?(?:operating\s+)?(?:subsidiar(?:y|ies)|entit(?:y|ies))`,
    String.raw`\bthe\s+(?:Company|Group|Issuer)\s+(?:is|was|are|were)\s+(?:headquartered|based|located|principally\s+located|domiciled)`,
    String.raw`\bthe\s+(?:Company|Group|Issuer)\s+(?:operate|operates|conducts|maintains|carries|has|owns)`,
    // 中文：本集团 / 本公司 / 我们（招股书对发行人的自称）
    String.raw`本(?:集团|集團|公司|行)|我们|我們`,
  ].join("|"),
  "i",
);

/** 句子切分（中英混排）：ASCII 终止符后需空白（避免切碎 "1.5"、"No. 9"），中文终止符直接切。 */
function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.;!?])\s+|(?<=[。！？；])/);
}

/**
 * 城市词必须落在所属表达**附近**才采信（前后各 N 字符）。
 * 实测（2026-09-15，108866 河北某产业园 GEM 记录）：招股书表格被抽成一条超长"句子"，
 * 里面既有 `Our Group …` 又有一张投资项目表尾部的「Guangdong Yangjiang」，
 * 若不限距离会把「河北公司」误算成广东连接。真证据（`we operated two manufacturing
 * facilities … located in Dongguan`）与所属表达仅相隔数十字符，窗口 160 足够覆盖。
 */
const CONTEXT_WINDOW = 160;

/** 在给定文本里统计广东城市词命中数（不做语境过滤）。 */
function countCities(text: string): number {
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

/** 广东城市**裸提及**总数（已剔除交易所名称；不含语境门槛，仅供展示/追溯）。 */
export function countGdCityMentions(text: string): number {
  if (!text) return 0;
  return countCities(maskExchangeNames(text));
}

/**
 * 广东连接计数 —— **判定输入**：只统计「集团实体语境」句内、且落在所属表达**邻近窗口**内的
 * 广东城市词。与 `countGdCityMentions` 的差额即噪音（住址 / 中介 / 交易所 / 远处表格等）。
 */
export function countGdCityHits(text: string): number {
  if (!text) return 0;
  const clean = maskExchangeNames(text);
  let hits = 0;
  for (const s of sentencesOf(clean)) {
    const m = ENTITY_CONTEXT_RE.exec(s);
    if (!m) continue;
    const from = Math.max(0, m.index - CONTEXT_WINDOW);
    const to = m.index + m[0].length + CONTEXT_WINDOW;
    hits += countCities(s.slice(from, to));
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
  const gdCityMentions = countGdCityMentions(text);
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
    gdCityMentions,
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
