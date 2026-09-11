/**
 * 管道编排（C1→C9 顺序）：把各服务按阶段串起来。
 *
 * 编排层只「调用服务 + 传递 deps」，不实现业务逻辑；业务规则全在各 lib/services/*。
 * 红线贯穿：C2 丢弃无发布时间 → C3 漏斗只看内容 → C4 相关性回检+板块归属确定性 → C6 定档。
 * 历史库闭环：select 之后、enrich 之前回放去重（先读），管线尾部 saveHistory（后写，单一写者）。
 */
import type { DailyReport } from "../contracts/report";
import type { PipelineContext, PipelineDeps } from "../contracts/pipeline";
import { ingestAll } from "../services/collect";
import { normalize } from "../services/normalize";
import { select } from "../services/select";
import { enrich } from "../services/enrich";
import { assembleReport } from "../services/assemble";
import { renderHtml, renderMarkdown } from "../services/render";
import { buildSpeechScript } from "../services/voice";
import { publishReport } from "../services/publish";
import { dedupeAgainstHistory, loadHistory, saveHistory } from "../services/memory";

export interface RunOutput {
  report: DailyReport;
  html: string;
  markdown: string;
  speech: string;
  paths: { reportPath: string; htmlPath: string; mdPath: string };
}

/** 完整管线：采集 → 归一化 → 漏斗 → 历史去重 → 富集 → 组装 → 渲染 → 语音稿 → 记忆 → 发布。 */
export async function runPipeline(
  ctx: PipelineContext,
  deps: PipelineDeps,
): Promise<RunOutput> {
  const ingest = await ingestAll(ctx, { http: deps.http, crawlers: deps.crawlers });
  const { articles, dropped } = normalize(ingest.articles, ctx);
  const selected = await select(articles, ctx, { fs: deps.fs });

  // 历史库回放去重（先读后写都在 memory 单一写者内）
  const history = await loadHistory({ fs: deps.fs });
  const deduped = dedupeAgainstHistory(selected.articles, history, ctx);

  const enriched = await enrich(deduped.kept, ctx, { llm: deps.llm }, {
    filterResults: selected.filterResults,
  });
  const report = assembleReport(enriched, ctx);
  const html = renderHtml(report);
  const markdown = renderMarkdown(report);
  const speech = buildSpeechScript(report);

  await saveHistory(report, deduped.kept, ctx, { fs: deps.fs });
  const paths = await publishReport({ report, html, markdown }, ctx, { fs: deps.fs });

  ctx.log.info(
    "pipeline",
    `完成：原始 ${ingest.articles.length} / 归一化 ${articles.length}（丢 ${dropped}）/ 漏斗 ${selected.articles.length} / 历史去重丢 ${deduped.dropped} → 发布 ${paths.htmlPath}`,
  );
  ctx.log.info(
    "pipeline",
    `观测汇总：LLM 调用 ${ctx.stats.llmCalls ?? 0} 次（失败 ${ctx.stats.llmFailures ?? 0}），相关性回检丢弃 ${ctx.stats.recheckDropped ?? 0} 条`,
  );
  return { report, html, markdown, speech, paths };
}

/** 仅验证采集链路（fetch + 归一化 + 漏斗），不调 LLM、不渲染、不落盘。 */
export async function runDryRun(ctx: PipelineContext, deps: PipelineDeps) {
  const ingest = await ingestAll(ctx, { http: deps.http, crawlers: deps.crawlers });
  const { articles, dropped } = normalize(ingest.articles, ctx);
  const selected = await select(articles, ctx, { fs: deps.fs });
  ctx.log.info(
    "dry-run",
    `采集 ${ingest.articles.length} → 归一化 ${articles.length}（丢 ${dropped}）→ 漏斗 ${selected.articles.length}`,
  );
  return { raw: ingest.articles.length, normalized: articles.length, dropped, passed: selected.articles.length };
}
