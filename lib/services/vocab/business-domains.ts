/**
 * 六大经营领域（第一期，PRD 三章 / 规格书 3.1）。
 *
 * 数据真源 = config/business-domains.json（静态 import，零运行时 IO、零 LLM）。
 * 与五大内容分类 gz_local/biz_insight/policy_market/tech/ipo **正交**：
 * 本模块只回答「这条内容属于哪个经营领域」，不碰 section 归属、不改数据源分类。
 *
 * 判定口径（无状态源红线）：只看**内容**（标题 + 摘要 + 既有业务标签），
 * 绝不读 sourceId / category / subcategory 等采集元数据。
 * 每条可有多个相关领域，但主领域唯一（按命中数降序 + 配置顺序稳定破解平局）。
 */
import domainConfig from "../../../config/business-domains.json";

export interface BusinessDomain {
  id: string;
  name: string;
  short: string;
  keywords: readonly string[];
  exclude: readonly string[];
  /**
   * 二级主题（二期 WP10 · 2026-11-28）。
   *
   * 🔴 **只用于领域专题页分组展示**，不参与 `classifyBusinessDomain` 的判定，
   * 也不回写报告的 `primary_domain` —— 判定面一旦变宽，历史报告的领域标签就会漂。
   */
  subtopics: readonly { name: string; keywords: readonly string[] }[];
  /** 相关客群（展示用） */
  segments: readonly string[];
  /** 相关产品（展示用） */
  products: readonly string[];
  /** 典型事件类型（展示用） */
  event_types: readonly string[];
  /** 机会/风险类型（展示用） */
  opportunity_risk: { opportunity: readonly string[]; risk: readonly string[] };
}

export const BUSINESS_DOMAINS: readonly BusinessDomain[] = domainConfig.domains.map((d) => ({
  id: d.id,
  name: d.name,
  short: d.short,
  keywords: d.keywords,
  exclude: d.exclude,
  subtopics: d.subtopics ?? [],
  segments: d.segments ?? [],
  products: d.products ?? [],
  event_types: d.event_types ?? [],
  opportunity_risk: d.opportunity_risk ?? { opportunity: [], risk: [] },
}));

export const DOMAIN_IDS = BUSINESS_DOMAINS.map((d) => d.id);

/** 中文关键词防跨词误配：配置里 exclude 命中的词要先整体剔除，再做子串匹配。 */
function stripExcludes(text: string, excludes: readonly string[]): string {
  let out = text;
  for (const bad of excludes) if (bad) out = out.split(bad).join("");
  return out;
}

/**
 * 领域归属纯函数。
 * 输入只接收内容字段（title / summary / tags），不接收任何采集元数据。
 * 返回 null 表示该条内容与六大领域均无可靠关联——不硬凑、不默认塞「区域同业」。
 */
export function classifyBusinessDomain(input: {
  title?: string | null;
  summary?: string | null;
  tags?: readonly string[] | null;
}): { primary_domain: string; related_domains: string[] } | null {
  const text = stripExcludes(
    `${input.title ?? ""} ${input.summary ?? ""} ${(input.tags ?? []).join(" ")}`,
    BUSINESS_DOMAINS.flatMap((d) => d.exclude),
  );
  if (!text.trim()) return null;
  const scored = BUSINESS_DOMAINS.map((d, idx) => ({
    id: d.id,
    hits: d.keywords.reduce((n, kw) => (kw && text.includes(kw) ? n + 1 : n), 0),
    idx,
  })).filter((s) => s.hits > 0);
  if (!scored.length) return null;
  scored.sort((a, b) => b.hits - a.hits || a.idx - b.idx);
  return {
    primary_domain: scored[0].id,
    related_domains: scored.slice(1).map((s) => s.id),
  };
}

/**
 * 板块级兜底（2026-11-28 sc：「IPO 至少兜底可以算经营线索」）。
 *
 * 🔴 只处理**词表判不出领域**的条目（null 分支）：不参与打分、不动 keywords、
 * 不回写既有非空判定 —— 历史报告的领域标签因此不会漂。
 *
 * 目前只有 IPO，理由：拟上市企业本身是对公获客对象，其企业主/董监高（股权激励、
 * 减持、并购）又是私行客源，所以主领域取「客户经营与客群增长」、相关领域带「财富管理与AUM」。
 *
 * ⛔ 不要改成「把 IPO 相关词加进各领域 keywords」：那会把「IPO 审核节奏收紧」这类
 * 政策稿也拽进客户经营，判定面一宽就再也收不回来。
 */
export const SECTION_FALLBACK_DOMAIN: Readonly<
  Record<string, { primary: string; related: readonly string[] }>
> = {
  ipo: { primary: "customer_growth", related: ["wealth_aum"] },
};

/**
 * 领域归属（带板块兜底）：先按内容词表判定，判不出再看板块是否有兜底。
 *
 * `section` 只用于**兜底选择**，不参与词表打分（无状态源红线：判定仍只看内容）。
 * 兜底 id 不存在于配置时返回 null —— 宁可留空，也不写脏值进报告。
 */
export function classifyBusinessDomainWithFallback(
  input: {
    title?: string | null;
    summary?: string | null;
    tags?: readonly string[] | null;
  },
  section?: string | null,
): { primary_domain: string; related_domains: string[] } | null {
  const hit = classifyBusinessDomain(input);
  if (hit) return hit;
  const fb = section ? SECTION_FALLBACK_DOMAIN[section] : undefined;
  if (!fb) return null;
  if (!DOMAIN_IDS.includes(fb.primary)) return null;
  return {
    primary_domain: fb.primary,
    related_domains: fb.related.filter((x) => x !== fb.primary && DOMAIN_IDS.includes(x)),
  };
}

/**
 * 领域内二级主题归类（二期 WP10 · 纯展示）。
 *
 * 🔴 只服务领域专题页的分组，**不参与生产判定**：`primary_domain` 仍只由
 * `classifyBusinessDomain`（keywords/exclude）决定。这里多命中一个词只会让专题页
 * 把这条放到另一个二级分组里，绝不改变报告里的领域标签与排序。
 *
 * 口径：命中数最多者胜；平局按配置顺序（与主领域判定同一条破平局规则）；
 * 一个都不命中返回 null（页面归入「其他」，不硬凑）。
 */
export function classifySubtopic(
  domainId: string,
  input: { title?: string | null; summary?: string | null; tags?: readonly string[] | null },
  opts: { minHits?: number } = {},
): string | null {
  const minHits = Math.max(1, Math.floor(opts.minHits ?? 1));
  const domain = BUSINESS_DOMAINS.find((d) => d.id === domainId);
  if (!domain || !domain.subtopics.length) return null;
  const text = stripExcludes(
    `${input.title ?? ""} ${input.summary ?? ""} ${(input.tags ?? []).join(" ")}`,
    domain.exclude,
  );
  if (!text.trim()) return null;
  let best: { name: string; hits: number; idx: number } | null = null;
  domain.subtopics.forEach((sub, idx) => {
    const hits = sub.keywords.reduce((n, kw) => (kw && text.includes(kw) ? n + 1 : n), 0);
    if (hits < minHits) return;
    if (!best || hits > best.hits) best = { name: sub.name, hits, idx };
  });
  return best ? (best as { name: string }).name : null;
}
