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
import { selectLocalIpoItems } from "../lib/adapters/local-ipo";
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
  // 撰写规范校验：exec 产物的 insights[].segments 必填（商机洞察三维客群标签：
  // 零售AUM / 中高端客群(过亿资产) / 普惠小微贷款客户）。缺失会导致线上报告
  // 「业务启示」板块丢失 AUM/高端客户/普惠小微标签（2026-09-15 实测教训）。
  try {
    const exec = JSON.parse(
      readFileSync(resolve(process.cwd(), "data/replay", date, "executive.response.txt"), "utf8"),
    ) as { insights?: Array<{ topic?: string; segments?: unknown }> };
    const missing = (exec.insights ?? [])
      .filter((it) => !Array.isArray(it.segments) || it.segments.length === 0)
      .map((it) => it.topic ?? "(无 topic)");
    if (missing.length > 0) {
      console.warn(
        `[replay] ⚠️ executive.response.txt 有 ${missing.length} 条 insights 缺 segments 字段：` +
          `${missing.join("、")}。渲染将丢失三维客群标签（零售AUM/高端客户/普惠小微），` +
          `请按 mapTagsToSegments(tag, topic) 补齐后重放。`,
      );
    }
  } catch {
    // exec response 不存在时由 replay 后端自行报错，这里不处理
  }
  // 合并本地 IPO 补数（对齐 CI 行为：crawlers/index.ts 同样调 selectLocalIpoItems）
  // ——CI 读 data/local-ipo.json（本地 npm run ipo:local 产出）拼进抓取结果，
  //   重放必须复现同一输入，否则当期报告的辅导/审核条目会比线上 gzinfo 少。
  const localIpo = selectLocalIpoItems(pool.ipo as never);
  console.log(`[replay] 本地 IPO 补数并入: ${localIpo.length} 条（csrcfd 辅导 / szse 审核）`);
  const crawlers: CrawlerRegistry = {
    fetchCrawledArticles: async () =>
      ({ ...pool, ipo: [...pool.ipo, ...localIpo] }) as never,
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
