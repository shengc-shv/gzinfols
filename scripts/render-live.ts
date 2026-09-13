/**
 * 无 AI 现场抓取渲染（移植自 gzinfo scripts/render.ts 的语义，2026-09-13 R2 批次；
 * 2.0 中 `npm run render` 已被「从 report.json 重渲染」占用，故本脚本名为 render:live）。
 *
 * 流程：现场采集（providers + crawlers，与 daily 同入口）→ 归一化 →
 *       buildNoAiReport（内容判定归属，无 AI 摘要用 excerpt 兜底）→ 完整版面渲染。
 *
 * 与 gzinfo 的差异：2.0 的采集/归一化直接复用管线服务（ingestAll + normalize），
 * 免去 gzinfo 版手写 dispatch 循环；无关键词漏斗（与 gzinfo render.ts 一致——
 * 预览要看到全量抓取效果，不做相关性筛）。
 *
 * Usage:
 *   npm run render:live            # 今天
 *   npm run render:live -- 2026-09-13
 */
import "./_env";
import { setReportLocale } from "../lib/services/render/locale";
import { bootstrap } from "../lib/orchestrator";
import { ingestAll } from "../lib/services/collect";
import { normalize } from "../lib/services/normalize";
import { buildNoAiReport } from "../lib/services/render/report-from-articles";
import { renderHtml, renderMarkdown } from "../lib/services/render";

async function main() {
  setReportLocale(process.env.REPORT_LOCALE); // 渲染语言注入（服务层不读 env）
  const arg = process.argv[2];
  const date = arg || new Date().toISOString().slice(0, 10);
  console.log(`🚀 无 AI 现场抓取渲染（${date}）...\n`);

  const { ctx, deps } = await bootstrap({ date, mode: { kind: "skip-ai", summaryCache: new Map(), relevantUrls: new Set() } });
  const ingest = await ingestAll(ctx, { http: deps.http, crawlers: deps.crawlers });
  const { articles, dropped } = normalize(ingest.articles, ctx);
  ctx.log.info(
    "render-live",
    `采集 ${ingest.articles.length} → 归一化 ${articles.length}（丢 ${dropped}；无时间红线丢弃为正常现象）`,
  );

  const report = buildNoAiReport(articles);
  const html = renderHtml(report);
  const md = renderMarkdown(report);

  await deps.fs.writeText(`daily_reports/${date}/${date}.html`, html);
  await deps.fs.writeText(`daily_reports/${date}/${date}.md`, md);
  console.log(`✅ 报告已生成: daily_reports/${date}/${date}.html（无 AI，仅供预览/核对采集）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
