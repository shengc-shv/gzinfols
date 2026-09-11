/**
 * 组装服务 C6：把富集后的 DailyReport 收口为「可渲染终稿」。
 *
 * 职责：
 *  1. 每个板块内按「重要性 → 源等级 → 时效性」排序并赋 rank。
 *  2. 控源：单板块内单源上限，避免一个源刷屏；单板块总上限。
 *  3. 必读兜底：skip-ai 模式下 enrich 未产出必读时，用各板块头部条目回填。
 *
 * 不读 sourceId/category 决定归属（归属已在 C4 确定性完成），只做排序与配额。
 */
import type {
  AssembledResult,
  PipelineContext,
} from "../../contracts/pipeline";
import type {
  DailyReport,
  ReportItem,
  ReportMustRead,
  ReportSectionKey,
} from "../../contracts/report";
import type { SourceTier } from "../../contracts/source";

const TIER_WEIGHT: Record<SourceTier, number> = { T1: 3, "T1.5": 2, T2: 1 };

/** 板块顺序即 tab 顺序；兜底必读按此优先级抽取。 */
const SECTION_PRIORITY: ReportSectionKey[] = [
  "gz_local",
  "biz_insight",
  "policy_market",
  "ipo",
  "tech",
];

const MAX_PER_SECTION = Number(process.env.MAX_PER_SECTION ?? 18);
const MAX_PER_SOURCE_PER_SECTION = Number(process.env.MAX_PER_SOURCE_PER_SECTION ?? 4);
const MAX_MUST_READ = 3;

function compareItems(a: ReportItem, b: ReportItem): number {
  if (a.importance !== b.importance) return b.importance - a.importance;
  const tw = (t?: SourceTier) => (t ? TIER_WEIGHT[t] : 1);
  if (tw(a.tier) !== tw(b.tier)) return tw(b.tier) - tw(a.tier);
  return a.title_cn.localeCompare(b.title_cn);
}

/** 单板块排序 + 配额（板块内单源上限 + 总上限）。 */
function rankSection(items: ReportItem[]): ReportItem[] {
  const sorted = [...items].sort(compareItems);
  const perSource = new Map<string, number>();
  const out: ReportItem[] = [];
  for (const it of sorted) {
    if (out.length >= MAX_PER_SECTION) break;
    const used = perSource.get(it.source) ?? 0;
    if (used >= MAX_PER_SOURCE_PER_SECTION) continue;
    perSource.set(it.source, used + 1);
    out.push({ ...it, rank: out.length + 1 });
  }
  return out;
}

/** skip-ai 兜底必读：每板块取头部一条，最多 MAX_MUST_READ。 */
function backfillMustRead(report: DailyReport): ReportMustRead[] {
  if (report.must_read && report.must_read.length > 0) return report.must_read;
  const out: ReportMustRead[] = [];
  for (const key of SECTION_PRIORITY) {
    if (out.length >= MAX_MUST_READ) break;
    const top = report.sections[key]?.[0];
    if (!top) continue;
    out.push({
      url: top.url,
      title: top.title_cn,
      why: `本板块最高优先级（${sectionLabel(key)}）：${top.summary.slice(0, 40)}`,
    });
  }
  return out;
}

function sectionLabel(key: ReportSectionKey): string {
  return (
    {
      gz_local: "广州本地",
      biz_insight: "业务启示",
      policy_market: "政策与市场",
      tech: "科技前沿",
      ipo: "IPO 动态",
    } as Record<ReportSectionKey, string>
  )[key];
}

/** 组装入口：排序定档 → 必读兜底 → 收口。 */
export function assemble(report: DailyReport, _ctx: PipelineContext): AssembledResult {
  const sections = {
    gz_local: rankSection(report.sections.gz_local),
    biz_insight: rankSection(report.sections.biz_insight),
    policy_market: rankSection(report.sections.policy_market),
    tech: rankSection(report.sections.tech),
    ipo: rankSection(report.sections.ipo),
  };

  const total = Object.values(sections).reduce((n, arr) => n + arr.length, 0);
  _ctx.log.info(
    "assemble",
    `定档完成：广州${sections.gz_local.length}/业务${sections.biz_insight.length}/政策${sections.policy_market.length}/科技${sections.tech.length}/IPO${sections.ipo.length} = ${total} 条`,
  );

  return {
    sections,
    must_read: backfillMustRead(report),
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
