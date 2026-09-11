/**
 * 富集服务 C4（AI 唯一落点）。
 *
 * 红线 #2 落地：板块归属由「确定性内容打分」决定，绝不读 sourceId/category 字符串。
 * AI 职责：① 相关性回检（红线 #3 防线，见 ./relevance）；② 外文中文化、≤90字摘要、
 * 标签（批量）；③ 报告级 hero_line/insights/must_read/risk（喂真实条目，must_read.url
 * 必须校验 ∈ 今日条目集合，杜绝幻觉死链）。
 * LLM 调用批量化：富集每批 20 条一次调用，自写并发池同时最多 4 批在飞；
 * 失败批次整批降级用原文标题/摘要，并计入 ctx.errors 与 ctx.stats（llmCalls/llmFailures）。
 * SKIP_AI 模式：跳过全部 LLM，用标题/摘要直接成稿（保证管线可降级跑通）。
 */
import type { ArticleInput } from "../../contracts/article";
import type {
  DailyReport,
  ReportItem,
  ReportSectionKey,
} from "../../contracts/report";
import type { FilterResult, LlmPort, PipelineContext } from "../../contracts/pipeline";
import { SECTION_LABELS as LABELS, SECTION_ORDER as ORDER } from "../../contracts/report";
import { relevanceCheck } from "./relevance";

export interface EnrichDeps {
  llm: LlmPort;
}

export interface EnrichOpts {
  /** 漏斗结果：商机/风险追踪器命中的条目在相关性回检中豁免 AI。 */
  filterResults?: Map<string, FilterResult>;
}

/** 每批富集条目数（一次 LLM 调用处理的条目数）。 */
const ENRICH_BATCH_SIZE = 20;
/** 并发池宽度：同时在飞的富集批次数上限。 */
const ENRICH_CONCURRENCY = 4;
/** 报告级调用：每板块喂给 LLM 的选材条数。 */
const REPORT_TOP_PER_SECTION = 8;
/** 摘要在报告级 prompt 中的截断长度。 */
const REPORT_SUMMARY_SNIPPET = 60;

/**
 * 板块关键词词表（Q2 数据化：运营调词只改这里，不必动函数逻辑）。
 * 红线 #2：归属由标题/摘要与词表打分决定。
 */
export const SECTION_KEYWORD_GROUPS: Record<ReportSectionKey, string[]> = {
  gz_local: ["广州", "广东", "深圳", "大湾区", "南沙", "黄埔", "天河", "营商环境", "招商引资"],
  policy_market: ["央行", "人民银行", "金融监管", "国务院", "政策", "宏观", "降准", "降息", "货币", "财政"],
  biz_insight: ["银行", "信贷", "理财", "财富", "私行", "零售", "普惠", "小微", "AUM", "净值", "存款", "贷款"],
  tech: ["AI", "大模型", "人工智能", "算力", "算法", "芯片", "金融科技", "区块链"],
  ipo: [],
};

/**
 * 确定性板块归属（红线 #2：内容判定）。
 *
 * 红线 #2 的精确边界：category 仅可作为 IPO 内容态来源（ipo/gd-ipo → ipo 板块）
 * 与参考区豁免判断（见 select/funnel），不参与一般板块归属；
 * 一般归属只由标题/摘要内容与 SECTION_KEYWORD_GROUPS 打分决定，无命中回退 policy_market。
 */
export function assignSection(a: ArticleInput): ReportSectionKey {
  const text = `${a.title}\n${a.excerpt}`;
  if (a.isIpo || a.category === "ipo" || a.category === "gd-ipo") return "ipo";
  let best: ReportSectionKey = "policy_market";
  let bestScore = 0;
  for (const [key, words] of Object.entries(SECTION_KEYWORD_GROUPS)) {
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

/** 极简 Promise worker 池：同时最多 limit 个任务在飞，结果保序返回（约 20 行，零依赖）。 */
async function runPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function lane(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => lane()));
  return results;
}

/** 构造降级兜底卡（原文标题/摘要，无 AI 参与）。 */
function buildFallbackItem(a: ArticleInput, section: ReportSectionKey): ReportItem {
  let locale: ReportItem["locale"] = "national";
  let locale_evidence: string | undefined;
  if (section === "gz_local") {
    const m = a.title.match(/(广州|广东|深圳|大湾区|南沙|黄埔|天河)/);
    if (m) {
      locale = "gz";
      locale_evidence = m[0];
    }
  }
  return {
    url: a.url,
    title_cn: a.title,
    source: a.source,
    source_type: a.tier === "T1" ? "official" : "media",
    date: toDateStr(a.publishedAt),
    published_at: a.publishedAt.toISOString(),
    summary: a.excerpt.slice(0, 90),
    importance: a.tier === "T1" ? 3 : 2,
    rank: 0,
    tags: [],
    locale,
    locale_evidence,
    tier: a.tier,
    ipoStage: a.ipoStage,
    listedDate: a.listedDate,
    officialUrl: a.officialUrl,
    officialLabel: a.officialLabel,
    gdBasis: a.gdBasis,
  };
}

interface TaggedArticle {
  a: ArticleInput;
  section: ReportSectionKey;
}

/** 富集 prompt 的单条输入行（i = 批内下标，从 0 开始）。 */
function batchPromptLine(t: TaggedArticle, i: number): string {
  return `${i}. 标题：${t.a.title}\n   摘要：${t.a.excerpt}\n   板块：${t.section}`;
}

/** AI 改写字段（部分失败允许逐字段回退兜底值）。 */
interface BatchRewrite {
  i?: number;
  title_cn?: string;
  summary?: string;
  tags?: string[];
  importance?: number;
}

/**
 * 批量富集一批：一次 LLM 调用改写整批；失败整批降级并计入观测。
 * 返回「板块归属 + ReportItem」对，由主流程按板块落位。
 */
async function enrichBatch(
  batch: TaggedArticle[],
  ctx: PipelineContext,
  deps: EnrichDeps,
): Promise<Array<{ section: ReportSectionKey; item: ReportItem }>> {
  const fallback = batch.map((t) => ({ section: t.section, item: buildFallbackItem(t.a, t.section) }));
  ctx.stats.llmCalls = (ctx.stats.llmCalls ?? 0) + 1;
  try {
    const json = await deps.llm.complete({
      system:
        "你是招行广州分行零售分管行长的每日简报编辑。把给定新闻逐条改写成简报卡。" +
        "返回JSON数组，每项包含：i(条目序号,从0开始)、title_cn(中文标题,<=30字)、" +
        "summary(<=90字,结构=发生了什么+关键数字+所以呢)、tags(2-4个中文标签)、importance(1|2|3)。只返回JSON。",
      prompt: batch.map((t, i) => batchPromptLine(t, i)).join("\n"),
      expectJson: true,
      temperature: 0.2,
    });
    const parsed = JSON.parse(json) as BatchRewrite[];
    if (!Array.isArray(parsed)) throw new Error("富集返回非数组");
    const byIndex = new Map<number, BatchRewrite>();
    for (const p of parsed) {
      if (p && typeof p.i === "number") byIndex.set(p.i, p);
    }
    return fallback.map((f, i) => {
      const p = byIndex.get(i);
      if (!p) return f; // 该条 AI 缺答 → 保留兜底
      const item = { ...f.item };
      if (typeof p.title_cn === "string" && p.title_cn) {
        item.title_orig = item.title_cn !== p.title_cn ? item.title_cn : undefined;
        item.title_cn = p.title_cn;
      }
      if (typeof p.summary === "string" && p.summary) item.summary = p.summary;
      if (Array.isArray(p.tags)) item.tags = p.tags.map(String);
      if (p.importance === 1 || p.importance === 2 || p.importance === 3) item.importance = p.importance;
      return { section: f.section, item };
    });
  } catch (e) {
    ctx.stats.llmFailures = (ctx.stats.llmFailures ?? 0) + 1;
    const msg = e instanceof Error ? e.message : String(e);
    ctx.errors.push({
      stage: "enrich",
      message: `富集批次失败（${batch.length} 条），整批降级为原文：${msg}`,
    });
    return fallback;
  }
}

/** 报告级调用：喂真实条目选材，产出 hero_line/insights/must_read/risk。 */
async function enrichReportLevel(
  sections: Record<ReportSectionKey, ReportItem[]>,
  urlSet: Set<string>,
  ctx: PipelineContext,
  deps: EnrichDeps,
): Promise<Pick<DailyReport, "hero_line" | "insights" | "must_read" | "risk">> {
  try {
    // 每板块取前 N 条真实条目喂给模型（title + url + 摘要截断），杜绝凭空编造
    const parts = ORDER.map((key) => {
      const items = sections[key].slice(0, REPORT_TOP_PER_SECTION);
      if (items.length === 0) return null;
      const lines = items
        .map((it) => `- ${it.title_cn} | ${it.url} | ${it.summary.slice(0, REPORT_SUMMARY_SNIPPET)}`)
        .join("\n");
      return `【${LABELS[key]}】\n${lines}`;
    }).filter((p): p is string => p !== null);
    if (parts.length === 0) return { hero_line: undefined, insights: [], must_read: [], risk: undefined };

    ctx.stats.llmCalls = (ctx.stats.llmCalls ?? 0) + 1;
    const json = await deps.llm.complete({
      system:
        "你是招行广州分行零售分管行长的决策参谋。基于今日新闻，产出JSON：" +
        "hero_line(今日定调一句话,15-70字)、insights(2-4条商机洞察,每条topic/impact/action/segments)、" +
        "must_read(1-3条必读,url+why；url 只能从所给条目中选取,禁止编造)、" +
        "risk(1条今日风险,topic/evidence/impact/action)。只返回JSON。",
      prompt: `今日各板块条目（供选材）：\n\n${parts.join("\n\n")}`,
      expectJson: true,
      temperature: 0.3,
    });
    const parsed = JSON.parse(json) as {
      hero_line?: string;
      insights?: DailyReport["insights"];
      must_read?: DailyReport["must_read"];
      risk?: DailyReport["risk"];
    };
    // must_read 校验：url 必须 ∈ 今日全部条目集合；过滤后为空则置空（assemble 有兜底回填）
    const mustRead = (parsed.must_read ?? []).filter(
      (m) => m && typeof m.url === "string" && urlSet.has(m.url),
    );
    return {
      hero_line: parsed.hero_line,
      insights: parsed.insights ?? [],
      must_read: mustRead,
      risk: parsed.risk,
    };
  } catch (e) {
    ctx.stats.llmFailures = (ctx.stats.llmFailures ?? 0) + 1;
    const msg = e instanceof Error ? e.message : String(e);
    ctx.errors.push({ stage: "enrich", message: `报告级 AI 调用失败，降级为无 hero/insights：${msg}` });
    return { hero_line: undefined, insights: [], must_read: [], risk: undefined };
  }
}

/** 富集入口：相关性回检过滤 → 批量改写（并发池）→ 报告级选材。 */
export async function enrich(
  articles: ArticleInput[],
  ctx: PipelineContext,
  deps: EnrichDeps,
  opts?: EnrichOpts,
): Promise<DailyReport> {
  const skipAi = ctx.mode.kind === "skip-ai";

  // 红线 #3 防线：AI 相关性回检（skip-ai 模式整段跳过，不做任何 LLM 调用）
  let working = articles;
  if (!skipAi) {
    const rc = await relevanceCheck(articles, ctx, deps, opts?.filterResults);
    working = rc.kept;
    ctx.stats.recheckDropped = (ctx.stats.recheckDropped ?? 0) + rc.dropped;
    if (rc.dropped > 0) {
      ctx.log.info("enrich", `相关性回检（红线 #3）丢弃 ${rc.dropped} 条不相关条目`);
    }
  }

  const sections: Record<ReportSectionKey, ReportItem[]> = {
    gz_local: [],
    biz_insight: [],
    policy_market: [],
    tech: [],
    ipo: [],
  };

  // 批量富集：每批 20 条一次调用，并发池最多 4 批在飞；
  // skip-ai 模式（契约：不调用任何 LLM）在池内短路，直接用兜底卡，不发起调用
  const tagged = working.map((a) => ({ a, section: assignSection(a) }));
  const batches: TaggedArticle[][] = [];
  for (let i = 0; i < tagged.length; i += ENRICH_BATCH_SIZE) {
    batches.push(tagged.slice(i, i + ENRICH_BATCH_SIZE));
  }
  const batched = await runPool(batches, ENRICH_CONCURRENCY, (b) =>
    skipAi
      ? Promise.resolve(
          b.map((t) => ({ section: t.section, item: buildFallbackItem(t.a, t.section) })),
        )
      : enrichBatch(b, ctx, deps),
  );
  for (const group of batched) {
    for (const { section, item } of group) sections[section].push(item);
  }

  const report: DailyReport = {
    date: ctx.date,
    must_read: [],
    insights: [],
    sections,
  };

  if (!skipAi) {
    const urlSet = new Set(working.map((a) => a.url));
    const extras = await enrichReportLevel(sections, urlSet, ctx, deps);
    report.hero_line = extras.hero_line;
    report.insights = extras.insights;
    report.must_read = extras.must_read;
    report.risk = extras.risk;
  }

  ctx.log.info("enrich", `AI 富集完成：5 板块共 ${Object.values(sections).flat().length} 条`);
  return report;
}
