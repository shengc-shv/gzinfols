/**
 * 经营重点评分与封顶（二期 WP4 · 规格 4.2–4.5 / 9.2 focus-scoring）。
 *
 * 输出三个**互相独立**的量（规格 5.4：不能把加权写成新闻本身的重要性）：
 *   baseScore       基础重要性分 = 既有 `scoreBranchRelevance().score`（0–100，本模块不改）
 *   focusRelevance  经营关注度分（0–30，本模块产出，独立保存）
 *   finalScore      = base + focusRelevance（仅用于排序，**绝不回写 importance**）
 *
 * 三条防失真规则（规格 4.5 逐条对应）：
 *  1. **封顶**：单条经营重点总加分 ≤ 30；
 *  2. **最多计两个重点**：取分最高的为主，次高按 0.3 衰减，其余忽略
 *     —— 杜绝「关键词覆盖面广 = 分越高」；
 *  3. **质量门槛**：`tier=drop` 不加权；`base < 40` 的弱条目加分减半
 *     —— 防「低质资讯靠命中季度重点挤进 Top3」。
 */
import type { FocusItem, FocusMatchLevel } from "./types";
import { FOCUS_BONUS_CAP, FOCUS_BONUS_TABLE } from "./types";
import type { FocusMatch } from "./focus-matcher";

/** 评分输入：基础分 + 参考档位 + 命中列表。 */
export interface FocusScoreInput {
  /** 基础重要性分（`scoreBranchRelevance().score`）。 */
  base: number;
  /** 参考档位；缺省视为未分档（全额加权）。 */
  tier?: "must_read" | "insight" | "context" | "drop";
  matches: readonly FocusMatch[];
}

export interface FocusScoreResult {
  /** 经营关注度分（0–CAP），独立保存，不并入 importance。 */
  focusRelevance: number;
  /** 排序用总分 = base + focusRelevance。 */
  finalScore: number;
  /** 实际计入加分的命中（≤2 条，供「为什么被提升」解释）。 */
  counted: Array<{ match: FocusMatch; bonus: number }>;
  /** 触发护栏时的说明（空表示未触发）。 */
  guards: string[];
}

/** 弱条目基础分阈值：低于此值加分减半（规格 4.3「不允许仅靠重点加权进入 Top3」）。 */
export const WEAK_BASE_SCORE = 40;

/** 次要命中衰减系数。 */
const SECONDARY_FACTOR = 0.3;

/**
 * 单个命中的基准加分。
 * 配置里显式写了 `weight` 时，把它当作该重点 M3 的分值，M2/M1 按默认表比例折算 ——
 * 这样管理者调 `weight` 的效果可预期，不会被三张表各算一遍。
 */
export function bonusOf(match: Pick<FocusMatch, "layer" | "matchLevel">, item?: Pick<FocusItem, "weight">): number {
  const table = FOCUS_BONUS_TABLE[match.layer];
  const level = match.matchLevel as Exclude<FocusMatchLevel, "M0">;
  const base = table[level];
  const w = item?.weight;
  if (w === undefined || w <= 0) return base;
  const m3 = Math.max(table.M3, 1);
  return Math.round(w * (base / m3) * 10) / 10;
}

/** 计算经营关注度分与排序总分。纯函数，不读配置、不读时钟。 */
export function scoreFocus(input: FocusScoreInput, focuses: readonly FocusItem[] = []): FocusScoreResult {
  const base = Number.isFinite(input.base) ? input.base : 0;
  const guards: string[] = [];
  const matches = input.matches ?? [];

  if (!matches.length) {
    return { focusRelevance: 0, finalScore: base, counted: [], guards };
  }
  if (input.tier === "drop") {
    // drop 档本来就该被漏斗挡掉；万一漏进来，也绝不让重点加权把它救回来。
    return { focusRelevance: 0, finalScore: base, counted: [], guards: ["drop 档不加权"] };
  }

  const byId = new Map(focuses.map((f) => [f.id, f]));
  const scored = matches
    .map((m) => ({ match: m, bonus: bonusOf(m, byId.get(m.focusId)) }))
    .filter((x) => x.bonus > 0)
    .sort((a, b) => b.bonus - a.bonus);

  if (!scored.length) {
    return { focusRelevance: 0, finalScore: base, counted: [], guards };
  }

  const primary = scored[0];
  const secondary = scored[1];
  let sum = primary.bonus + (secondary ? secondary.bonus * SECONDARY_FACTOR : 0);
  const counted = secondary ? [primary, secondary] : [primary];
  if (scored.length > 2) guards.push(`命中 ${scored.length} 个重点，仅计前 2 个`);

  if (sum > FOCUS_BONUS_CAP) {
    sum = FOCUS_BONUS_CAP;
    guards.push(`加分封顶 ${FOCUS_BONUS_CAP}`);
  }
  if (base < WEAK_BASE_SCORE) {
    sum = sum / 2;
    guards.push(`基础分 ${Math.round(base)} < ${WEAK_BASE_SCORE}，加分减半`);
  }

  const focusRelevance = Math.round(sum * 10) / 10;
  return {
    focusRelevance,
    finalScore: Math.round((base + focusRelevance) * 10) / 10,
    counted,
    guards,
  };
}
