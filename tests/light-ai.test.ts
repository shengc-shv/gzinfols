import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capLightAiSources,
  LIGHT_AI_SOURCES,
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
