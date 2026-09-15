/**
 * replay 入口：CI dump → 本地回填分析 → 全管线产出真实报告（验证「dump→replay」产出路径）。
 *
 * 链路：CI 用 LLM_BACKEND=dump 落盘全部 LLM 调用上下文（data/llm-dump/<runId>/）→
 * WorkBuddy 本地逐份撰写分析（pass1.response.txt / pass2.response.txt）→
 * 本脚本用 AdapterOverrides 注入「冻结文章池」（从 dump 的 PASS1 prompt 提取重建）+
 * replay 后端（读 data/replay/<date>/<stage>.response.txt）→ 跑完整管线 → 渲染发布产物。
 *
 * 用法：npx tsx scripts/replay-daily.ts [YYYY-MM-DD]（默认 2026-09-15）
 * 前置：data/replay/pool-<date>.json（scripts/_build-pool.mjs 生成）
 *       data/replay/<date>/pass1.response.txt / pass2.response.txt（scripts/_gen-replay.mjs 生成）
 */
import "./_env";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bootstrap } from "../lib/orchestrator";
import { runPipeline } from "../lib/pipeline";
import type { CrawlerRegistry } from "../lib/contracts/pipeline";

async function main() {
  const date = process.argv[2] || process.env.REPORT_DATE || "2026-09-15";
  // 环境变量须在 bootstrap（组合根读 env）之前设置：
  //  - LLM_BACKEND=replay：LLM 适配器读本地分析文件，不发真实调用
  //  - KEYWORD_FILTER/DEDUP_SIMILAR=off：冻结池文章已由本地分析逐条判定，
  //    关闭词表漏斗与相似度判重，保证 30 条原文无损到达 PASS1（窗口/单机构过滤仍生效）
  process.env.REPORT_DATE = date;
  process.env.LLM_BACKEND = "replay";
  process.env.LLM_REPLAY_DIR = resolve(process.cwd(), "data/replay", date);
  process.env.KEYWORD_FILTER = "off";
  process.env.DEDUP_SIMILAR = "off";

  const poolPath = resolve(process.cwd(), "data/replay", `pool-${date}.json`);
  const pool = JSON.parse(readFileSync(poolPath, "utf8")) as {
    ipo: unknown[]; gz: unknown[]; stocks: unknown[];
  };
  console.log(
    `[replay] 冻结池: ${poolPath}（ipo=${pool.ipo.length} gz=${pool.gz.length} stocks=${pool.stocks.length}）`,
  );
  const crawlers: CrawlerRegistry = {
    fetchCrawledArticles: async () => pool as never,
  };

  const { ctx, deps } = await bootstrap({
    date,
    mode: { kind: "ai" },
    adapterOverrides: { crawlers },
  });
  // 关闭全部 RSS/API 源的实时抓取（避免污染冻结池）；保留源定义用于展示名解析
  ctx.sources = ctx.sources.map((s) => ({ ...s, enabled: false }));

  const out = await runPipeline(ctx, deps);
  ctx.log.info("replay", `✅ replay 产物：${out.paths.htmlPath}`);
  console.log(`[replay] 报告: ${out.paths.htmlPath}`);
  console.log(`[replay] markdown: ${out.paths.mdPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
