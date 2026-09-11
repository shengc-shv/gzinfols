/**
 * 入口：仅验证采集链路（fetch + 归一化 + 漏斗），不调 LLM、不渲染、不落盘。
 * 用于无密钥 / 离线快速校验源配置是否可用。
 */
import "./_env";
import { bootstrap } from "../lib/orchestrator";
import { runDryRun } from "../lib/pipeline";
import { SystemClock } from "../lib/adapters";

async function main() {
  const clock = new SystemClock();
  const date = process.env.REPORT_DATE || clock.todayKey();
  const { ctx, deps } = await bootstrap({ date, mode: { kind: "ai" } });
  const r = await runDryRun(ctx, deps);
  ctx.log.info(
    "dry-run",
    `采集 ${r.raw} → 归一化 ${r.normalized}（丢弃 ${r.dropped}）→ 漏斗放行 ${r.passed}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
