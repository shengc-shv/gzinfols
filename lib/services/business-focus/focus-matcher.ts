/**
 * 经营重点规则预匹配（二期 WP3 · 规格 3.3 / 9.2 focus-matcher）。
 *
 * 分层匹配的第一层：**纯规则、确定性、零 LLM**。
 * 只回答「这条资讯与当前生效的哪个重点有关、有多有关、依据是什么」，
 * 不做加分（加分在 `focus-scoring.ts`），不改任何报告字段。
 *
 * 🔴 四条硬口径（验收要求「不因关键词偶然出现就判高度相关」）：
 *  1. **排除词一票否决**：命中 `exclude_keywords` 直接 M0（如「金价」不得算「黄金配置」）；
 *  2. **领域只能升级，不能单独构成命中**：领域是宽分类（「黄金」→ 财富、`金融监管` → 风险管理），
 *     光靠领域对上就产出一条命中，等于「每条资讯都命中每个重点」。
 *     11-30 实测（30 天 1234 条标题）：「代发客户向财富客户转化」词表在真实标题里几乎零出现，
 *     却因领域匹配命中 248 条；「重点监管政策跟踪」命中 206 条 —— 首页「本期经营重点」的
 *     「当日相关情报数量」会直接退化成「当日总条数」，该模块失去信息量。
 *     故：**无任何词面/概念信号 → M0**，领域只作为 M2/M3 的必要条件或升级条件。
 *  3. **M3 必须在标题命中**核心词或 ≥2 个关键词，**且**领域匹配；
 *     只命中摘要不算精准命中（摘要常带上下文，容易误配）；
 *  4. **M2 必须有概念级佐证**：≥2 个关联概念，或「领域匹配 + 1 词 + 1 概念」；
 *     只有词面（哪怕领域对）最多 M1 —— 这是「关键词偶然出现」与「高度相关」的分界线。
 *
 * 输入只用**采集侧原文**（title / excerpt），绝不喂 AI 摘要（S5 同款自证问题）。
 */
import type { FocusItem, FocusMatchLevel } from "./types";

/** 匹配输入：一条资讯的可判定文本与领域归属。 */
export interface FocusMatchInput {
  title: string;
  /** 采集侧原文摘要（excerpt）；无则不传，**不要传 AI 生成的 summary**。 */
  excerpt?: string;
  /** 该条命中的领域 id（primary_domain + related_domains）。 */
  domains?: readonly string[];
}

/** 单条命中（`level` 至少 M1；M0 不产出）。 */
export interface FocusMatch {
  focusId: string;
  /** 命中时的重点名称快照：配置改名后历史命中记录仍能读懂。 */
  name: string;
  layer: FocusItem["layer"];
  grade: FocusItem["grade"];
  matchLevel: Exclude<FocusMatchLevel, "M0">;
  /** 命中依据（写入页面与日报，读者可核对）。 */
  reason: string;
  /** 命中的原文片段（每段 ≤30 字，供详情页展示证据）。 */
  evidence: string[];
  /** 结构化信号，供评分器与调试使用。 */
  signals: {
    /** 标题命中的核心词 */
    core: string[];
    /** 标题命中的一般关键词/同义词 */
    keywords: string[];
    /** 标题+原文命中的关联概念 */
    concepts: string[];
    /** 领域是否匹配 */
    domainMatched: boolean;
  };
}

/** 证据片段截断长度（中文字符）。 */
const EVIDENCE_MAX = 30;

function snippet(text: string, word: string): string {
  const i = text.indexOf(word);
  if (i < 0) return "";
  const start = Math.max(0, i - 8);
  const end = Math.min(text.length, i + word.length + 12);
  return text.slice(start, end).replace(/\s+/g, " ").trim().slice(0, EVIDENCE_MAX);
}

function hits(words: readonly string[], text: string): string[] {
  return words.filter((w) => w && text.includes(w));
}

/**
 * 对一条资讯做全量重点匹配。
 *
 * @param input 资讯文本与领域
 * @param focuses 当前生效的经营重点（`FocusConfigResult.active`）
 * @returns 命中列表（按匹配等级降序，同级按配置顺序），M0 不返回
 */
export function matchFocus(input: FocusMatchInput, focuses: readonly FocusItem[]): FocusMatch[] {
  const title = (input.title ?? "").trim();
  if (!title || !focuses.length) return [];
  const excerpt = (input.excerpt ?? "").trim();
  const body = excerpt ? `${title} ${excerpt}` : title;
  const domains = new Set(input.domains ?? []);

  const out: FocusMatch[] = [];
  for (const f of focuses) {
    // ① 排除词一票否决（标题与原文都看：原文里出现「金价」同样不该算财富重点）
    if (f.exclude_keywords.some((w) => w && body.includes(w))) continue;

    const core = hits(f.core_keywords, title);
    const keywords = hits([...f.keywords, ...f.synonyms], title);
    const concepts = hits(f.concepts, body);
    const domainMatched = f.domains.some((d) => domains.has(d));

    let level: Exclude<FocusMatchLevel, "M0"> | null = null;
    // M3 精准命中：词面够强 + 领域对得上
    if (domainMatched && (core.length > 0 || keywords.length >= 2)) level = "M3";
    // M2 高度相关：必须有概念级佐证（≥2 概念，或领域 + 1 词 + 1 概念）
    else if (concepts.length >= 2 || (domainMatched && keywords.length >= 1 && concepts.length >= 1)) level = "M2";
    // M1 间接相关：有明确的词面/概念信号（领域只作升级，不单独构成命中）
    else if (core.length > 0 || keywords.length >= 1 || concepts.length >= 1) level = "M1";
    if (!level) continue;

    const parts: string[] = [];
    if (core.length) parts.push(`标题命中核心词「${core.join("、")}」`);
    if (keywords.length) parts.push(`标题命中关键词「${keywords.join("、")}」`);
    if (concepts.length) parts.push(`关联概念「${concepts.join("、")}」`);
    parts.push(domainMatched ? `领域匹配（${f.domains.filter((d) => domains.has(d)).join("、")}）` : "领域未匹配");

    const evidence: string[] = [];
    for (const w of [...core, ...keywords, ...concepts].slice(0, 3)) {
      const s = snippet(body, w);
      if (s && !evidence.includes(s)) evidence.push(s);
    }

    out.push({
      focusId: f.id,
      name: f.name,
      layer: f.layer,
      grade: f.grade,
      matchLevel: level,
      reason: parts.join("，"),
      evidence,
      signals: { core, keywords, concepts, domainMatched },
    });
  }

  const order: Record<Exclude<FocusMatchLevel, "M0">, number> = { M3: 0, M2: 1, M1: 2 };
  return out.sort((a, b) => order[a.matchLevel] - order[b.matchLevel]);
}
