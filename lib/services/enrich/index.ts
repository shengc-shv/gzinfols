/**
 * 富集服务 C4（AI 唯一落点）。
 *
 * 红线 #2 落地：板块归属由「确定性内容打分」决定，绝不读 sourceId/category 字符串。
 * AI 只负责：外文中文化、≤90字摘要、标签、洞察/必读/风险口播稿。
 * SKIP_AI 模式：跳过 LLM，用标题/摘要直接成稿（保证管线可降级跑通）。
 */
import type { ArticleInput } from "../../contracts/article";
import type {
  DailyReport,
  ReportItem,
  ReportSectionKey,
} from "../../contracts/report";
import type { LlmPort, PipelineContext } from "../../contracts/pipeline";

export interface EnrichDeps {
  llm: LlmPort;
}

/** 确定性板块归属（红线 #2：内容判定）。 */
export function assignSection(a: ArticleInput): ReportSectionKey {
  const text = `${a.title}\n${a.excerpt}`;
  if (a.isIpo || a.category === "ipo" || a.category === "gd-ipo") return "ipo";
  const groups: Record<ReportSectionKey, string[]> = {
    gz_local: ["广州", "广东", "深圳", "大湾区", "南沙", "黄埔", "天河", "营商环境", "招商引资"],
    policy_market: ["央行", "人民银行", "金融监管", "国务院", "政策", "宏观", "降准", "降息", "货币", "财政"],
    biz_insight: ["银行", "信贷", "理财", "财富", "私行", "零售", "普惠", "小微", "AUM", "净值", "存款", "贷款"],
    tech: ["AI", "大模型", "人工智能", "算力", "算法", "芯片", "金融科技", "区块链"],
    ipo: [],
  };
  if (a.category === "tech") groups.tech.push("技术", "科技");
  let best: ReportSectionKey = "policy_market";
  let bestScore = 0;
  for (const [key, words] of Object.entries(groups)) {
    const s = words.reduce((acc, w) => acc + (text.includes(w) ? 1 : 0), 0);
    if (s > bestScore) {
      bestScore = s;
      best = key as ReportSectionKey;
    }
  }
  return best;
}

function toDateStr(d: Date): string {
  const p = d.toISOString().slice(0, 10);
  return `${p.slice(5, 7)}/${p.slice(8, 10)}`;
}

/** 把归一化条目转为 ReportItem（rank 暂置 0，由 assemble 统一排）。 */
export async function enrich(
  articles: ArticleInput[],
  ctx: PipelineContext,
  deps: EnrichDeps,
): Promise<DailyReport> {
  const skipAi = ctx.mode.kind === "skip-ai";
  const sections: Record<ReportSectionKey, ReportItem[]> = {
    gz_local: [],
    biz_insight: [],
    policy_market: [],
    tech: [],
    ipo: [],
  };

  for (const a of articles) {
    const section = assignSection(a);
    let title_cn = a.title;
    let summary = a.excerpt.slice(0, 90);
    let tags: string[] = [];
    let importance: 1 | 2 | 3 = a.tier === "T1" ? 3 : a.tier === "T1.5" ? 2 : 2;
    let locale: ReportItem["locale"] = "national";
    let locale_evidence: string | undefined;

    if (section === "gz_local") {
      const m = a.title.match(/(广州|广东|深圳|大湾区|南沙|黄埔|天河)/);
      if (m) {
        locale = "gz";
        locale_evidence = m[0];
      }
    }

    if (!skipAi) {
      try {
        const json = await deps.llm.complete({
          system:
            "你是招行广州分行零售分管行长的每日简报编辑。把给定新闻改写成简报卡。用JSON返回：title_cn(中文标题,<=30字)、summary(<=90字,结构=发生了什么+关键数字+所以呢)、tags(2-4个中文标签)、importance(1|2|3)。只返回JSON。",
          prompt: `标题：${a.title}\n摘要：${a.excerpt}\n板块：${section}`,
          expectJson: true,
          temperature: 0.2,
        });
        const parsed = JSON.parse(json);
        title_cn = parsed.title_cn ?? title_cn;
        summary = parsed.summary ?? summary;
        tags = parsed.tags ?? [];
        if ([1, 2, 3].includes(parsed.importance)) importance = parsed.importance;
      } catch {
        /* 单条 AI 失败降级为原文摘要 */
      }
    }

    sections[section].push({
      url: a.url,
      title_cn,
      title_orig: a.title !== title_cn ? a.title : undefined,
      source: a.source,
      source_type: a.tier === "T1" ? "official" : "media",
      date: toDateStr(a.publishedAt),
      summary,
      importance,
      rank: 0,
      tags,
      locale,
      locale_evidence,
      tier: a.tier,
      ipoStage: a.ipoStage,
      listedDate: a.listedDate,
      officialUrl: a.officialUrl,
      officialLabel: a.officialLabel,
      gdBasis: a.gdBasis,
    });
  }

  const report: DailyReport = {
    date: ctx.date,
    must_read: [],
    insights: [],
    sections,
  };

  if (!skipAi) {
    try {
      const json = await deps.llm.complete({
        system:
          "你是招行广州分行零售分管行长的决策参谋。基于今日新闻，产出JSON：hero_line(今日定调一句话,15-70字)、insights(2-4条商机洞察,每条topic/impact/action/segments)、must_read(1-3条必读,url+why)、risk(1条今日风险,topic/evidence/impact/action)。只返回JSON。",
        prompt: sections
          ? `今日板块概览：广州本地${sections.gz_local.length}条、业务启示${sections.biz_insight.length}条、政策市场${sections.policy_market.length}条、科技${sections.tech.length}条、IPO${sections.ipo.length}条。`
          : "",
        expectJson: true,
        temperature: 0.3,
      });
      const parsed = JSON.parse(json);
      report.hero_line = parsed.hero_line;
      report.insights = parsed.insights ?? [];
      report.must_read = parsed.must_read ?? [];
      report.risk = parsed.risk;
    } catch {
      /* 降级：无 hero/insights */
    }
  }

  ctx.log.info("enrich", `AI 富集完成：5 板块共 ${Object.values(sections).flat().length} 条`);
  return report;
}
