/**
 * Pass 2 — AI 总编辑成稿（文档第 6 节）。
 *
 * 必须单次调用拿到全量保留条目（去重与 importance 全局分布无法在分批下完成）。
 * 输入条目含 raw_text（证据校验需要，上下文过长是二次截断到 600 字）。
 * AI 只新增 summary + importance；url/title_cn/title_orig/source/source_type/
 * date/tags/locale/locale_evidence 及板块归属照抄 kept（PASS1 判定）。
 *
 * 返回后由管线调用 _ensure_schema + finalize_ranks，再跑 13 条校验。
 */
import { extractJson } from "./json-util";
import { ALLOWED_TAGS, SECTIONS } from "./validator";
import { buildPass2User, PASS2_SYSTEM } from "./prompts";
import { rollUpTags } from "./tag-rollup";
import { dedupeSections } from "./dedupe-sections";
import { type LlmRunner } from "./pass1";
import type {
  DailyReport,
  ReportItem,
  ReportSectionKey,
} from "../../contracts/report";

/**
 * Pass2 输入 raw_text 截断上限。
 * 2026-09-15（Token 优化 · 死配置对齐）：原值 600 恒不生效——PASS1 已把 raw_text
 * 截到 ≤PASS1_RAW_CAP（450→300），二次截断到 600 永不触发，原注释「上下文过长是二次
 * 截断到 600 字」误导。现改为 200 使其真正生效：PASS1 已通读全文并给出标题/标签/属地，
 * PASS2 只写 ≤50 字摘要，200 字作事实锚足够；每条约省 100~250 字，且不再与 PASS1
 * 重复传同一段正文。
 */
const PASS2_INPUT_TRUNCATE = 200;

let injectedRunner2: LlmRunner | undefined;
/** 组合根注入默认 runner（PASS2_MODEL 覆盖在适配器侧处理）。 */
export function setDefaultPass2Runner(runner: LlmRunner): void {
  injectedRunner2 = runner;
}
const defaultRunner: LlmRunner = (systemPrompt, userPrompt) => {
  if (!injectedRunner2) throw new Error("pass2 默认 runner 未注入（组合根未装配 LlmPort）");
  return injectedRunner2(systemPrompt, userPrompt);
};

function normalizeImportance(i: unknown): 1 | 2 | 3 {
  return i === 3 || i === 1 ? i : 2;
}
function normalizeTags(t: unknown): string[] {
  if (!Array.isArray(t)) return [];
  const allowed = new Set<string>(ALLOWED_TAGS);
  return Array.from(new Set(t.filter((x) => allowed.has(String(x))))).slice(0, 6);
}

function assembleItem(kept: KeptLookup, ai: any): ReportItem {
  const base = kept.base;
  return {
    url: base.url,
    title_cn: (ai?.title_cn || base.title_cn || "").trim() || base.title_cn,
    title_orig: ai?.title_orig ?? base.title_orig,
    source: base.source,
    source_type: base.source_type,
    date: base.date,
    summary: (ai?.summary || "").trim(),
    importance: normalizeImportance(ai?.importance),
    rank: 0,
    tags: rollUpTags({ tags: normalizeTags(ai?.tags ?? base.tags) }),
    locale: base.locale,
    locale_evidence: base.locale_evidence,
  };
}

interface KeptLookup {
  base: import("./pass1").Pass1Item;
}

/**
 * 运行 Pass 2：单次调用产出终稿。返回已补全 schema 但未 rank 的报告
 * （rank 由管线 finalizeRanks 生成）。
 */
export async function runPass2(
  kept: import("./pass1").Pass1Item[],
  runner: LlmRunner = defaultRunner,
  feedback?: string,
  prefill?: Map<string, string>,
): Promise<DailyReport> {
  const byUrl = new Map(kept.map((k) => [k.url, k]));

  // 预分析缓存复用（全 AI 模式下由上游传入 prefillCache）：
  // 命中 pre1 打标（ai_relevant=true 且已有 summary）的条目直接确定性组装，
  // 不进 LLM payload —— 省 token + 保证 summary 一致性；LLM 失败时也保留，不丢缓存成果。
  const cached = prefill ? kept.filter((k) => prefill.has(k.url)) : [];
  const cachedUrls = new Set(cached.map((k) => k.url));
  const fresh = kept.filter((k) => !cachedUrls.has(k.url));

  const emptySections = (): DailyReport["sections"] => ({
    gz_local: [],
    biz_insight: [],
    policy_market: [],
    tech: [],
    ipo: [],
  });

  // 确定性组装缓存命中条目（section 沿用 PASS1 已判定的 base.section）
  const buildCachedSections = (): DailyReport["sections"] => {
    const sections = emptySections();
    for (const k of cached) {
      const summary = (prefill!.get(k.url) ?? "").trim();
      if (!summary) continue;
      const item: ReportItem = {
        url: k.url,
        title_cn: (k.title_cn || k.title || "").trim() || k.title,
        title_orig: k.title_orig,
        source: k.source,
        source_type: k.source_type,
        date: k.date,
        summary,
        importance: 2,
        rank: 0,
        tags: rollUpTags({ tags: normalizeTags(k.tags) }),
        locale: k.locale,
        locale_evidence: k.locale_evidence,
      };
      if (SECTIONS.includes(k.section)) sections[k.section].push(item);
    }
    return sections;
  };

  const heroFallback = (): string =>
    cached[0]
      ? `今日关注：${cached[0].title_cn || cached[0].title_orig || ""}`.slice(0, 70)
      : "";

  // 全部命中缓存 → 完全跳过 LLM 调用（省一整次 PASS2）
  if (fresh.length === 0) {
    return {
      date: "",
      hero_line: heroFallback(),
      must_read: [],
      insights: [],
      sections: buildCachedSections(),
    };
  }

  // 短 id 替代长 url（2026-09-15 Token 优化，与 PASS1 同思路）：payload 用 id、响应按 id 回填，
  // 由 ctx.resolveUrl 解析回 url（url 仍是唯一真源，业务字段一律以池为准）。
  const idToUrl = new Map<string, string>();
  const payload = fresh.map((k, i) => {
    const id = `b${i + 1}`;
    idToUrl.set(id, k.url);
    return {
      id,
      title_cn: k.title_cn,
      title_orig: k.title_orig,
      source: k.source,
      source_type: k.source_type,
      date: k.date,
      tags: k.tags,
      locale: k.locale,
      locale_evidence: k.locale_evidence,
      section: k.section,
      raw_text: k.raw_text.slice(0, PASS2_INPUT_TRUNCATE),
    };
  });
  const userPrompt = buildPass2User(JSON.stringify(payload), feedback);
  let parsed: any = {};
  try {
    const raw = await runner(PASS2_SYSTEM, userPrompt, { resolveUrl: (key) => idToUrl.get(key) });
    const cleaned = extractJson(raw);
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const { jsonrepair } = await import("jsonrepair");
      parsed = JSON.parse(jsonrepair(cleaned));
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // LLM 失败 → 回退仅保留缓存命中条目（不丢预分析成果）
    console.warn(`[pass2] 调用失败，回退仅缓存条目（${cached.length} 条）: ${msg}`);
    return {
      date: "",
      hero_line: heroFallback(),
      must_read: [],
      insights: [],
      sections: buildCachedSections(),
    };
  }

  const sections = emptySections();
  for (const sec of SECTIONS) {
    const arr = parsed?.sections?.[sec];
    if (!Array.isArray(arr)) continue;
    for (const ai of arr) {
      // key 解析：优先 id（新格式），回退 url（旧格式 / replay 夹具 / dump 占位）
      const url =
        ai && typeof ai.id === "string" && ai.id
          ? idToUrl.get(ai.id)
          : ai && typeof ai.url === "string"
            ? ai.url
            : undefined;
      if (!url) continue;
      if (cachedUrls.has(url)) continue; // 防御：LLM 不应返回缓存命中条目
      const base = byUrl.get(url);
      if (!base) continue; // 池外 url 不纳入（R1 兜底）
      sections[sec].push(assembleItem({ base }, ai));
    }
  }
  // 合并缓存命中条目（无论 LLM 成败都保留）
  const cachedSections = buildCachedSections();
  for (const sec of SECTIONS) sections[sec].push(...cachedSections[sec]);

  // 扎口：跨板块去重（2026-08-29）——同一事件只在一个板块出现，
  // 避免房贷40年这类政策同时出现在政策/商机/股市等多个板块。
  dedupeSections(sections);

  const insights = Array.isArray(parsed?.insights)
    ? parsed.insights
        .filter((x: any) => x && typeof x === "object")
        .slice(0, 5)
        .map((x: any) => ({
          topic: String(x.topic ?? ""),
          tags: normalizeTags(x.tags),
          impact: String(x.impact ?? ""),
          action: String(x.action ?? ""),
          ...(x.related_url ? { related_url: String(x.related_url) } : {}),
        }))
    : [];

  const must_read = Array.isArray(parsed?.must_read)
    ? parsed.must_read
        .filter((x: any) => x && typeof x.url === "string")
        .slice(0, 5)
        .map((x: any) => ({ url: String(x.url), why: String(x.why ?? ""), ...(x.title ? { title: String(x.title) } : {}) }))
    : [];

  return {
    date: "",
    hero_line: typeof parsed?.hero_line === "string" ? parsed.hero_line : "",
    must_read,
    insights,
    sections,
  };
}

/** _ensure_schema：补齐缺失键，保证后续校验/渲染不崩。 */
export function ensureSchema(report: DailyReport): void {
  if (typeof report.date !== "string") report.date = "";
  if (typeof report.hero_line !== "string") report.hero_line = "";
  if (!Array.isArray(report.must_read)) report.must_read = [];
  if (!Array.isArray(report.insights)) report.insights = [];
  if (!report.sections || typeof report.sections !== "object") {
    report.sections = {
      gz_local: [],
      biz_insight: [],
      policy_market: [],
      tech: [],
      ipo: [],
    };
  }
  for (const sec of SECTIONS) {
    if (!Array.isArray(report.sections[sec])) report.sections[sec] = [];
  }
}

/**
 * finalize_ranks：rank 由代码生成，不交给模型。
 * 板块内按 importance 降序、must_read 命中优先、同级保持 AI 原序（list.sort 稳定），
 * 编号从 1。返回是否变更（便于测试）。
 */
export function finalizeRanks(report: DailyReport): void {
  const mustSet = new Set(report.must_read.map((m) => m.url).filter(Boolean));
  for (const sec of SECTIONS) {
    const items = report.sections[sec];
    items.sort((a, b) => {
      const am = mustSet.has(a.url) ? 1 : 0;
      const bm = mustSet.has(b.url) ? 1 : 0;
      if (am !== bm) return bm - am; // must_read 优先
      return (b.importance ?? 2) - (a.importance ?? 2); // importance 降序
    });
    items.forEach((it, i) => (it.rank = i + 1));
  }
}
