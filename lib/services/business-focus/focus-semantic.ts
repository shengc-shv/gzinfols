/**
 * 经营重点 · AI 语义细化（二期 WP11 · 2026-11-28）· **默认关闭**。
 *
 * 存在理由：规则匹配只看词面，同一件事换个说法就会漏 —— 重点词写「AUM」，
 * 稿子写「日均资产规模」；重点写「私行」，稿子写「财富顾问团队服务超高净值客户」。
 * 这类漏召回靠加词解决不了（词表越加越泛，最后连宏观稿都命中）。
 *
 * 🔴 三条硬边界（写在前面，改这个文件前先读）：
 *  1. **只对规则已给出 M1/M2 的候选做二次判定**：M0（完全没信号）不进候选，
 *     M3（精准命中）不需要复核。这样 AI 永远只在「规则说有戏、但没说多准」的
 *     窄带上发言，把风险面压到最小；
 *  2. **只升不降**：AI 说 `core` 才把 M2 提到 M3、说 `related` 才把 M1 提到 M2；
 *     AI 说「不相关」**不降级**——规则命中是可核对的确定性证据（词就在标题里），
 *     单次模型输出的否定不足以推翻它；
 *  3. **不参与排序**：升级只改 `focus_hits` 的等级与理由（展示口径），
 *     `bonus` 仍取排序侧真实折算值。否则会出现「卡片按加 15 分显示、
 *     实际只加了 10 分」的账实不符。
 *
 * 成本：单次调用（≤30 条候选 × ≤12 条重点定义），失败/超时一律**退回规则结果**，
 * 绝不让日报因为一个可选增强挂掉（日报是唯一交付物）。
 */
import type { LlmPort } from "../../contracts/pipeline";
import type { Logger } from "../../contracts/pipeline";
import type { FocusItem } from "./types";
import { FOCUS_BONUS_TABLE } from "./types";

/** 一条候选（规则已判 M1/M2 的条目）。 */
export interface FocusSemanticCandidate {
  /** 标题（与 `FocusMatch` 判定输入同一个字段，作 map 的键）。 */
  title: string;
  /** 规则给出的最高等级（M1 或 M2）。 */
  level: "M1" | "M2";
  /** 规则命中的重点 id（只复核这些，不引入新重点）。 */
  focusIds: string[];
}

/** AI 对某条资讯某个重点的裁定。 */
export interface FocusSemanticVerdict {
  focusId: string;
  /** core = 主体就是这件事（M3）；related = 高度相关但非主体（M2）。 */
  level: "M2" | "M3";
  /** ≤20 字的理由（进 reason，读者可核对）。 */
  reason: string;
}

/** title → 裁定列表。用标题作键：打标只读标题，同一批数据里标题重复概率极低。 */
export type FocusSemanticMap = Map<string, FocusSemanticVerdict[]>;

/** 单次最多送多少条候选（30 条 ≈ 1.5K 字符，成本可控；多出来的留到下期自然出现）。 */
export const MAX_SEMANTIC_CANDIDATES = 30;
/** 单次最多带多少条重点定义（当前生效只有 7 条，留余量）。 */
export const MAX_SEMANTIC_FOCUSES = 12;
/** 标题截断长度（超长标题的后半段对语义判断几乎没有增量信息）。 */
const TITLE_CLIP = 90;

const SYSTEM = `你是银行零售业务的资深分析师，长期跟进某股份行广州分行的经营重点。
你的任务是判断「一条资讯」与「一个经营重点」是否真的相关，而不是看字面像不像。
只输出 JSON，不要解释，不要 markdown 代码块。`;

/** 构造 prompt（纯函数，可单测）。 */
export function buildSemanticPrompt(
  candidates: readonly FocusSemanticCandidate[],
  focuses: readonly FocusItem[],
): { system: string; prompt: string } {
  const fs = focuses.slice(0, MAX_SEMANTIC_FOCUSES);
  const defined = fs
    .map((f) => {
      const concepts = [...f.concepts].slice(0, 6).join("、");
      const domains = f.domains.join("、");
      const desc = (f.description || "").replace(/\s+/g, " ").slice(0, 60);
      return `- ${f.id}｜${f.name}｜领域: ${domains || "不限"}${desc ? `｜要点: ${desc}` : ""}${
        concepts ? `｜相关概念: ${concepts}` : ""
      }`;
    })
    .join("\n");
  const list = candidates
    .map((c, i) => `[${i}] ${c.title.replace(/\s+/g, " ").slice(0, TITLE_CLIP)}`)
    .join("\n");

  const prompt = `## 本行当前经营重点
${defined}

## 待判断的资讯标题
${list}

## 判断标准
- core：这条资讯的**主体**就是该重点关注的业务（例如重点「AUM 规模与结构优化」× 资讯「明年日均 AUM 增长 35%，银行开门红之战开启」）。
- related：与该重点实质相关、可作为经营判断依据，但不是主体（例如重点「小微普惠金融」× 资讯「大行普惠小微贷款余额同比增 20%」）。
- 不相关：只是词面沾边、行业行情、与零售经营无关的宏观消息 —— **不要输出这条**。

宁缺毋滥：不确定就不要输出。每条资讯最多给 1 个重点裁定。

## 输出格式（严格 JSON）
{"hits":[{"i":0,"f":"重点id","v":"core","r":"不超过20字的理由"}]}`;

  return { system: SYSTEM, prompt };
}

/**
 * 解析模型输出（纯函数，可单测）。
 *
 * 容错口径：未知 index / 未知重点 id / 非法等级一律丢弃，绝不「猜一个」——
 * 一次错误的语义升级会在首页贴出错误标签，比漏升贵得多。
 */
export function parseSemanticVerdicts(
  raw: string,
  candidates: readonly FocusSemanticCandidate[],
  allowed: ReadonlySet<string>,
): FocusSemanticMap {
  const out: FocusSemanticMap = new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { hits?: unknown })?.hits)
      ? ((parsed as { hits: unknown[] }).hits as unknown[])
      : [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const row = r as { i?: unknown; f?: unknown; v?: unknown; r?: unknown };
    const i = Number(row.i);
    if (!Number.isInteger(i) || i < 0 || i >= candidates.length) continue;
    const cand = candidates[i];
    const focusId = typeof row.f === "string" ? row.f.trim() : "";
    // 只接受「该条规则本来就命中过的重点」：AI 不得凭空引入新重点
    if (!focusId || !allowed.has(focusId) || !cand.focusIds.includes(focusId)) continue;
    const v = row.v === "core" ? "M3" : row.v === "related" ? "M2" : null;
    if (!v) continue;
    const reason = typeof row.r === "string" ? row.r.replace(/\s+/g, " ").slice(0, 40) : "";
    const list = out.get(cand.title) ?? [];
    // 同一标题同一重点只保留更高的一条
    const existed = list.findIndex((x) => x.focusId === focusId);
    const verdict: FocusSemanticVerdict = { focusId, level: v, reason };
    if (existed >= 0) {
      if (v === "M3") list[existed] = verdict;
    } else {
      list.push(verdict);
    }
    out.set(cand.title, list);
  }
  return out;
}

/** 候选是否值得送模型：规则给了 M1/M2 且确实命中了某个重点。 */
export function isSemanticCandidate(level: string, focusIds: readonly string[]): boolean {
  return (level === "M1" || level === "M2") && focusIds.length > 0;
}

/**
 * 调一次模型做语义细化。任何异常/超时 → 返回空 Map（调用方按规则结果继续）。
 * @param candidates 只应包含 M1/M2 候选（调用方过滤好）
 */
export async function refineFocusWithAi(opts: {
  candidates: readonly FocusSemanticCandidate[];
  focuses: readonly FocusItem[];
  llm: LlmPort;
  log?: Logger;
  maxCandidates?: number;
}): Promise<FocusSemanticMap> {
  const { candidates, focuses, llm, log } = opts;
  if (!candidates.length || !focuses.length) return new Map();
  const cap = Math.max(1, Math.floor(opts.maxCandidates ?? MAX_SEMANTIC_CANDIDATES));
  const picked = candidates.slice(0, cap);
  const allowed = new Set(focuses.slice(0, MAX_SEMANTIC_FOCUSES).map((f) => f.id));
  const { system, prompt } = buildSemanticPrompt(picked, focuses);
  try {
    const raw = await llm.complete({
      system,
      prompt,
      expectJson: true,
      temperature: 0,
      maxTokens: 900,
      stage: "classify",
    });
    const map = parseSemanticVerdicts(raw, picked, allowed);
    const upgraded = [...map.values()].reduce((n, list) => n + list.length, 0);
    log?.info(
      "focus",
      `AI 语义细化：候选 ${picked.length} 条，确认 ${upgraded} 处（开关 FOCUS_AI_MATCH，默认关）`,
    );
    return map;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log?.warn("focus", `AI 语义细化失败，退回规则判定：${msg}`);
    return new Map();
  }
}

/**
 * 把 AI 裁定合并进规则命中（只升不降、不改 bonus）。
 *
 * 返回新的 matches 数组（不 mutate 入参）。`matchLevel` 变了，但 `focusRelevance`
 * 与 `bonus` 仍是排序侧算出的真实值 —— 展示层只说「更准了」，不改账。
 */
export function applySemanticUpgrade<
  T extends { focusId: string; matchLevel: "M1" | "M2" | "M3"; reason: string },
>(matches: readonly T[], verdicts: readonly FocusSemanticVerdict[] | undefined): T[] {
  if (!verdicts?.length) return matches as T[];
  return matches.map((m) => {
    const v = verdicts.find((x) => x.focusId === m.focusId);
    if (!v) return m;
    // 只升不降：把等级数值化比较（M3 最高）
    const rank = { M1: 1, M2: 2, M3: 3 } as const;
    if (rank[v.level] <= rank[m.matchLevel]) return m;
    return {
      ...m,
      matchLevel: v.level,
      reason: `${m.reason}；AI 语义确认${v.reason ? `：${v.reason}` : ""}`,
    };
  });
}

/** 升级后的等级对应的基准加分（仅供调试/日志核对，不用于账目）。 */
export function baseBonusOf(layer: FocusItem["layer"], level: "M1" | "M2" | "M3"): number {
  return FOCUS_BONUS_TABLE[layer][level];
}
