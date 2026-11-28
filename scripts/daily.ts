/**
 * 入口：完整管线（采集 → 渲染 → 发布）。
 * 环境变量：REPORT_TZ / REPORT_DATE / SKIP_AI=1 / LLM_BACKEND / *_API_KEY。
 */
import "./_env";
import { bootstrap } from "../lib/orchestrator";
import { runPipeline } from "../lib/pipeline";
import { NodeFsAdapter, SystemClock } from "../lib/adapters";
import { loadHistoryStore } from "../lib/adapters/persistence";
import type { RunMode } from "../lib/contracts/pipeline";
import { setReportLocale } from "../lib/services/render/locale";
import { loadFocusForRun, recordFocusRun } from "../lib/pipeline/focus-context";
import { recordResearchRun } from "../lib/pipeline/research-context";

async function main() {
  const clock = new SystemClock();
  const date = process.env.REPORT_DATE || clock.todayKey();
  // SKIP_AI 模式（gzinfo 语义）：summaryCache=url→历史摘要（PASS2 确定性复用）；
  // relevantUrls=历史库已上榜条目（PASS1 只保留其中条目，防新抓垃圾混入板块）。
  const mode: RunMode = await (async () => {
    if (process.env.SKIP_AI !== "1") return { kind: "ai" as const };
    const fs = new NodeFsAdapter();
    const hist = loadHistoryStore();
    const summaryCache = new Map<string, string>();
    const relevantUrls = new Set<string>();
    for (const [url, e] of Object.entries(hist)) {
      relevantUrls.add(url);
      if (e.summary?.trim()) summaryCache.set(url, e.summary.trim());
    }
    return { kind: "skip-ai" as const, summaryCache, relevantUrls };
  })();

  const { ctx, deps } = await bootstrap({ date, mode });
  const out = await runPipeline(ctx, deps);

  // 二期 WP7：经营重点台账 + 配置版本归档（`data/focus-ledger.json` / `data/focus/versions.json`）。
  // 只在这里写 —— runPipeline 也被 replay / 单测直接调用，写进管线会给真实台账灌假日期。
  // 重载一次配置（不带日志，管线里已打印过）：同一 date + 同一份配置 → 同一批重点与版本号。
  const fc = loadFocusForRun(out.report.date, ctx.config.focusEngine);
  recordFocusRun(out.report, fc.items, fc.version, ctx.log);

  // 研报台账（`data/research-ledger.json`）：与重点台账同理 —— **只在这里写**。
  // runPipeline 也被 e2e / replay / 单测直接调用，写进管线会给真实台账灌假日期
  //（2026-11-28 从 side-outputs/side-research 挪出，见 pipeline/research-context 注释）。
  recordResearchRun(ctx.researchCaptured, out.report.date, ctx.log);

  if (ctx.errors.length)
    ctx.log.warn("daily", `运行期 ${ctx.errors.length} 条源级错误`, { count: ctx.errors.length });
  ctx.log.info("daily", `产物已生成：${out.paths.htmlPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
