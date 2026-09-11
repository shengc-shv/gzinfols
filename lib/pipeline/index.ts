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
import { assembleBriefingScript, type AudioMeta } from "../services/voice";
import { publishReport } from "../services/publish";
import { loadHistory, saveHistory } from "../services/memory";

export interface RunOutput {
  report: DailyReport;
  html: string;
  markdown: string;
  speech: string;
  /** 音频元数据（TTS 成功时才有；渲染播放器用） */
  audio?: AudioMeta;
  paths: { reportPath: string; htmlPath: string; mdPath: string };
}

/** 完整管线：采集 → 归一化 → 漏斗 → 历史去重 → 富集 → 组装 → 口播稿/TTS → 渲染 → 记忆 → 发布。 */
export async function runPipeline(
  ctx: PipelineContext,
  deps: PipelineDeps,
): Promise<RunOutput> {
  const ingest = await ingestAll(ctx, { http: deps.http, crawlers: deps.crawlers });
  const { articles, dropped } = normalize(ingest.articles, ctx);

  // 历史库先读（跨天标题判重 stage 6 需要；先读后写都在 memory 单一写者内）
  const history = await loadHistory({ fs: deps.fs });
  const selected = await select(articles, ctx, {
    fs: deps.fs,
    history: history.items.map((it) => ({
      title: it.title,
      url: it.url,
      sourceId: it.sourceId,
      publishedAt: it.publishedAt,
    })),
  });

  const enriched = await enrich(selected.articles, ctx, {
    llm: deps.llm,
    history: history.items.map((it) => ({
      url: it.url,
      summary: it.summary,
      publishedAt: it.publishedAt,
    })),
  });
  const report = assembleReport(enriched, ctx);

  // —— C8 语音：口播稿拼装（纯函数）→ TTS 合成（AUDIO_ENABLED 门控；失败降级为无播放器）——
  const briefing = assembleBriefingScript(report);
  const speech = briefing?.script ?? "";
  let audio: AudioMeta | undefined;
  if (deps.tts && briefing) {
    try {
      const r = await deps.tts.synthesize(briefing.script, ctx.date);
      audio = { src: `audio/briefing-${ctx.date}.mp3`, duration: formatDurationLabel(r.durationSec), backend: r.backend };
      ctx.log.info("voice", `TTS 完成（${r.backend}）：${r.bytes} bytes`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log.warn("voice", `TTS 失败，降级为无播放器（不阻断发布）：${msg}`);
    }
  } else if (briefing) {
    ctx.log.info("voice", `口播稿已拼装（${briefing.script.length} 字）；未启用 TTS（AUDIO_ENABLED !== "true"）`);
  }
  // 口播稿与段落落盘（可观测性；gzinfo audio_script.txt / audio_parts.json 同款）
  if (briefing) {
    await deps.fs.writeText(`daily_reports/${ctx.date}/audio_script.txt`, briefing.script);
    await deps.fs.writeJson(`daily_reports/${ctx.date}/audio_parts.json`, {
      date: ctx.date,
      parts: briefing.parts,
      segments: briefing.segments,
    });
  }

  const html = renderHtml(report, { audio });
  const markdown = renderMarkdown(report);

  await saveHistory(report, selected.articles, ctx, { fs: deps.fs });
  const paths = await publishReport({ report, html, markdown }, ctx, { fs: deps.fs });

  ctx.log.info(
    "pipeline",
    `完成：原始 ${ingest.articles.length} / 归一化 ${articles.length}（丢 ${dropped}）/ 漏斗 ${selected.articles.length} → 发布 ${paths.htmlPath}${audio ? " + audio" : ""}`,
  );
  ctx.log.info(
    "pipeline",
    `观测汇总：LLM 调用 ${ctx.stats.llmCalls ?? 0} 次（失败 ${ctx.stats.llmFailures ?? 0}），相关性回检丢弃 ${ctx.stats.recheckDropped ?? 0} 条`,
  );
  return { report, html, markdown, speech, audio, paths };
}

/** 时长文案（gzinfo formatDuration 同口径；独立小函数避免跨服务导出耦合）。 */
function formatDurationLabel(secs: number): string {
  if (secs < 60) return `约 ${secs} 秒`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `约 ${m} 分 ${s} 秒`;
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
