/**
 * 管道编排（C1→C9 顺序）：把各服务按阶段串起来。
 *
 * 编排层只「调用服务 + 传递 deps」，不实现业务逻辑；业务规则全在各 lib/services/*。
 * B3 起编排顺序与 gzinfo 对齐（lib/pipeline/ai.ts + history-step + side-outputs）：
 *   采集 → 归一化 → 过滤 → AI 两阶段 → 组装 → 历史回流+滚动并入 → 旁路（必读/商机/广东IPO）
 *   → 口播稿/TTS → 渲染 → 发布。
 * 历史库：管线开头 load（跨天判重/prefill 用），history-step 中 merge+persist（gzinfo 同位）。
 */
import type { DailyReport } from "../contracts/report";
import type { PipelineContext, PipelineDeps } from "../contracts/pipeline";
import { ingestAll } from "../services/collect";
import { normalize } from "../services/normalize";
import { select } from "../services/select";
import { enrich } from "../services/enrich";
import { assembleReport } from "../services/assemble";
import { applyDisplayCaps } from "../services/assemble/display-cap";
import { mergeRollingAndSaveHistory } from "./history-step";
import { buildSideOutputs } from "./side-outputs/side-outputs";
import { renderHtml, renderMarkdown } from "../services/render";
import { assembleBriefingScript, type AudioMeta } from "../services/voice";
import { publishReport } from "../services/publish";
import { companyNameOf } from "../services/classify/gd-ipo-spoken";
import { loadHistoryStore, loadExecStore, loadEventMemory, saveEventMemory } from "../adapters/persistence";
import { dayGap } from "../utils/time";
import { recordIpoVoicing, ipoShouldSkip } from "../services/memory/event-memory";

export interface RunOutput {
  report: DailyReport;
  html: string;
  markdown: string;
  speech: string;
  /** 音频元数据（TTS 成功时才有；渲染播放器用） */
  audio?: AudioMeta;
  paths: { reportPath: string; htmlPath: string; mdPath: string };
}

/** 完整管线：采集 → 归一化 → 漏斗 → 富集 → 组装 → 历史回流/滚动并入 → 旁路 → 口播/TTS → 渲染 → 发布。 */
export async function runPipeline(
  ctx: PipelineContext,
  deps: PipelineDeps,
): Promise<RunOutput> {
  const ingest = await ingestAll(ctx, { http: deps.http, crawlers: deps.crawlers });
  const { articles, dropped } = normalize(ingest.articles, ctx);

  // 历史库先读（跨天标题判重 stage6 / prefillCache / exec 两天池共用同一份）
  const history = loadHistoryStore();
  const selected = await select(articles, ctx, { fs: deps.fs, history });

  const enriched = await enrich(selected.articles, ctx, { llm: deps.llm, history });
  const report = assembleReport(enriched, ctx);

  // —— gzinfo history-step：PASS2 摘要回流 → merge+persist → buildRolling → 滚动并入 ——
  const histStep = mergeRollingAndSaveHistory(report, selected.articles, history, ctx);

  // —— gzinfo side-outputs：必读/商机/风险旁路（2 日窗口）+ 广东IPO 板块（绕过相关性 LLM）——
  // 股市复盘三卡 / 股市消息清单随 B4 接入。
  const withSides = await buildSideOutputs(
    histStep.report,
    histStep.history,
    selected.articles,
    articles,
    ingest.crawled,
    ctx,
    selected.filterResults,
    { llm: deps.llm, http: deps.http },
  );

  // —— ⑦ 展示限额（gzinfo daily.ts 第⑦步）：每源≤4 按价值排序、板块上限、gz 保底 ——
  // 位置与 gzinfo 一致：side outputs 之后（exec 池不受影响）、语音/渲染之前。
  const capped = applyDisplayCaps(withSides, ctx);
  // A5（2026-09-16 数据戳颗粒度）：把 select 算出的「每源 抓取 → 收录」带进报告，
  // 供渲染层透明展示覆盖度（复用同一次漏斗统计，口径一致，不额外计算）。
  if (selected.sourceStats?.length) capped.sourceStats = selected.sourceStats;

  // —— ⑦.5 广东IPO 健康度（gzinfo 同位；此前函数已定义但漏接线，2026-09-13 修复）——
  checkIpoHealth(capped, ctx);

  // —— ⑦.6 主板块覆盖度（2026-09-14 P0-2）：四主板块合计为 0 → 显式告警 ——
  checkSectionCoverage(capped, ctx);

  // —— C8 语音：口播稿拼装（gzinfo 链路：执行摘要 store.json 为主输入，无 exec 则跳过）——
  // → TTS 合成（AUDIO_ENABLED 门控；失败降级为无播放器）
  const exec = loadExecStore(ctx.date);
  // IPO 口播事件记忆（gzinfo ipoVoicing）：读库算今日应跳过的企业；写回仅正式发布 run
  // 开关由组合根从 EVENT_MEMORY 注入 ctx.config（服务层不直读 env）
  const memoryOn = ctx.config.eventMemory;
  const ipoMem = memoryOn ? loadEventMemory() : null;
  const ipoSkip = new Set<string>();
  if (ipoMem) {
    for (const it of capped.sections.ipo ?? []) {
      const c = companyNameOf(it.title_cn || "");
      if (c && ipoShouldSkip(ipoMem, c, ctx.date)) ipoSkip.add(c);
    }
  }
  const briefing = exec
    ? await assembleBriefingScript(capped, {
        exec,
        ipoMemory: ipoMem
          ? {
              skip: ipoSkip,
              onVoiced: (companies) => {
                if (process.env.PUBLISH_RUN === "true") {
                  saveEventMemory(recordIpoVoicing(ipoMem, companies, ctx.date), { today: ctx.date });
                  ctx.log.info("voice", `IPO 口播记忆写回：${companies.join("、")}`);
                }
              },
            }
          : undefined,
      })
    : null;
  if (!exec) {
    ctx.log.info("voice", "无执行摘要（store.json 缺失），跳过语音播报生成（gzinfo 同款降级）");
  }
  const speech = briefing?.script ?? "";
  let audio: AudioMeta | undefined;
  if (deps.tts && briefing) {
    try {
      const r = await deps.tts.synthesize(briefing.script, ctx.date);
      audio = {
        src: `audio/briefing-${ctx.date}.mp3`,
        duration: formatDurationLabel(r.durationSec),
        backend: r.backend,
        segments: briefing.segments,
      };
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

  // 渲染注入（P0-4）：分享基址 / Web 模式取自 ctx.config，渲染时刻取 ctx.startTime
  // （服务层不读 env、不读隐式时钟）。
  const html = renderHtml(capped, {
    audio,
    baseUrl: ctx.config.reportBaseUrl,
    webMode: ctx.config.webMode,
    now: ctx.startTime,
  });
  const markdown = renderMarkdown(capped);
  // gzinfo render-and-write ②③：sidecar（滚动列表）+ 全量池导出（漏斗后条目）
  const paths = await publishReport(
    {
      report: capped,
      html,
      markdown,
      rolling: histStep.rolling,
      pool: selected.articles,
    },
    ctx,
    { fs: deps.fs },
  );

  ctx.log.info(
    "pipeline",
    `完成：原始 ${ingest.articles.length} / 归一化 ${articles.length}（丢 ${dropped}）/ 漏斗 ${selected.articles.length} / 历史库 ${Object.keys(histStep.history).length} → 发布 ${paths.htmlPath}${audio ? " + audio" : ""}`,
  );
  ctx.log.info(
    "pipeline",
    `观测汇总：LLM 调用 ${ctx.stats.llmCalls ?? 0} 次（失败 ${ctx.stats.llmFailures ?? 0}）`,
  );
  return { report: capped, html, markdown, speech, audio, paths };
}

/**
 * 广东IPO 健康度检查（gzinfo scripts/daily.ts ⑦.5 同款）：
 *  - 打印分类计数 + 每源条数（一眼看出哪个源当天是暗的）；
 *  - 广东条目 0 条 / 最新条目滞后 > 3 天 → ::warning::（GitHub Actions 高亮 + 注解区展示）。
 * 用 console 直写（非 ctx.log）：`::warning::` 必须位于行首才会被 Actions 识别为注解。
 */
function checkIpoHealth(report: DailyReport, ctx: PipelineContext): void {
  try {
    const ipoItems = report.sections?.ipo ?? [];
    const gdItems = ipoItems.filter((it) => (it.tags ?? []).includes("粤"));
    const bySource = new Map<string, number>();
    for (const it of gdItems) {
      const k = it.source || "未知源";
      bySource.set(k, (bySource.get(k) ?? 0) + 1);
    }
    const breakdown = [...bySource.entries()].map(([s, n]) => `${s} ${n}`).join(" / ") || "（无）";
    ctx.log.info(
      "ipo-health",
      `🏦 广东IPO：板块 ${ipoItems.length} 条 → 广东 ${gdItems.length} 条（${breakdown}）`,
    );
    if (gdItems.length === 0) {
      console.warn(
        "::warning:: [daily] 广东IPO 今日 0 条（7 天窗口）：可能确无动态，也可能是源抓取失败/字段改版 —— " +
          "请对照各源输出的「新鲜度告警」定位",
      );
    } else {
      const newest = gdItems.reduce((a, b) => (b.date > a ? b.date : a), "");
      if (/^\d{2}\/\d{2}$/.test(newest)) {
        const year = ctx.date.slice(0, 4);
        const gap = dayGap(`${year}-${newest.replace("/", "-")}`, ctx.date);
        if (gap > 3) {
          console.warn(
            `::warning:: [daily] 广东IPO 最新条目 ${newest} 已滞后 ${gap} 天：窗口内可能只剩历史存量，建议核查各源`,
          );
        }
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.errors.push({ stage: "ipo-health", message: msg });
    ctx.log.warn("ipo-health", `健康度检查异常（不阻断）：${msg}`);
  }
}

/**
 * 主板块覆盖度检查（2026-09-14 P0-2 新增）。
 *
 * 动机：归档 2026-09-14 报告时，`sections` 的 gz_local / biz_insight / policy_market / tech
 * **全部为 0 条**（产物 HTML 只剩 3 个 tab），但当时没有任何告警——静默归档到次日才被人工发现。
 * 「四个主板块合计为 0」意味着这期简报的主体是空的，必须显式可见。
 *
 * 根因（已修）：SKIP_AI 的 PASS1 allow-list 为空集时旧实现判为「全部无关」→ 一条不留。
 * 本检查作为**兜底观测**保留：无论未来何种原因导致主体为空，都必须在 CI 日志亮出来。
 *
 * 用 console 直写（非 ctx.log）：`::warning::` 必须位于行首才会被 GitHub Actions 识别为注解。
 */
function checkSectionCoverage(report: DailyReport, ctx: PipelineContext): void {
  try {
    const MAIN = ["gz_local", "biz_insight", "policy_market", "tech"] as const;
    const counts = MAIN.map((k) => ({ k, n: report.sections?.[k]?.length ?? 0 }));
    const total = counts.reduce((s, c) => s + c.n, 0);
    const breakdown = counts.map((c) => `${c.k} ${c.n}`).join(" / ");
    ctx.log.info("coverage", `📄 主板块覆盖：合计 ${total} 条（${breakdown}）`);
    if (total === 0) {
      console.warn(
        "::warning:: [daily] 四个主板块合计 0 条 —— 本期简报主体为空（只剩股市/IPO tab）。" +
          "请检查：① SKIP_AI 的 PASS1 allow-list 是否为空集（历史库 ai_relevant 是否已打标）；" +
          "② 全 AI 模式下 PASS1 是否整体 drop / LLM 是否降级；③ 采集与漏斗是否异常。详阅 docs/review-2026-09-14-arch.md P0-2",
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.errors.push({ stage: "coverage", message: msg });
    ctx.log.warn("coverage", `主板块覆盖度检查异常（不阻断）：${msg}`);
  }
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
