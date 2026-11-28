/**
 * 经营重点命中打标（二期 WP6）。
 *
 * 两层产物：
 *  1. 条目级 `ReportItem.focus_hits`（只记 M2/M3，最多 2 条）——首页卡片标签、
 *     详情页「经营重点关联」解释的数据源；
 *  2. 报告级 `report.focus`（本期生效重点 + 当日命中计数）——首页「本期经营重点」模块。
 *
 * 四条边界：
 *  - **只读标题**，不读 summary / why：那些是 AI 产出的理由，喂回去等于自证
 *    （与 `applyRelevanceGuardrail` 同一口径）；
 *  - **不 mutate 入参**（历史报告对象在别处还引用着）；
 *  - **只打标、不改排序**：真正影响排序的是 exec 池与必读护栏的加权，本模块只负责
 *    把「命中了什么、为什么」记录下来，避免展示与排序各算一套；
 *  - **M1 不入库**：+0~3 分的宽泛关联若也打标，几乎每条资讯都会挂标签，
 *    首页会变成彩色噪音（规格 5.2）。
 *
 * 零 LLM、零 IO、零时钟。
 */
import type { DailyReport, ReportFocusHit, ReportFocusSummary, ReportItem } from "../../contracts/report";
import { applyFocus } from "../business-focus/focus-apply";
import type { FocusItem } from "../business-focus/types";

/** 一条最多展示两个重点标签（规格 5.2「避免一张卡片出现过多彩色标签」）。 */
const MAX_BADGES = 2;

/** 等级排序：M3 优先，同为 M3 时按层级（临时 > 季度 > 年度，越近越靠前）。 */
const LEVEL_RANK: Record<string, number> = { M3: 0, M2: 1, M1: 2 };
const LAYER_RANK: Record<string, number> = { temporary: 0, quarterly: 1, annual: 2 };

function hitOf(it: ReportItem, focuses: readonly FocusItem[]): ReportFocusHit[] {
  const title = (it.title_cn ?? "").trim();
  if (!title) return [];
  // 领域已在 `annotateItemMetadata` 回填（primary + related），直接复用：
  // 一是省一次词表扫描，二是保证「展示标签」与「排序加权」用的是同一份领域判定。
  const domains = [it.primary_domain, ...(it.related_domains ?? [])].filter(
    (d): d is string => !!d && d.trim().length > 0,
  );
  const res = applyFocus({ title, ...(domains.length ? { domains } : {}) }, 0, focuses);
  return res.matches
    .filter((m): m is typeof m & { matchLevel: "M2" | "M3" } => m.matchLevel === "M2" || m.matchLevel === "M3")
    .sort(
      (a, b) =>
        (LEVEL_RANK[a.matchLevel] ?? 9) - (LEVEL_RANK[b.matchLevel] ?? 9) ||
        (LAYER_RANK[a.layer] ?? 9) - (LAYER_RANK[b.layer] ?? 9),
    )
    .slice(0, MAX_BADGES)
    .map((m) => {
      // bonus 用 scoreFocus 的真实折算（含衰减与封顶），不复用 matchLevel 的基准表 ——
      // 否则一条命中两个重点时标签上的数字与真实加分对不上。
      const scored = res.counted.find((c) => c.match.focusId === m.focusId);
      return {
        id: m.focusId,
        name: m.name,
        layer: m.layer,
        grade: m.grade,
        level: m.matchLevel,
        bonus: scored ? Math.round(scored.bonus * 10) / 10 : 0,
        reason: m.reason,
      };
    });
}

/** 汇总本期重点的当日命中数（含 M1，供「当日 N 条」显示；high 只算 M2/M3）。 */
function summarize(
  items: readonly ReportItem[],
  focuses: readonly FocusItem[],
  version: string,
): ReportFocusSummary | undefined {
  if (!focuses.length) return undefined;
  const tally = new Map<string, { count: number; high: number }>();
  for (const f of focuses) tally.set(f.id, { count: 0, high: 0 });
  for (const it of items) {
    const title = (it.title_cn ?? "").trim();
    if (!title) continue;
    const domains = [it.primary_domain, ...(it.related_domains ?? [])].filter(
      (d): d is string => !!d && d.trim().length > 0,
    );
    const res = applyFocus({ title, ...(domains.length ? { domains } : {}) }, 0, focuses);
    for (const m of res.matches) {
      const t = tally.get(m.focusId);
      if (!t) continue;
      t.count += 1;
      if (m.matchLevel !== "M1") t.high += 1;
    }
  }
  return {
    version,
    items: focuses.map((f) => ({
      id: f.id,
      name: f.name,
      layer: f.layer,
      grade: f.grade,
      count: tally.get(f.id)?.count ?? 0,
      high: tally.get(f.id)?.high ?? 0,
      domains: [...f.domains],
    })),
  };
}

/**
 * 给报告打经营重点标（幂等：同输入同输出，重跑覆盖而不叠加）。
 * @param focuses 本期生效重点；空数组时**原样返回**（不做任何字段注入）
 */
export function annotateFocus(
  report: DailyReport,
  focuses: readonly FocusItem[],
  version: string,
): DailyReport {
  if (!focuses.length) return report;
  const sections = Object.fromEntries(
    Object.entries(report.sections ?? {}).map(([k, list]) => [
      k,
      (list as ReportItem[]).map((it) => {
        const hits = hitOf(it, focuses);
        // 无命中不留空数组：JSON 里少一个字段比多一个 [] 更省，也便于判断「有没有标」
        return hits.length ? { ...it, focus_hits: hits } : it;
      }),
    ]),
  ) as unknown as DailyReport["sections"];
  const next: DailyReport = { ...report, sections };
  const summary = summarize(Object.values(sections).flat() as ReportItem[], focuses, version);
  if (summary) next.focus = summary;
  return next;
}
