import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capLightAiSources,
  LIGHT_AI_SOURCES,
  takeGlobalTopByValue,
} from "../lib/services/select/filters/light-ai";

interface FakeArticle {
  url: string;
  sourceId: string;
  publishedAt: Date;
}

function mk(url: string, sourceId: string, daysAgo: number): FakeArticle {
  return {
    url,
    sourceId,
    publishedAt: new Date(Date.now() - daysAgo * 86_400_000),
  };
}

test("capLightAiSources：lightAi 源每源最多 6 条且取最新，其余源全保留", () => {
  const arts: FakeArticle[] = [];
  // lightAi 源 cnfin 给 10 条（日期 0~9 天前）
  for (let i = 0; i < 10; i++) arts.push(mk(`cnfin-${i}`, "cnfin", i));
  // 非 lightAi 源 sina-bank 给 10 条
  for (let i = 0; i < 10; i++) arts.push(mk(`sina-${i}`, "sina-bank", i));

  const out = capLightAiSources(arts, LIGHT_AI_SOURCES, 6);
  const cnfin = out.filter((a) => a.sourceId === "cnfin");
  const sina = out.filter((a) => a.sourceId === "sina-bank");
  assert.equal(cnfin.length, 6, "cnfin 应被限流到 6 条");
  assert.equal(sina.length, 10, "sina-bank（非 lightAi）应全保留");
  // cnfin 保留的应是最新的 6 条（daysAgo 0~5）
  const days = cnfin
    .map((a) => Math.round((Date.now() - a.publishedAt.getTime()) / 86_400_000))
    .sort((x, y) => x - y);
  assert.deepEqual(days, [0, 1, 2, 3, 4, 5]);
});

test("capLightAiSources：多 lightAi 源各自独立限流", () => {
  const arts: FakeArticle[] = [];
  for (let i = 0; i < 9; i++) arts.push(mk(`cnfin-${i}`, "cnfin", i));
  for (let i = 0; i < 9; i++) arts.push(mk(`stcn-${i}`, "stcn", i));
  const out = capLightAiSources(arts, LIGHT_AI_SOURCES, 6);
  assert.equal(out.filter((a) => a.sourceId === "cnfin").length, 6);
  assert.equal(out.filter((a) => a.sourceId === "stcn").length, 6);
  assert.equal(out.length, 12);
});

test("capLightAiSources：空输入安全返回空", () => {
  assert.deepEqual(capLightAiSources([], LIGHT_AI_SOURCES, 6), []);
});

// ---------- 全局相关性取 Top N（2026-09-16 用户口径，取代每源等额配额）----------

interface ScoredFake extends FakeArticle {
  score: number;
}

function mkScored(url: string, sourceId: string, score: number): ScoredFake {
  return { url, sourceId, publishedAt: new Date(0), score };
}

test("takeGlobalTopByValue：打通排名 —— 大源高分条目挤掉小源低分条目（旧口径做不到）", () => {
  // 旧口径（每源等额 1）：A90/A85 + B60/B20 全保留（4 条）
  // 新口径（总量 3 + 每源软上限 1）：按分取 A90 → B60（A 已满、B20 分低被跳过）
  const arts = [mkScored("a1", "A", 90), mkScored("a2", "A", 85), mkScored("b1", "B", 60), mkScored("b2", "B", 20)];
  const out = takeGlobalTopByValue(arts, 3, 1, (a) => (a as ScoredFake).score);
  assert.deepEqual(
    out.map((a) => a.url),
    ["a1", "b1"],
    "软上限 1 时：A 只留最高分的 a1，b2（20 分）不应因「小源」而保留",
  );
});

test("takeGlobalTopByValue：总量 topN 生效（软上限允许时也最多取 totalN 条）", () => {
  const arts = [
    mkScored("a1", "A", 90), mkScored("a2", "A", 85), mkScored("a3", "A", 80),
    mkScored("b1", "B", 70), mkScored("b2", "B", 60),
  ];
  const out = takeGlobalTopByValue(arts, 3, 2, (a) => (a as ScoredFake).score);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((a) => a.url), ["a1", "a2", "b1"], "按分降序收满 3 条（A 软上限 2）");
});

test("takeGlobalTopByValue：软上限传 0 = 不限制单源（纯全局 topN）", () => {
  const arts = [mkScored("a1", "A", 90), mkScored("a2", "A", 85), mkScored("a3", "A", 80)];
  const out = takeGlobalTopByValue(arts, 3, 0, (a) => (a as ScoredFake).score);
  assert.deepEqual(out.map((a) => a.url), ["a1", "a2", "a3"], "软上限 0 → 单源可占满");
});

test("takeGlobalTopByValue：同分按发布时间倒序（与候选池其它排序同口径）", () => {
  const mkT = (url: string, sourceId: string, score: number, ts: number): ScoredFake => ({
    url, sourceId, score, publishedAt: new Date(ts),
  });
  const t0 = Date.parse("2026-09-16T00:00:00Z");
  const arts = [
    mkT("old", "A", 50, t0),
    mkT("new", "B", 50, t0 + 60_000),
  ];
  const out = takeGlobalTopByValue(arts, 1, 1, (a) => (a as ScoredFake).score);
  assert.deepEqual(out.map((a) => a.url), ["new"], "同分取更新者");
});
