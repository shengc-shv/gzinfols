import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, normalizeOne } from "../lib/services/normalize";
import type { RawArticle } from "../lib/contracts/article";
import { SilentLog } from "./helpers";

function raw(over: Partial<RawArticle> = {}): RawArticle {
  return { sourceId: "s", title: "t", url: "u", category: "tech", ...over };
}

test("红线#1：无 publishedAt 的条目被归一化丢弃", () => {
  assert.equal(normalizeOne(raw()), null);
  assert.equal(
    normalizeOne(raw({ publishedAt: new Date("invalid") })),
    null,
    "非法日期视同无发布时间",
  );
});

test("红线#1：有发布时间的条目转入 NormalizedArticle 且 publishedAt 必填", () => {
  const n = normalizeOne(raw({ publishedAt: new Date("2026-09-11T08:00:00Z") }));
  assert.ok(n);
  assert.ok(n!.publishedAt instanceof Date);
  assert.equal(n!.tier, undefined, "未声明 tier 的源保持 undefined（gzinfo 无等级垫底语义）");
  assert.ok(n!.excerpt.length > 0, "excerpt 非空兜底");
});

test("normalize 批量：统计丢弃数且透传 source 展示名", () => {
  const ctx = {
    sources: [{ id: "s", name: "源S" }],
    tierBySource: new Map(),
    log: new SilentLog(),
  } as unknown as Parameters<typeof normalize>[1];
  const { articles, dropped } = normalize(
    [raw({ publishedAt: new Date() }), raw()],
    ctx,
  );
  assert.equal(articles.length, 1);
  assert.equal(dropped, 1);
  assert.equal(articles[0].source, "源S");
});
