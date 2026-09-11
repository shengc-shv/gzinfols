/**
 * 入口：完整管线（采集 → 渲染 → 发布）。
 * 环境变量：REPORT_TZ / REPORT_DATE / SKIP_AI=1 / LLM_BACKEND / *_API_KEY。
 */
import "./_env";
import { bootstrap } from "../lib/orchestrator";
import { runPipeline } from "../lib/pipeline";
import { NodeFsAdapter, SystemClock } from "../lib/adapters";
import { loadHistory } from "../lib/services/memory";
import type { RunMode } from "../lib/contracts/pipeline";

async function main() {
  const clock = new SystemClock();
  const date = process.env.REPORT_DATE || clock.todayKey(process.env.REPORT_TZ);
  // SKIP_AI 模式（gzinfo 语义）：summaryCache=url→历史摘要（PASS2 确定性复用）；
  // relevantUrls=历史库已上榜条目（PASS1 只保留其中条目，防新抓垃圾混入板块）。
  const mode: RunMode = await (async () => {
    if (process.env.SKIP_AI !== "1") return { kind: "ai" as const };
    const fs = new NodeFsAdapter();
    const hist = await loadHistory({ fs });
    const summaryCache = new Map<string, string>();
    const relevantUrls = new Set<string>();
    for (const it of hist.items) {
      relevantUrls.add(it.url);
      if (it.summary?.trim()) summaryCache.set(it.url, it.summary.trim());
    }
    return { kind: "skip-ai" as const, summaryCache, relevantUrls };
  })();

  const { ctx, deps } = await bootstrap({ date, mode });
  const out = await runPipeline(ctx, deps);

  if (ctx.errors.length)
    ctx.log.warn("daily", `运行期 ${ctx.errors.length} 条源级错误`, { count: ctx.errors.length });
  ctx.log.info("daily", `产物已生成：${out.paths.htmlPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
