/**
 * AI 相关性回检（红线 #3 防线 · C4 前置 pass）。
 *
 * 漏斗只做零成本硬排除，相关性准度由本 pass 终审（gzinfo ai_relevant 的等价物）：
 *  1. 参考区条目（category ∈ tech/ipo/gd-ipo/stocks/politics）直接豁免，恒保留；
 *  2. 漏斗已命中商机/风险追踪器的条目（opportunities/risks 非空）跳过 AI，直接保留；
 *  3. 其余条目分批（每批 30 条）一次 LLM 调用做相关性判定，prompt 编码红线 #3：
 *     与「客群/财富管理/私人银行/信贷」相关，或属于国家/省/市级商机政策 → relevant=true。
 *     解析失败的批次整体保留（宁误放不误杀），并计入失败观测（ctx.stats.llmFailures）。
 * 未被 LLM 明确判 false 的条目一律保留（缺答/漏答宁误放不误杀）。
 */
import type { ArticleInput } from "../../contracts/article";
import type { FilterResult, LlmPort, PipelineContext } from "../../contracts/pipeline";

export interface RelevanceDeps {
  llm: LlmPort;
}

export interface RelevanceResult {
  kept: ArticleInput[];
  dropped: number;
}

/** 每批送审条目数。 */
const RECHECK_BATCH_SIZE = 30;

/** 参考区豁免（与 select/funnel 的 REFERENCE_CATEGORIES 口径一致）。 */
const REFERENCE_EXEMPT = new Set(["tech", "ipo", "gd-ipo", "stocks", "politics"]);

/** 按批切块。 */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 构造相关性判定 prompt（红线 #3 口径逐字编码）。 */
function relevancePrompt(batch: ArticleInput[]): string {
  const lines = batch.map(
    (a, i) => `${i}. ${a.url}\n   标题：${a.title}\n   摘要：${a.excerpt.slice(0, 80)}`,
  );
  return [
    "逐条判断以下新闻与招行广州分行业务的相关性。判定规则（红线）：",
    "- 与「客群 / 财富管理 / 私人银行 / 信贷」任一业务相关 → relevant=true；",
    "- 属于国家 / 省 / 市级商机政策（可带来获客、授信、结算、代发等商机）→ relevant=true；",
    "- 其余（纯社会新闻、与上述无关的行业动态等）→ relevant=false。",
    "返回 JSON 数组 [{url, relevant}]，必须覆盖给出的每一条。只返回JSON。",
    "",
    ...lines,
  ].join("\n");
}

/** 解析判定结果并写入 verdicts；解析失败抛错由调用方整批保留。 */
function applyVerdicts(verdicts: Map<string, boolean>, json: string): void {
  const arr = JSON.parse(json) as unknown;
  if (!Array.isArray(arr)) throw new Error("相关性回检返回非数组");
  for (const it of arr) {
    if (it && typeof it === "object" && typeof (it as { url?: unknown }).url === "string") {
      verdicts.set((it as { url: string }).url, Boolean((it as { relevant?: unknown }).relevant));
    }
  }
}

/**
 * 相关性回检入口：豁免判定 → 分批送审 → 汇总裁决。
 * dropped 条数由调用方写入 ctx.stats.recheckDropped 并记日志。
 */
export async function relevanceCheck(
  articles: ArticleInput[],
  ctx: PipelineContext,
  deps: RelevanceDeps,
  filterResults?: Map<string, FilterResult>,
): Promise<RelevanceResult> {
  // ①② 豁免：参考区条目 / 商机风险追踪器命中的条目不送审
  const candidates: ArticleInput[] = [];
  for (const a of articles) {
    if (REFERENCE_EXEMPT.has(a.category)) continue;
    const fr = filterResults?.get(a.url);
    if (fr?.opportunities?.length || fr?.risks?.length) continue;
    candidates.push(a);
  }
  if (candidates.length === 0) return { kept: articles, dropped: 0 };

  // ③ 分批送审
  const verdicts = new Map<string, boolean>();
  for (const batch of chunk(candidates, RECHECK_BATCH_SIZE)) {
    ctx.stats.llmCalls = (ctx.stats.llmCalls ?? 0) + 1;
    try {
      const json = await deps.llm.complete({
        system: "你是招行广州分行每日简报的业务相关性终审编辑，只依据给定规则判定。",
        prompt: relevancePrompt(batch),
        expectJson: true,
        temperature: 0,
      });
      applyVerdicts(verdicts, json);
    } catch (e) {
      // 宁误放不误杀：解析/调用失败的批次整体保留，计入失败观测
      ctx.stats.llmFailures = (ctx.stats.llmFailures ?? 0) + 1;
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log.warn("relevance", `相关性回检批次失败，整批保留（宁误放不误杀）：${msg}`);
    }
  }

  // 汇总：仅明确判 false 的条目被丢弃
  const kept: ArticleInput[] = [];
  let dropped = 0;
  for (const a of articles) {
    if (verdicts.get(a.url) === false) dropped++;
    else kept.push(a);
  }
  return { kept, dropped };
}
