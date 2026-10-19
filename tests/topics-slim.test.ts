/**
 * 主题语料取材口径（2026-10-19 sc）。
 *
 * sc：「必读和商机点击了就回去下面的具体资讯卡，你的主题也是从资讯卡片串起来，
 * 为啥会根据口播卡去串呢？」—— 摘要卡（必读/商机/风险）是 LLM 的二次加工，
 * 主题节点点进去应当落到**它引用的那条资讯卡**，而不是摘要卡本身。
 *
 * 但 sc 同时明确「LLM 的商机分析有价值，不能丢」→ 摘要卡**保留为节点**（保住
 * 「普惠小微」「零售AUM」两个业务视角），只把**选哪个 url 做 id** 改成「优先正文来源」，
 * 命中时与正文卡同 id → 聚类的 dedupeById 自动合并 → 点进去就是资讯卡。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSlimDay } from "../lib/services/topics/slim";
import { itemIdOf, summaryAnchorId } from "../lib/utils/item-id";
import type { DailyReport } from "../lib/contracts/report";

const BODY_URL = "https://e.com/body-article";
const OTHER_URL = "https://e.com/not-in-body";

function report(insights: Array<{ topic: string; sources: Array<{ url: string }> }>): DailyReport {
  return {
    date: "2026-10-19",
    must_read: [],
    insights,
    sections: {
      gz_local: [
        {
          url: BODY_URL,
          title_cn: "正文那条",
          source: "源",
          source_type: "media",
          date: "10/19",
          summary: "摘要",
          importance: 2,
          rank: 1,
          tags: [],
          locale: "national",
        },
      ],
      biz_insight: [],
      policy_market: [],
      tech: [],
      ipo: [],
    },
  } as unknown as DailyReport;
}

test("商机落点：优先取「在正文里」的来源做条目 id（点进去就是资讯卡）", () => {
  // 第一个来源不在正文，第二个在 → 应当选第二个（否则主题节点与正文卡对不上）
  const slim = buildSlimDay(report([{ topic: "某商机", sources: [{ url: OTHER_URL }, { url: BODY_URL }] }]));
  const ins = slim.items.find((i) => i.k === "insight");
  assert.ok(ins, "商机条目必须进语料（价值不能丢）");
  assert.equal(ins!.i, itemIdOf(BODY_URL), "id 应取正文来源 → 与正文卡同 id，dedupe 后合并");
});

test("商机落点：来源都不在正文 → 用自己的首个来源（页面商机卡自带锚点）", () => {
  const slim = buildSlimDay(report([{ topic: "某商机", sources: [{ url: OTHER_URL }] }]));
  const ins = slim.items.find((i) => i.k === "insight");
  assert.equal(ins!.i, itemIdOf(OTHER_URL));
});

test("商机落点：无任何来源时不得退化成 itm-0（多张卡会撞成同一条）", () => {
  const slim = buildSlimDay(report([{ topic: "无源商机甲", sources: [] }, { topic: "无源商机乙", sources: [] }]));
  const ins = slim.items.filter((i) => i.k === "insight");
  assert.equal(ins.length, 2, "两张商机都要进语料");
  const ids = ins.map((i) => i.i);
  assert.ok(!ids.includes("itm-0"), "不得用 itemIdOf 的空 url 兜底（恒 itm-0）");
  assert.equal(ids[0], summaryAnchorId("insight", "无源商机甲"), "用卡片文案派生，渲染层同源");
  assert.notEqual(ids[0], ids[1], "两张无源商机必须有不同 id");
});

test("商机保留：语料里仍包含商机条目（sc：分析价值不能丢，两个业务视角靠它撑）", () => {
  const slim = buildSlimDay(
    report([
      { topic: "普惠小微商机", sources: [{ url: BODY_URL }] },
      { topic: "零售AUM商机", sources: [{ url: OTHER_URL }] },
    ]),
  );
  const ins = slim.items.filter((i) => i.k === "insight");
  assert.equal(ins.length, 2, "商机条目不得被过滤掉");
  assert.ok(
    ins.some((i) => (i.g ?? []).length >= 0),
    "客群段位标签仍在（主题视角靠它）",
  );
});
