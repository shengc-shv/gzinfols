import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildIpoCrawlers,
  buildLocalOnlyIpoCrawlers,
  buildOnlineIpoCrawlers,
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
