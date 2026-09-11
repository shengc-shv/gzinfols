/**
 * 入口：完整管线（采集 → 渲染 → 发布）。
 * 环境变量：REPORT_TZ / REPORT_DATE / SKIP_AI=1 / LLM_BACKEND / *_API_KEY。
 */
import "./_env";
import { bootstrap } from "../lib/orchestrator";
import { runPipeline } from "../lib/pipeline";
import { SystemClock } from "../lib/adapters";
import type { RunMode } from "../lib/contracts/pipeline";

async function main() {
  const clock = new SystemClock();
  const date = process.env.REPORT_DATE || clock.todayKey(process.env.REPORT_TZ);
  const mode: RunMode = process.env.SKIP_AI === "1" ? { kind: "skip-ai" } : { kind: "ai" };

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
