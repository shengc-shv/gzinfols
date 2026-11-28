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
}

export const BUSINESS_DOMAINS: readonly BusinessDomain[] = domainConfig.domains.map((d) => ({
  id: d.id,
  name: d.name,
  short: d.short,
  keywords: d.keywords,
  exclude: d.exclude,
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
