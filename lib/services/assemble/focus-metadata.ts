/**
 * 经营重点命中打标（二期 WP6 + WP7）。
 *
 * 三层产物：
 *  1. 条目级 `ReportItem.focus_hits`（只记 M2/M3，最多 2 条）——首页卡片标签、
 *     详情页「经营重点关联」解释的数据源；
 *  2. 报告级 `report.focus`（本期生效重点 + 当日命中计数）——首页「本期经营重点」模块；
 *  3. `buildFocusDay` → `data/focus-ledger.json`（每日台账，专题页跨期聚合的唯一数据源）。
 *
 * 三者**共用同一个匹配入口**（`matchesFor`）：曾经踩过的坑是「排序一套判定、展示另一套」，
 * 结果卡片挂着标签但首页重点列表里没有，或台账条数与页面数对不上。
 *
 * 四条边界：
 *  - **展示范围由调用方决定**：生产管线只传**年度三大重点**（季度/临时专项仍参与排序
 *    加权，但不贴标签、不进首页模块），避免「卡片挂着本季标签、首页重点列表里却没有」；
 *    台账则接收**全部生效重点**（数据层不预设展示口径）。
 *  - **只读标题**，不读 summary / why：那些是 AI 产出的理由，喂回去等于自证
 *    （与 `applyRelevanceGuardrail` 同一口径）；
 *  - **不 mutate 入参**（历史报告对象在别处还引用着）；
 *  - **只打标、不改排序**：真正影响排序的是 exec 池与必读护栏的加权，本模块只负责
 *    把「命中了什么、为什么」记录下来，避免展示与排序各算一套；
 *  - **M1 不入 `focus_hits` / 不入台账 `hits`**：+0~3 分的宽泛关联若也打标，几乎每条资讯
 *    都会挂标签，首页会变成彩色噪音（规格 5.2）。台账里 M1 只进 `count`，不占命中行。
 *
 * 零 LLM、零 IO、零时钟。
 */
import type { DailyReport, ReportFocusHit, ReportFocusSummary, ReportItem } from "../../contracts/report";
import type { FocusLedgerDay, FocusLedgerFocusCount, FocusLedgerHit } from "../../contracts/focus-ledger";
import { applyFocus } from "../business-focus/focus-apply";
import type { FocusItem } from "../business-focus/types";
import { itemIdOf } from "../../utils/item-id";
import {
  applySemanticUpgrade,
  type FocusSemanticCandidate,
  type FocusSemanticMap,
  type FocusSemanticVerdict,
} from "../business-focus/focus-semantic";

/** 一条最多展示两个重点标签（规格 5.2「避免一张卡片出现过多彩色标签」）。 */
const MAX_BADGES = 2;

/** 等级排序：M3 优先，同为 M3 时按层级（临时 > 季度 > 年度，越近越靠前）。 */
const LEVEL_RANK: Record<string, number> = { M3: 0, M2: 1, M1: 2 };
const LAYER_RANK: Record<string, number> = { temporary: 0, quarterly: 1, annual: 2 };

/**
 * 单条资讯对所有重点的匹配结果（**唯一判定入口**：打标、汇总、台账都走这里）。
 *
 * 领域已在 `annotateItemMetadata` 回填（primary + related）时优先复用：一是省一次词表扫描，
 * 二是保证「展示标签」与「排序加权」用的是同一份领域判定。
 */
function matchesFor(
  it: Pick<ReportItem, "title_cn" | "primary_domain" | "related_domains">,
  focuses: readonly FocusItem[],
  semantic?: FocusSemanticMap,
) {
  const title = (it.title_cn ?? "").trim();
  if (!title) return null;
  const domains = [it.primary_domain, ...(it.related_domains ?? [])].filter(
    (d): d is string => !!d && d.trim().length > 0,
  );
  const res = applyFocus({ title, ...(domains.length ? { domains } : {}) }, 0, focuses);
  // 二期 WP11（可选、默认关）：AI 语义细化只**升级**规则给到 M1/M2 的命中，
  // 且只改等级与理由，不动 `focusRelevance`/`counted`（那是排序侧真实账目）。
  const verdicts: readonly FocusSemanticVerdict[] | undefined = semantic?.get(title);
  if (!verdicts?.length) return res;
  const upgraded = applySemanticUpgrade(res.matches, verdicts);
  return upgraded === res.matches ? res : { ...res, matches: upgraded };
}

function hitOf(it: ReportItem, focuses: readonly FocusItem[], semantic?: FocusSemanticMap): ReportFocusHit[] {
  const res = matchesFor(it, focuses, semantic);
  if (!res) return [];
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

/** 逐重点计数（count 含 M1；high 仅 M2/M3）。打标汇总与台账共用。 */
function tallyOf(items: readonly ReportItem[], focuses: readonly FocusItem[], semantic?: FocusSemanticMap) {
  const tally = new Map<string, { count: number; high: number }>();
  for (const f of focuses) tally.set(f.id, { count: 0, high: 0 });
  for (const it of items) {
    const res = matchesFor(it, focuses, semantic);
    if (!res) continue;
    for (const m of res.matches) {
      const t = tally.get(m.focusId);
      if (!t) continue;
      t.count += 1;
      if (m.matchLevel !== "M1") t.high += 1;
    }
  }
  return tally;
}

/** 汇总本期重点的当日命中数（含 M1，供「当日 N 条」显示；high 只算 M2/M3）。 */
function summarize(
  items: readonly ReportItem[],
  focuses: readonly FocusItem[],
  version: string,
  semantic?: FocusSemanticMap,
): ReportFocusSummary | undefined {
  if (!focuses.length) return undefined;
  const tally = tallyOf(items, focuses, semantic);
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
 * 收集 AI 语义细化的候选（二期 WP11）。
 *
 * 只收「规则判为 M1/M2 且确实命中了某个重点」的条目：M0 没有信号、M3 已经是精准命中，
 * 两者都不需要复核。去重按标题（与 `FocusSemanticMap` 的键一致）。
 *
 * 放在本模块而不是管线里：候选口径必须与打标用**同一个** `matchesFor`，
 * 否则会出现「送模型的候选」与「最后打标的命中」两套判定。
 */
export function collectSemanticCandidates(
  report: DailyReport,
  focuses: readonly FocusItem[],
): FocusSemanticCandidate[] {
  if (!focuses.length) return [];
  const seen = new Set<string>();
  const out: FocusSemanticCandidate[] = [];
  const items = Object.values(report.sections ?? {}).flat() as ReportItem[];
  for (const it of items) {
    const title = (it.title_cn ?? "").trim();
    if (!title || seen.has(title)) continue;
    const res = matchesFor(it, focuses);
    if (!res) continue;
    const relevant = res.matches.filter((m) => m.matchLevel === "M1" || m.matchLevel === "M2");
    if (!relevant.length) continue;
    // 最高等级决定候选档位（M2 优先送模型：还有升级到 M3 的空间，且更可能是真命中）
    const level: "M1" | "M2" = relevant.some((m) => m.matchLevel === "M2") ? "M2" : "M1";
    seen.add(title);
    out.push({ title, level, focusIds: [...new Set(relevant.map((m) => m.focusId))] });
  }
  // M2 候选优先排队（候选上限截断时，先保住更可能是真命中的）
  out.sort((a, b) => (a.level === b.level ? 0 : a.level === "M2" ? -1 : 1));
  return out;
}

/**
 * 给报告打经营重点标（幂等：同输入同输出，重跑覆盖而不叠加）。
 * @param focuses 本期生效重点；空数组时**原样返回**（不做任何字段注入）
 */
export function annotateFocus(
  report: DailyReport,
  focuses: readonly FocusItem[],
  version: string,
  opts: { semantic?: FocusSemanticMap } = {},
): DailyReport {
  if (!focuses.length) return report;
  const semantic = opts.semantic;
  const sections = Object.fromEntries(
    Object.entries(report.sections ?? {}).map(([k, list]) => [
      k,
      (list as ReportItem[]).map((it) => {
        const hits = hitOf(it, focuses, semantic);
        // 无命中不留空数组：JSON 里少一个字段比多一个 [] 更省，也便于判断「有没有标」
        return hits.length ? { ...it, focus_hits: hits } : it;
      }),
    ]),
  ) as unknown as DailyReport["sections"];
  const next: DailyReport = { ...report, sections };
  const summary = summarize(Object.values(sections).flat() as ReportItem[], focuses, version, semantic);
  if (summary) next.focus = summary;
  return next;
}

/**
 * 卡片落位索引（必读 / 商机 / 风险），用于台账标注「这条资讯最后进了哪里」。
 *
 * 只用 url 与必读标题：这三处结构不同（必读 `{url,title,why}`、商机 `{topic,sources[]}`、
 * 风险 `{topic,sources[],url}`），没有一个公共 id 字段，硬要统一就得改契约（不值得）。
 * 标题兜底只给必读用 —— 它的 `title` 就是原文标题，可直接逐字比；商机/风险的 `topic`
 * 是 AI 归并出来的方向名，拿去比会连坐错标。
 */
function placementIndex(report: DailyReport) {
  const mustUrls = new Set<string>();
  const mustTitles = new Set<string>();
  for (const m of report.must_read ?? []) {
    if (m.url) mustUrls.add(m.url);
    if (m.title) mustTitles.add(m.title.trim());
  }
  const insightUrls = new Set<string>();
  for (const i of report.insights ?? []) {
    for (const s of i.sources ?? []) if (s.url) insightUrls.add(s.url);
    if (i.related_url) insightUrls.add(i.related_url);
  }
  const riskUrls = new Set<string>();
  if (report.risk?.url) riskUrls.add(report.risk.url);
  for (const s of report.risk?.sources ?? []) if (s.url) riskUrls.add(s.url);
  return { mustUrls, mustTitles, insightUrls, riskUrls };
}

/**
 * 构建一天的台账（WP7，纯函数）。
 *
 * 与 `annotateFocus` 的区别：**接收全部生效重点**（不预设展示口径）、记录 M2/M3 明细与
 * 卡片落位，供专题页跨期聚合。`hits` 按「板块顺序 → 条目顺序」排列，保证同一天重跑产物
 * 逐字一致（否则每天 diff 都在抖动）。
 *
 * @param focuses 空数组时返回 undefined（引擎关 / 无配置 → 不写台账，也不留空壳天）
 */
export function buildFocusDay(
  report: DailyReport,
  focuses: readonly FocusItem[],
  version: string,
  date: string,
): FocusLedgerDay | undefined {
  if (!focuses.length) return undefined;
  const sections = (report.sections ?? {}) as unknown as Record<string, ReportItem[] | undefined>;
  const all = Object.values(sections).flat() as ReportItem[];
  const tally = tallyOf(all, focuses);
  const { mustUrls, mustTitles, insightUrls, riskUrls } = placementIndex(report);

  const hits: FocusLedgerHit[] = [];
  for (const [section, list] of Object.entries(sections)) {
    for (const it of (list ?? []) as ReportItem[]) {
      const res = matchesFor(it, focuses);
      if (!res) continue;
      const title = (it.title_cn ?? "").trim();
      const url = it.url ?? "";
      for (const m of res.matches) {
        if (m.matchLevel !== "M2" && m.matchLevel !== "M3") continue; // M1 只进计数
        const scored = res.counted.find((c) => c.match.focusId === m.focusId);
        // ⚠️ 无 url 的条目不拿 `itemIdOf("")`（恒 `itm-0`，会让多条撞成一个 id）→ 留空串
        const hit: FocusLedgerHit = {
          focusId: m.focusId,
          level: m.matchLevel,
          bonus: scored ? Math.round(scored.bonus * 10) / 10 : 0,
          reason: m.reason,
          itemId: url ? itemIdOf(url) : "",
          url,
          title,
          source: it.source ?? "",
          itemDate: it.date ?? "",
          section,
        };
        if (url ? mustUrls.has(url) : !!title && mustTitles.has(title)) hit.inMustRead = true;
        if (url && insightUrls.has(url)) hit.inInsights = true;
        if (url && riskUrls.has(url)) hit.isRisk = true;
        hits.push(hit);
      }
    }
  }

  const counts: FocusLedgerFocusCount[] = focuses.map((f) => ({
    id: f.id,
    name: f.name,
    layer: f.layer,
    grade: f.grade,
    count: tally.get(f.id)?.count ?? 0,
    high: tally.get(f.id)?.high ?? 0,
    domains: [...f.domains],
  }));

  return { date, version, focuses: counts, hits };
}
