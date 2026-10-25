/**
 * 定调跨天重复判据（2026-10-25 sc）—— 校准样本取自 10-22 ~ 10-25 四期**真实定调**。
 *
 * 背景：定调不走事件判重、不写事件记忆 → 跨天重复无人发现。10-25 实测定调第一个方面
 * 与 10-24 逐字相同（「广东经济增速创五年新高」），而三道既有审计全过
 * （该素材当天在板块卡里有出处）。
 *
 * 判据：按「；」切方面后取最大 bigram Jaccard，阈值 HERO_REPEAT_JACCARD = 0.35。
 * 阈值依据见下方实测断言。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  heroAspectsOf,
  heroRepeatsPrev,
  HERO_REPEAT_JACCARD,
} from "../lib/services/memory/exec-guard";
import { formatMemoryBrief } from "../lib/services/memory/event-brief";
import type { EventMemoryStore } from "../lib/services/memory/event-types";

const H1022 =
  "今天主要看四个方面：扩大内需实施方案在研，消费与小微支持政策待明确；寿险利差损风险被点名，行业资产端压力受关注；保险要精准对接薄弱环节，普惠与养老保障衔接提速；北交所拟引入市值配售，打新与流动性规则或调整。";
const H1023 =
  "今天主要看三个方面：广东五篇大文章贷款14.1万亿，占比近五成；房贷贴息拉动广深低总价房源成交；理财规模重回35万亿上方，债基限购收紧。";
const H1024 =
  "今天主要看四个方面：广东经济增速创五年新高，基本面支撑强；AI与跨境政策双落地，科技金融和跨境客群有新窗口；理财规模破35万亿，财富货架回暖；公积金扩围灵活就业者，住房金融客群扩容。";
const H1025 =
  "今天主要看三个方面：广东经济增速创五年新高，本地信贷基本面有支撑；广交会二期与科技金融周接续，跨境与科创客群集中；黄金4300美元保卫战与美联储议息，财富货架面临波动。";

test("定调跨天重复：10-25 vs 10-24 必须判重复（用户报的问题）", () => {
  const r = heroRepeatsPrev(H1025, H1024);
  assert.equal(r.repeat, true, `应判重复（${r.matched}）`);
  assert.ok(r.matched?.includes("广东经济增速"), "命中方面应是广东经济增速");
});

test("定调跨天不误报：相邻但内容不同的期次不得判重复", () => {
  // 10-24 vs 10-23：都有「财富/理财」主题，但是不同事件
  assert.equal(heroRepeatsPrev(H1024, H1023).repeat, false, "10-24 vs 10-23 不应判重复");
  // 10-23 vs 10-22：完全不同
  assert.equal(heroRepeatsPrev(H1023, H1022).repeat, false, "10-23 vs 10-22 不应判重复");
});

test("阈值依据：重复方面 Jaccard 0.68，非重复方面 ≤ 0.18", () => {
  const dup = heroAspectsOf(H1025)[0];
  const dupPrev = heroAspectsOf(H1024)[0];
  const bi = (t: string) => {
    const c = t.replace(/[^\p{L}\p{N}]+/gu, "");
    const s = new Set<string>();
    for (let i = 0; i < c.length - 1; i++) s.add(c.slice(i, i + 2));
    return s;
  };
  const a = bi(dup), b = bi(dupPrev);
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  const j = inter / (a.size + b.size - inter);
  assert.ok(j >= 0.5, `重复方面 Jaccard 应 ≥ 0.5，实得 ${j.toFixed(2)}`);
  assert.ok(HERO_REPEAT_JACCARD < j, `阈值 ${HERO_REPEAT_JACCARD} 应低于实测 ${j.toFixed(2)}`);
  // 对照：非重复方面（10-24 第二方面 vs 10-25 第二方面）必须显著更低
  const c = bi(heroAspectsOf(H1024)[1]), d = bi(heroAspectsOf(H1025)[1]);
  let ci = 0;
  for (const g of c) if (d.has(g)) ci++;
  const jc = ci / (c.size + d.size - ci);
  assert.ok(jc <= 0.25, `非重复方面 Jaccard 应 ≤ 0.25，实得 ${jc.toFixed(2)}`);
  assert.ok(jc < j * 0.5, "重复/非重复应拉开两倍以上差距");
});

test("方面切分：兼容「；」分隔与无分隔短定调", () => {
  assert.equal(heroAspectsOf(H1025).length, 3, "10-25 应切出 3 个方面");
  assert.equal(heroAspectsOf(H1024).length, 4, "10-24 应切出 4 个方面");
  assert.equal(heroAspectsOf("今天主要看一个方面：黄金大涨").length, 1, "单方面");
  assert.equal(heroAspectsOf("").length, 0, "空串");
});

test("记忆提示注入「昨日定调」：LLM 生成阶段就能避开", () => {
  const text = formatMemoryBrief([], H1024);
  assert.ok(text.includes("【昨日定调】"), "应含昨日定调段");
  assert.ok(text.includes("广东经济增速创五年新高"), "应含昨日定调原文");
  assert.ok(text.includes("不要原样重复"), "应含避开指令");
  // 无昨日定调时不产出该段（不误注入空块）
  assert.equal(formatMemoryBrief([], "").includes("【昨日定调】"), false);
  // 有事件清单时两段并存
  const both = formatMemoryBrief(
    [{ title: "某事件", lastBroadcast: "2026-10-24", daysSince: 1, count: 2, suggestedAngle: "数据验证", angleGuide: "g" }],
    H1024,
  );
  assert.ok(both.includes("【昨日定调】") && both.includes("【内容记忆·去重约束】"), "两段应并存");
});

test("store 类型承载 lastHeroLine：guard 覆写 → 下次运行即「昨日定调」", () => {
  const store: EventMemoryStore = { version: 1, events: {}, lastHeroLine: H1024 };
  assert.equal(store.lastHeroLine, H1024);
});
