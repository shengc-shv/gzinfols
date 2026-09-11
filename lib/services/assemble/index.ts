/**
 * 组装服务 C6：把富集后的 DailyReport 收口为「可渲染终稿」。
 *
 * 职责：
 *  1. 每个板块内按「重要性 → 源等级 → 时效性」排序并赋 rank。
 *  2. 控源：单板块内单源上限，避免一个源刷屏；单板块总上限（配额读 ctx.config）。
 *  3. 必读兜底：enrich 未产出必读（skip-ai 或 AI 失败/校验过滤后为空）时，用各板块头部条目回填。
 *
 * 不读 sourceId/category 决定归属（归属已在 C4 确定性完成），只做排序与配额。
 * 板块标签/等级权重一律消费契约层常量（SECTION_LABELS / SOURCE_TIER_ORDER），不重复定义。
 */
import type {
  AssembledResult,
  PipelineContext,
} from "../../contracts/pipeline";
import type {
  DailyReport,
  ReportItem,
  ReportMustRead,
} from "../../contracts/report";
import { SECTION_LABELS, SECTION_ORDER } from "../../contracts/report";
import { SOURCE_TIER_ORDER, type SourceTier } from "../../contracts/source";

const MAX_MUST_READ = 3;

function compareItems(a: ReportItem, b: ReportItem): number {
  if (a.importance !== b.importance) return b.importance - a.importance;
  const tw = (t?: SourceTier) => (t ? SOURCE_TIER_ORDER[t] : 1);
  if (tw(a.tier) !== tw(b.tier)) return tw(b.tier) - tw(a.tier);
  return a.title_cn.localeCompare(b.title_cn);
}

/** 单板块排序 + 配额（板块内单源上限 + 总上限，均来自 ctx.config）。 */
function rankSection(items: ReportItem[], ctx: PipelineContext): ReportItem[] {
  const sorted = [...items].sort(compareItems);
  const perSource = new Map<string, number>();
  const out: ReportItem[] = [];
  for (const it of sorted) {
    if (out.length >= ctx.config.maxPerSection) break;
    const used = perSource.get(it.source) ?? 0;
    if (used >= ctx.config.maxPerSourcePerSection) continue;
    perSource.set(it.source, used + 1);
    out.push({ ...it, rank: out.length + 1 });
  }
  return out;
}

/** 组装入口：排序定档 → 收口（must_read/insights 由 side-outputs 旁路产出，本阶段不兜底）。 */
export function assemble(report: DailyReport, _ctx: PipelineContext): AssembledResult {
  const sections = {
    gz_local: rankSection(report.sections.gz_local, _ctx),
    biz_insight: rankSection(report.sections.biz_insight, _ctx),
    policy_market: rankSection(report.sections.policy_market, _ctx),
    tech: rankSection(report.sections.tech, _ctx),
    ipo: rankSection(report.sections.ipo, _ctx),
  };

  const total = Object.values(sections).reduce((n, arr) => n + arr.length, 0);
  _ctx.log.info(
    "assemble",
    `定档完成：广州${sections.gz_local.length}/业务${sections.biz_insight.length}/政策${sections.policy_market.length}/科技${sections.tech.length}/IPO${sections.ipo.length} = ${total} 条`,
  );

  return {
    sections,
    must_read: report.must_read ?? [],
    insights: report.insights ?? [],
    hero_line: report.hero_line,
    risk: report.risk,
  };
}

/** 供 pipeline 直接收口为 DailyReport。 */
export function assembleReport(report: DailyReport, ctx: PipelineContext): DailyReport {
  const a = assemble(report, ctx);
  return {
    ...report,
    sections: a.sections,
    must_read: a.must_read,
    insights: a.insights,
    hero_line: a.hero_line,
    risk: a.risk,
  };
}
