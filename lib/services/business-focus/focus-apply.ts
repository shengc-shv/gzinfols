/**
 * 经营重点加权接线（二期 WP5）。
 *
 * 把「匹配 → 评分」两步合成一个调用，供**候选池排序**（`enrich/exec-pool.ts`）与
 * **必读护栏重排**（`enrich/executive-summary.ts`）共用同一口径 —— 两处各写一遍
 * 必然漂移，而排序口径漂移会直接表现为「池里排第 3、必读里排第 7」。
 *
 * 三条边界（规格 4.1 / 4.5 / 5.4）：
 *  1. `base` 由调用方传入（既有 `scoreBranchRelevance().score`），本模块**不改它**；
 *  2. `focusRelevance` 独立返回、独立保存，⛔ 绝不并入 `importance`；
 *  3. 领域判定只看内容（`classifyBusinessDomain`），不读 sourceId / category（无状态源红线）。
 *
 * 零 LLM、零 IO、零时钟。
 */
import { classifyBusinessDomain } from "../vocab/business-domains";
import { matchFocus, type FocusMatch } from "./focus-matcher";
import { scoreFocus, type FocusScoreResult } from "./focus-scoring";
import type { FocusItem } from "./types";

export interface FocusApplyInput {
  title: string;
  /** 采集侧原文摘要（excerpt）。⛔ 不要传 AI 摘要（S5 自证问题）。 */
  excerpt?: string;
  /** 已知领域（不传则按内容现场判定）。 */
  domains?: readonly string[];
}

export interface FocusApplyResult extends FocusScoreResult {
  /** 全部命中（含被忽略的第 3+ 个），供详情页解释。 */
  matches: FocusMatch[];
  /** 判定出的领域（空数组 = 与六大领域均无关联）。 */
  domains: string[];
}

/** 一条资讯的经营重点加权。无生效重点时退化为「原样返回 base」。 */
export function applyFocus(
  input: FocusApplyInput,
  base: number,
  focuses: readonly FocusItem[],
): FocusApplyResult {
  const plain: FocusApplyResult = {
    focusRelevance: 0,
    finalScore: base,
    counted: [],
    guards: [],
    matches: [],
    domains: [...(input.domains ?? [])],
  };
  if (!focuses.length || !input.title?.trim()) return plain;

  const domains = input.domains?.length
    ? [...input.domains]
    : (() => {
        const d = classifyBusinessDomain({ title: input.title, summary: input.excerpt ?? "" });
        return d ? [d.primary_domain, ...d.related_domains] : [];
      })();

  const matches = matchFocus(
    {
      title: input.title,
      ...(input.excerpt?.trim() ? { excerpt: input.excerpt } : {}),
      domains,
    },
    focuses,
  );
  const scored = scoreFocus({ base, matches }, focuses);
  return { ...scored, matches, domains };
}

/** 首页/详情页用的一行短标签（规格 5.2：一条最多两个，且分层级）。 */
export function focusBadges(result: FocusApplyResult, limit = 2): Array<{ label: string; layer: FocusItem["layer"] }> {
  return result.counted.slice(0, limit).map((c) => ({ label: c.match.name, layer: c.match.layer }));
}
