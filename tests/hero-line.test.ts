/**
 * 今日定调：文本口径、兜底派生与消费端标签（2026-09-27 sc 口径落地）。
 *
 * 口径（sc 2026-09-27）：「今日定调」是**当天关键事件的快速总结**，用于让听众在看正文前
 * 就知道后面「必读」与「商机」里要关注哪几个方面 —— 起**提纲挈领**的引导作用，
 * **不是**把已有内容换个说法复述一遍、也不是「再挑一条事件播报」。且不能只给方向词，
 * 要展开一句「为什么值得关注」。
 *
 * 本文件锁住四件事：
 *   ① `stripHeroPrefix`：历史遗留的「今日分行焦点：」前缀统一剥除（页面/企微/口播共用）；
 *   ② `deriveHeroLine`：由本次报告的必读+商机归纳「方向 + 为什么」（交错取用、上限 3 条、
 *      超长先砍主线、空素材回空串）；
 *   ③ 集成：定调判重命中 → 由归纳兜底（**不再从两天池挑事件**）、清空 spoken_hero；
 *      必读/商机皆空 → 保留原定调（红线：宁可重复，不留空）；
 *   ④ 消费端：页面 / 企微 markdown / 企微 text 各自只加一份标签，不得出现双标签。
 *
 * 全部 fixture 时间戳显式带 +08:00（时间红线：不得出现无发布时间的条目）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { stripHeroPrefix } from "../lib/utils/hero-text";
import {
  HERO_DERIVE_MAX_LINES,
  deriveHeroLine,
  type ExecutiveSummary,
} from "../lib/services/enrich/executive-summary";
import { applyMemoryGuard } from "../lib/services/memory/exec-guard";
import {
  emptyMemory,
  rememberBroadcast,
  settleTodayIntoEvents,
} from "../lib/services/memory/event-memory";
import { renderHtml } from "../lib/services/render";
import { buildWecomMarkdown, buildWecomText } from "../lib/adapters/notify/wecom";
import type { DailyReport } from "../lib/contracts/report";

const TODAY = "2026-09-27";
const YEST = "2026-09-26";
const NOW = new Date("2026-09-27T07:30:00+08:00");

/** 与记忆库逐字重复的定调 → 必然命中判重 → 走归纳兜底。 */
const HERO = "理财密集下调费率1667条，财富客群比价压力上升。";

function mkExec(): ExecutiveSummary {
  return {
    hero_line: HERO,
    must_read: [
      { title: "上海楼市已止跌回稳", why: "住房金融条线关注度上升", url: "https://example.com/a" },
    ],
    insights: [
      {
        topic: "助贷合作方适配排查",
        impact: "消费贷条线获客与分润结构或调整。",
        action: "风控部牵头排查存量合作方适配进度。",
        sources: [{ title: "助贷新规重塑合作模式", url: "https://example.com/b" }],
      },
    ],
  };
}

function storeWithHeroHistory() {
  let store = emptyMemory();
  store = rememberBroadcast(store, {
    cand: { title: HERO, text: "" },
    section: "hero",
    date: YEST,
    novelty: 1,
    broadcastAt: `${YEST}T08:00:00+08:00`,
  });
  return settleTodayIntoEvents(store, YEST);
}

// ---------------------------------------------------------------------------
// ① 前缀剥离（历史数据兼容）
// ---------------------------------------------------------------------------

test("stripHeroPrefix：剥掉历史补位前缀，无前缀原样返回，空值回空串", () => {
  assert.equal(
    stripHeroPrefix("今日分行焦点：河南省首笔取水权质押贷款落地信阳"),
    "河南省首笔取水权质押贷款落地信阳",
  );
  assert.equal(stripHeroPrefix("美联储10月加息概率逼近七成"), "美联储10月加息概率逼近七成");
  assert.equal(stripHeroPrefix(undefined), "");
  assert.equal(stripHeroPrefix("  今日分行焦点：  广州首单净土贷  "), "广州首单净土贷");
});

// ---------------------------------------------------------------------------
// ② deriveHeroLine：方向 + 为什么
// ---------------------------------------------------------------------------

test("deriveHeroLine：必读与商机交替取用，每条都带「为什么值得关注」", () => {
  const line = deriveHeroLine(mkExec());
  assert.ok(line.startsWith("今天值得重点关注两个方面："), `句式应含方向数（实际：${line}）`);
  assert.ok(line.includes("一是上海楼市已止跌回稳，住房金融条线关注度上升"), "必读在前、带理由");
  assert.ok(line.includes("二是助贷合作方适配排查，消费贷条线获客与分润结构或调整"), "商机在后、带理由");
  assert.ok(line.endsWith("。"), "整句收口");
});

test("deriveHeroLine：理由只取第一句、超长按标点截断（卡面是导语，不铺陈）", () => {
  const line = deriveHeroLine({
    must_read: [
      {
        title: "消费贷贴息扩围",
        why: "政策把贴息范围扩到更多消费场景，价格战随之升级，分行存量客户可能被同业以更低价抢走，需尽快统一口径。",
      },
    ],
  });
  assert.ok(line.startsWith("今天值得重点关注：消费贷贴息扩围，"), `方向应在（实际：${line}）`);
  assert.ok(!line.includes("需尽快统一口径"), "超出 22 字的部分不得进入导语");
  assert.ok(line.length <= 90, `单条导语应短（实际 ${line.length} 字）`);
});

test("deriveHeroLine：最多 3 条主线、方向去重、空素材回空串", () => {
  const line = deriveHeroLine({
    must_read: [
      { title: "A方向", why: "理由A" },
      { title: "B方向", why: "理由B" },
      { title: "C方向", why: "理由C" },
      { title: "D方向", why: "理由D" },
    ],
    insights: [{ topic: "A方向", impact: "重复方向应被去掉" }],
  });
  assert.ok(line.includes("三个方面"), "三条时应报「三个方面」");
  assert.ok(line.includes("一是A方向") && line.includes("三是C方向"), "取前三条");
  assert.ok(!line.includes("D方向"), "第四条不进导语");
  assert.equal((line.match(/A方向/g) ?? []).length, 1, "同一方向不重复");

  assert.equal(deriveHeroLine({ must_read: [], insights: [] }), "", "无素材 → 空串");
  assert.equal(deriveHeroLine({ must_read: [{ title: "  ", why: "x" }] }), "", "空白标题不算素材");
  assert.equal(HERO_DERIVE_MAX_LINES, 3, "上限常量须与口径一致");
});

// ---------------------------------------------------------------------------
// ③ 集成：判重命中 → 归纳兜底（不再挑池事件）
// ---------------------------------------------------------------------------

test("定调判重命中 → 由必读+商机归纳今日关注主线（不清空板块、不挑池事件）", () => {
  const g = applyMemoryGuard({ exec: mkExec(), store: storeWithHeroHistory(), today: TODAY, now: NOW });
  const line = g.exec.hero_line ?? "";
  assert.ok(line.startsWith("今天值得重点关注"), `应改为归纳式导语（实际：${line}）`);
  assert.ok(line.includes("上海楼市已止跌回稳") && line.includes("助贷合作方适配排查"), "两个板块都要点到");
  assert.ok(!line.startsWith("今日分行焦点"), "不带任何标签前缀（各消费端自加）");
  assert.ok(
    !/取水权|河南省|中小银行压降/.test(line),
    "不得再出现「从池里另挑事件」的结果",
  );
  assert.equal(g.exec.spoken_hero, undefined, "旧口播稿围绕原定调写 → 清空，交由 syncNarration 派生");
  assert.ok(
    g.log.some((l) => l.includes("改由必读+商机归纳今日关注主线")),
    `应留归纳日志：${g.log.join(" | ")}`,
  );
});

test("红线：必读与商机皆空 → 保留原定调（宁可重复，不留空）", () => {
  const exec: ExecutiveSummary = { hero_line: HERO, must_read: [], insights: [] };
  const g = applyMemoryGuard({ exec, store: storeWithHeroHistory(), today: TODAY, now: NOW });
  assert.equal(g.exec.hero_line, HERO, "无素材可归纳 → 保留原定调");
  assert.ok(
    g.log.some((l) => l.includes("无可归纳")),
    `应留下留痕日志：${g.log.join(" | ")}`,
  );
});

test("回归：定调未被判重时原样保留，不做任何归纳", () => {
  const exec = mkExec();
  exec.hero_line = "全新定调：跨境资金安排与汇率避险窗口同步打开。";
  const g = applyMemoryGuard({ exec, store: emptyMemory(), today: TODAY, now: NOW });
  assert.equal(g.exec.hero_line, exec.hero_line, "未命中判重 → 定调原样保留");
  assert.ok(!g.log.some((l) => l.includes("归纳")), "不该出现归纳日志");
});

// ---------------------------------------------------------------------------
// ④ 消费端：只加一份标签
// ---------------------------------------------------------------------------

test("页面渲染：hero_line 带历史前缀 → 只输出一个「今日定调：」标签", () => {
  const base = {
    date: TODAY,
    hero_line: "今日分行焦点：河南省首笔取水权质押贷款落地信阳",
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  } as unknown as DailyReport;
  const html = renderHtml(base);
  assert.ok(html.includes("今日定调：河南省首笔取水权质押贷款落地信阳"), "标签 + 正文各一份");
  assert.ok(!html.includes("今日分行焦点"), "不得出现补位前缀（历史数据重渲染亦不例外）");
  assert.ok(!html.includes('class="hero-line">今日定调：今日'), "不得出现双标签");
});

test("企微推送：同样剥前缀，只留【今日定调】标签", () => {
  const md = buildWecomMarkdown(
    "今日分行焦点：河南省首笔取水权质押贷款落地信阳",
    "9月27日 周日",
    "https://example.com",
  );
  assert.ok(
    md.includes("河南省首笔取水权质押贷款落地信阳") && md.includes("今日定调"),
    "markdown 版：正文在、标签在",
  );
  assert.ok(!md.includes("今日分行焦点"), "markdown 版不得出现补位前缀");

  const tx = buildWecomText(
    "今日分行焦点：河南省首笔取水权质押贷款落地信阳",
    "9月27日 周日",
    "https://example.com",
  );
  assert.ok(!tx.includes("今日分行焦点"), "text 版不得出现补位前缀");
});
