import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildIpoCrawlers,
  buildLocalOnlyIpoCrawlers,
  buildOnlineIpoCrawlers,
  selectIpoCrawlersForRun,
} from "../lib/adapters/crawlers";
import { LOCAL_ONLY_IPO_SOURCE_IDS } from "../lib/adapters/local-ipo";

const config = JSON.parse(
  readFileSync(join(process.cwd(), "sources.config.json"), "utf8"),
) as Array<{ id: string; role?: string }> | { sources: Array<{ id: string; role?: string }> };
const configIds = new Set(
  (Array.isArray(config) ? config : config.sources).map((s) => s.id),
);

test("注册一致性：每个 IPO 爬虫声明的 sourceId ∈ sources.config.json 白名单", () => {
  const problems: string[] = [];
  for (const crawler of buildIpoCrawlers()) {
    for (const id of crawler.sourceIds) {
      if (!configIds.has(id)) problems.push(`${crawler.name}: ${id} 未注册`);
    }
  }
  assert.equal(problems.length, 0, `未注册 sourceId（会被渲染白名单静默丢弃）:\n${problems.join("\n")}`);
});

test("本地专供白名单 ↔ buildLocalOnlyIpoCrawlers 一一对应（防两边漂移）", () => {
  const localIds = buildLocalOnlyIpoCrawlers().flatMap((c) => c.sourceIds);
  assert.deepEqual(
    [...localIds].sort(),
    [...LOCAL_ONLY_IPO_SOURCE_IDS].sort(),
    "LOCAL_ONLY_IPO_SOURCE_IDS 必须与本地专供爬虫产出的 sourceId 完全一致",
  );
});

test("在线源与本地专供源互斥，且并集 = 全量 IPO 源", () => {
  const online = buildOnlineIpoCrawlers().map((c) => c.name);
  const local = buildLocalOnlyIpoCrawlers().map((c) => c.name);
  const all = buildIpoCrawlers().map((c) => c.name);
  const overlap = online.filter((n) => local.includes(n));
  assert.equal(overlap.length, 0, "两集合必须互斥");
  assert.equal(online.length + local.length, all.length, "并集必须等于全量");
});

test("IPO 源已移交本地爬虫：CI（selectIpoCrawlersForRun）不执行任何 IPO 爬虫", () => {
  // 2026-10-04 sc：证监会辅导 / 深交所 / 上交所 / 北交所 / 港交所递表 全部改由
  // 本地 `npm run ipo:local` 抓取并提交 `data/local-ipo.json`，CI 只消费该文件。
  // CI 再抓一遍是重复劳动，且会把「同一条 IPO 动态的两个版本」同时带进批次。
  assert.deepEqual(
    selectIpoCrawlersForRun(),
    [],
    "CI 不得再执行任何 IPO 爬虫（数据来自 data/local-ipo.json）",
  );
  // 但**本地脚本与注册一致性测试**仍依赖这两个构建函数 —— 它们不是死代码，不能删。
  assert.ok(
    buildLocalOnlyIpoCrawlers().length > 0,
    "buildLocalOnlyIpoCrawlers 仍须保留（scripts/ipo-local.ts 依赖它）",
  );
  assert.ok(
    buildOnlineIpoCrawlers().length > 0,
    "buildOnlineIpoCrawlers 仍须保留（ipo:local --sources all 依赖它）",
  );
});
