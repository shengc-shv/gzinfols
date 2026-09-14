/**
 * 补齐 sidecar 缺失摘要（移植自 gzinfo scripts/regen-enrich.ts，2026-09-13 R2 批次）：
 * 不重跑完整 daily，只对指定「分类:子类」的 top-N 缺摘要条目做一次批量 LLM 摘要，
 * 打补丁回 sidecar `<date>-articles.json`。配额上调（如 politics 10→15）后补旧账用。
 *
 * 2.0 适配：
 *  - 凭证校验走 adapters/llm.ts 的 validateBackendCredentials（P4 补齐件）；
 *  - 源注册表经 FileStore 读（唯一真源），源语言过滤用 SourceDef.lang；
 *  - sidecar 路径 = daily_reports/<date>/<date>-articles.json（2.0 唯一存储口径；
 *    gzinfo 的 resolveDateDir 双写过渡期兼容在 2.0 不存在，不移植 paths.ts）。
 *
 * Usage:
 *   npm run regen:enrich -- finance:news
 *   npm run regen:enrich -- finance:news 2026-09-13
 *
 * 跑完再执行 `npm run render` 刷新 HTML。
 */
import "./_env";
import fsSync from "node:fs";
import path from "node:path";
import { NodeFsAdapter } from "../lib/adapters";
import { loadSources } from "../lib/orchestrator";
import { validateBackendCredentials, LlmAdapter } from "../lib/adapters/llm";
import { enrichFinanceNewsSummaries } from "../lib/services/enrich/batch-summaries";
import { dumpEnrichUndercount } from "../lib/adapters/llm-log";
import { MERGED_SUBGROUP_LIMITS, isSportsArticle } from "../lib/services/render/full";
import { setReportLocale, REPORT_LOCALE } from "../lib/services/render/locale";
import { todayKey } from "../lib/utils/time";
import type { ArticleInput } from "../lib/contracts/article";

async function main() {
  setReportLocale(process.env.REPORT_LOCALE); // 摘要语言注入（服务层不读 env）
  validateBackendCredentials(); // AI 模式启动即校验密钥（缺密钥立即报错并给修复提示）

  const target = process.argv[2];
  if (!target) throw new Error("用法：npm run regen:enrich -- <category>:<subcategory> [date]");
  const [category, subcategory] = target.split(":");
  if (
    category !== "gz" &&
    category !== "tech" &&
    category !== "finance" &&
    category !== "politics"
  ) {
    throw new Error(`Unknown category: ${category}`);
  }

  const date = process.argv[3] || todayKey();
  const fs = new NodeFsAdapter();
  const sources = await loadSources(fs);
  const sidecarPath = path.resolve(process.cwd(), "daily_reports", date, `${date}-articles.json`);
  if (!fsSync.existsSync(sidecarPath)) {
    throw new Error(`Sidecar not found: ${sidecarPath}（先跑 npm run daily 产出 sidecar）`);
  }
  const data = JSON.parse(fsSync.readFileSync(sidecarPath, "utf8")) as {
    date: string;
    articles: ArticleInput[];
  };

  const subSources = sources.filter(
    (s) =>
      s.category === category &&
      s.subcategory === subcategory &&
      s.enabled !== false,
  );
  const enabledIds = new Set(subSources.map((s) => s.id));
  const sameLocaleIds = new Set(
    subSources.filter((s) => (s.lang ?? "en") === REPORT_LOCALE).map((s) => s.id),
  );
  const limit = MERGED_SUBGROUP_LIMITS[`${category}:${subcategory}`] ?? 12;
  const top = data.articles
    .filter((a) => enabledIds.has(a.sourceId))
    .filter((a) => category !== "politics" || !isSportsArticle(a.title))
    .sort((a, b) => {
      const at = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const bt = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return bt - at;
    })
    .slice(0, limit);

  const missing = top.filter((a) => !sameLocaleIds.has(a.sourceId) && !a.summary);
  console.log(`[regen-enrich] ${target}: top ${top.length}, missing summary on ${missing.length}`);
  if (missing.length === 0) {
    console.log("[regen-enrich] nothing to do.");
    return;
  }

  const t0 = Date.now();
  const llm = new LlmAdapter();
  const runner = (system: string, user: string) => llm.complete({ system, prompt: user, stage: "enrich" });
  const summaries = await enrichFinanceNewsSummaries(
    missing.map((a) => ({ url: a.url, title: a.title, excerpt: a.excerpt, source: a.source })),
    runner,
    { dumpRaw: (i) => dumpEnrichUndercount(i.scope, i.rawText, i.requested, i.returned) }, // 「少回」诊断落盘（IO 由脚本层注入）
  );
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[regen-enrich] enrichment done in ${secs}s, matched ${summaries.size}/${missing.length}`);

  let patched = 0;
  for (const a of data.articles) {
    const sm = summaries.get(a.url);
    if (sm && !a.summary) {
      a.summary = sm;
      patched++;
    }
  }
  fsSync.writeFileSync(sidecarPath, JSON.stringify(data, null, 2), "utf8");
  console.log(`[regen-enrich] patched ${patched} articles in ${sidecarPath}`);
  console.log(`[regen-enrich] now run \`npm run render\` to refresh HTML.`);
}

main().catch((e) => {
  console.error("[regen-enrich] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
