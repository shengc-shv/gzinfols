/**
 * 标题相似度判重（lib/ingest/dedup-similar.ts）单测。
 * 规则：同主题（相似度≥阈值）最多 maxPerTheme 条，同 tier 只留 1 条；
 * 保留优先级 T1 > T1.5 > T2 > 无等级，同 tier 内取 publishedAt 最新。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dedupeByTitleSimilarity,
  titleSimilarity,
} from "../lib/services/select/filters/dedup-similar";
import type { ArticleInput } from "../lib/contracts/article";
import type { SourceTier } from "../lib/contracts/source";

const mk = (
  title: string,
  opts: { tier?: SourceTier; publishedAt?: string } = {},
): ArticleInput => ({
  sourceId: "test-src",
  publishedAt: new Date("2026-09-11T08:00:00Z"),
  source: "测试源",
  title,
  url: "https://x/" + encodeURIComponent(title),
  excerpt: "",
  category: "finance",
  isIpo: false,
  tier: opts.tier,
  ...(opts.publishedAt ? { publishedAt: new Date(opts.publishedAt) } : {}),
} as ArticleInput);

test("titleSimilarity：同主题变体标题相似度高，不同主题低", () => {
  const hi = titleSimilarity("LPR下调，广州多家银行跟进", "广州多家银行跟进LPR下调");
  assert.ok(hi >= 0.7, `同主题变体应 ≥0.7，实际 ${hi.toFixed(2)}`);
  const lo = titleSimilarity("央行降准释放流动性", "美联储宣布加息25个基点");
  assert.ok(lo < 0.7, `不同主题应 <0.7，实际 ${lo.toFixed(2)}`);
});

test("同 tier：两个政府源（T1）发同一主题 → 只留 1 条", () => {
  const { kept, removed } = dedupeByTitleSimilarity([
    mk("LPR下调，广州多家银行跟进", { tier: "T1", publishedAt: "2026-08-19T08:00:00Z" }),
    mk("广州多家银行跟进LPR下调", { tier: "T1", publishedAt: "2026-08-19T09:00:00Z" }),
  ]);
  assert.equal(kept.length, 1, "同 tier 只留 1 条");
  assert.equal(removed.length, 1);
  assert.ok(kept[0].title.includes("跟进LPR下调"), "同 tier 内取 publishedAt 最新（09:00）");
});

test("跨 tier：政府（T1）+ 媒体（T2）→ 各留 1 条，共 2", () => {
  const { kept, removed } = dedupeByTitleSimilarity([
    mk("LPR下调，广州多家银行跟进", { tier: "T1", publishedAt: "2026-08-19T08:00:00Z" }),
    mk("广州多家银行跟进LPR下调", { tier: "T2", publishedAt: "2026-08-19T09:00:00Z" }),
  ]);
  assert.equal(kept.length, 2, "不同 tier 可各留 1，共 2");
  assert.equal(removed.length, 0);
  assert.deepEqual(
    kept.map((k) => k.tier).sort(),
    ["T1", "T2"],
    "T1 + T2 各保留 1 条",
  );
});

test("三 tier：T1 + T1.5 + T2 → 按优先级留 T1 + T1.5（共 2），T2 移除", () => {
  const { kept, removed } = dedupeByTitleSimilarity([
    mk("LPR下调，广州多家银行跟进", { tier: "T2" }),
    mk("广州多家银行跟进LPR下调", { tier: "T1" }),
    mk("LPR下调，广州多家银行已跟进", { tier: "T1.5" }),
  ]);
  assert.equal(kept.length, 2, "总上限 2 条");
  assert.deepEqual(
    kept.map((k) => k.tier),
    ["T1", "T1.5"],
    "保留优先级 T1 > T1.5，T2 被移除",
  );
  assert.equal(removed.length, 1);
  assert.equal(removed[0].tier, "T2");
});

test("相似度低于阈值 → 全部保留", () => {
  const { kept, removed } = dedupeByTitleSimilarity([
    mk("央行降准释放流动性", { tier: "T1" }),
    mk("美联储宣布加息25个基点", { tier: "T2" }),
  ]);
  assert.equal(kept.length, 2);
  assert.equal(removed.length, 0);
});

test("maxPerTheme=1 → 每主题只留 1 条（同 tier 语义自然成立）", () => {
  const { kept, removed } = dedupeByTitleSimilarity(
    [
      mk("LPR下调，广州多家银行跟进", { tier: "T1" }),
      mk("广州多家银行跟进LPR下调", { tier: "T2" }),
    ],
    { threshold: 0.7, maxPerTheme: 1 },
  );
  assert.equal(kept.length, 1);
  assert.equal(removed.length, 1);
  assert.equal(kept[0].tier, "T1", "maxPerTheme=1 时保留最高 tier");
});

test("无 tier 条目：视为独立等级，簇未超上限时与 T2 各留 1 条", () => {
  const { kept, removed } = dedupeByTitleSimilarity([
    mk("LPR下调，广州多家银行跟进", { tier: "T2" }),
    mk("广州多家银行跟进LPR下调", {}), // 无 tier
  ]);
  assert.equal(kept.length, 2, "T2 与无等级是不同等级，各留 1 条（共 2，未超上限）");
  assert.equal(removed.length, 0);
});

test("无 tier 条目：簇超上限时排在最后被移除（T1+T2+无等级 → 留 T1+T2）", () => {
  const { kept, removed } = dedupeByTitleSimilarity([
    mk("LPR下调，广州多家银行跟进", { tier: "T2" }),
    mk("广州多家银行跟进LPR下调", {}),
    mk("LPR下调，广州多家银行已跟进", { tier: "T1" }),
  ]);
  assert.equal(kept.length, 2);
  assert.deepEqual(kept.map((k) => k.tier), ["T1", "T2"], "无等级条目垫底被移除");
  assert.equal(removed.length, 1);
  assert.equal(removed[0].tier, undefined);
});

// —— 跨天判重（先来后到：历史先占位，新抓取仅在 tier 空缺且总数 < 上限时补充）——
import {
  dedupeAgainstHistory,
  type HistorySimilarEntry,
} from "../lib/services/select/filters/dedup-similar";

const hist = (
  title: string,
  tier: SourceTier | undefined,
  url = "https://hist/" + encodeURIComponent(title),
): HistorySimilarEntry => ({ title, url, tier });

test("跨天判重：历史已有同 tier 同主题 → 新条目丢弃（政府今天发，媒体明天再发同 tier 无效）", () => {
  const { kept, removed } = dedupeAgainstHistory(
    [mk("LPR下调，广州多家银行跟进", { tier: "T1" })],
    [hist("广州多家银行跟进LPR下调", "T1")],
  );
  assert.equal(kept.length, 0, "同 tier 已被历史占位，新条目丢弃");
  assert.equal(removed.length, 1);
});

test("跨天判重：历史有 T1、新来 T2（该 tier 空缺）→ 保留（政府+媒体各 1）", () => {
  const { kept, removed } = dedupeAgainstHistory(
    [mk("LPR下调，广州多家银行跟进", { tier: "T2" })],
    [hist("广州多家银行跟进LPR下调", "T1")],
  );
  assert.equal(kept.length, 1, "T2 空缺，补充为第 2 条");
  assert.equal(removed.length, 0);
});

test("跨天判重：历史已满 2 条（T1+T1.5）→ 新来 T2 丢弃", () => {
  const { kept, removed } = dedupeAgainstHistory(
    [mk("LPR下调，广州多家银行跟进", { tier: "T2" })],
    [
      hist("广州多家银行跟进LPR下调", "T1"),
      hist("LPR下调，广州多家银行已跟进", "T1.5"),
    ],
  );
  assert.equal(kept.length, 0, "总数已满 2，新 tier 也不补充");
  assert.equal(removed.length, 1);
});

test("跨天判重：历史无相似主题 → 保留", () => {
  const { kept, removed } = dedupeAgainstHistory(
    [mk("美联储宣布加息25个基点", { tier: "T1" })],
    [hist("广州多家银行跟进LPR下调", "T1")],
  );
  assert.equal(kept.length, 1);
  assert.equal(removed.length, 0);
});

test("跨天判重：相似度低于阈值 → 保留（不同主题）", () => {
  const { kept } = dedupeAgainstHistory(
    [mk("央行降准释放流动性", { tier: "T1" })],
    [hist("LPR下调，广州多家银行跟进", "T2")],
  );
  assert.equal(kept.length, 1);
});

test("跨天判重：历史无 tier 条目视为独立等级，可补 1 条", () => {
  const { kept, removed } = dedupeAgainstHistory(
    [mk("LPR下调，广州多家银行跟进", { tier: "T2" })],
    [hist("广州多家银行跟进LPR下调", undefined)],
  );
  assert.equal(kept.length, 1, "历史为无等级、新来 T2，等级不同且未满 2 → 保留");
  assert.equal(removed.length, 0);
});
