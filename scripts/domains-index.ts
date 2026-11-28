/**
 * 领域专题索引 · 运行入口（二期 WP10）。
 *
 * 产出 `data/domains.json`：把 `data/topics-corpus.json` 按六大经营领域聚合，
 * 供 `build-site` 渲染 `site/domains.html`（生成器在 `scripts/lib/domains-page.mjs`）。
 *
 * 为什么不在 build-site 里直接算：领域判定是**生产口径**（`classifyBusinessDomain`），
 * 只有 TS 侧能复用；在 mjs 里重写一套关键词匹配，迟到一天就会出现「日报归 A 领域、
 * 专题页归 B 领域」。这与主题跟踪「TS 出数据 → mjs 只渲染」是同一套分工。
 *
 * 零 LLM、零网络、零新采集；缺语料时产出空索引（exit 0），页面自己出空态。
 */
import "./_env";
import fs from "node:fs";
import path from "node:path";
import type { TopicCorpus } from "../lib/services/topics/corpus";
import { buildDomainIndex } from "../lib/services/vocab/domains-index";

const CORPUS_PATH = path.resolve("data/topics-corpus.json");
const OUT_PATH = path.resolve("data/domains.json");
const WINDOW_RUNS = Number(process.env.DOMAINS_WINDOW_RUNS || 30) || 30;

function main(): void {
  let corpus: TopicCorpus | null = null;
  if (fs.existsSync(CORPUS_PATH)) {
    try {
      corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8")) as TopicCorpus;
    } catch (e) {
      // 语料坏 → 不写坏索引（与 research-ledger「corrupt 拒写回」同一原则），
      // 保留上一版 domains.json 让页面继续可用。
      console.error(`[domains-index] 语料解析失败，跳过本轮（保留上一版索引）：${e instanceof Error ? e.message : e}`);
      process.exit(0);
    }
  } else {
    console.log("[domains-index] 无语料文件 → 产出空索引（页面走空态）");
  }

  const index = buildDomainIndex({ days: corpus?.days ?? {}, windowRuns: WINDOW_RUNS });

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(index, null, 0), "utf8");

  const parts = index.domains
    .filter((d) => d.count > 0)
    .map((d) => `${d.short} ${d.count}`);
  console.log(
    index.total
      ? `[domains-index] ${index.total} 条 / ${index.windowRuns} 期（基准 ${index.generatedAt}）：` +
          `${index.classified} 条可归入领域（${((index.classified / index.total) * 100).toFixed(1)}%）` +
          (parts.length ? `｜${parts.join("、")}` : "｜各领域均为 0")
      : "[domains-index] 空索引（无语料）",
  );
}

main();
