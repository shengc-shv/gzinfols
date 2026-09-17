/**
 * A3 增量三态（2026-09-17）。
 *
 * 锁四件事：
 *  ① 三态判定复用**事件记忆判重链**（findMatchingEvent + computeNovelty），不另立规则：
 *     无匹配 → 新增；命中历史但无实质进展 → 续报（带期号）；出现新进展 → 有进展；
 *  ② 命中**当天暂存区** → 续报但不给期号（同一次运行内重复提及，不是「第 N 期」）；
 *  ③ 幂等 + 不 mutate 入参（老报告重渲染不改变结果）；
 *  ④ 徽章文案与悬浮说明可解释（不出现「随机标」）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { annotateDeltas, deltaOf, DELTA_PROGRESS_THRESHOLD } from "../lib/services/assemble/delta";
import { renderDeltaBadge, deltaLabelOf } from "../lib/services/render/delta-badge";
import type { EventMemoryStore, EventRecord } from "../lib/services/memory/event-types";
import type { DailyReport } from "../lib/contracts/report";

const URL_A = "https://example.com/loans";
const TEXT_HIST = "经营贷利率悄然上行 同业主动缩规模、贸易类准入收紧";

function record(over: Partial<EventRecord> = {}): EventRecord {
  return {
    id: "信贷|利率",
    topicTags: ["利率流动性"],
    anchors: ["信贷", "利率"],
    kind: "generic",
    firstBroadcastAt: "2026-09-15",
    lastBroadcastAt: "2026-09-16",
    broadcastCount: 2,
    sections: ["must_read"],
    anglesUsed: ["政策变化"],
    samples: [{ date: "2026-09-16", section: "must_read", title: "经营贷利率悄然上行", url: URL_A, text: TEXT_HIST }],
    broadcastedTexts: [TEXT_HIST],
    broadcastedFacts: ["!受理"],
    peakScore: 70,
    ...over,
  };
}

function store(events: Record<string, EventRecord> = {}, today?: EventMemoryStore["today"]): EventMemoryStore {
  return { version: 1, events, ...(today ? { today } : {}) };
}

test("① 无匹配 → 新增", () => {
  const mark = deltaOf(
    { title: "广州出台科技金融新政", text: "广州出台科技金融新政，覆盖 120 家企业", url: "https://example.com/new" },
    store({ E1: record() }),
  );
  assert.equal(mark.state, "new");
  assert.equal(mark.issueNo, undefined, "新增不给期号");
});

test("② 命中历史但无实质进展 → 续报（第 N 期 = 历史次数 + 1）", () => {
  const mark = deltaOf({ title: "经营贷利率悄然上行", text: TEXT_HIST, url: URL_A }, store({ E1: record() }));
  assert.equal(mark.state, "followup");
  assert.equal(mark.issueNo, 3, "历史播报 2 次 → 本期是第 3 期");
  assert.ok(!mark.highlights?.length, "续报不带新进展说明");
});

test("③ 出现新进展（阶段推进）→ 有进展，且带上新事实锚点", () => {
  const text = `${TEXT_HIST} 该产品已过会，规模 2.5 亿元`;
  const mark = deltaOf({ title: "经营贷利率悄然上行", text, url: URL_A }, store({ E1: record() }));
  assert.equal(mark.state, "changed", "阶段词从「受理」推进到「过会」应判为有进展");
  assert.equal(mark.issueNo, 3);
  assert.ok((mark.highlights ?? []).length > 0, "应带出新事实锚点，让读者看到「新在哪」");
  // 阈值本身是个常量，锁住它避免被悄悄调松/调严
  assert.ok(DELTA_PROGRESS_THRESHOLD > 0.15 && DELTA_PROGRESS_THRESHOLD <= 0.5);
});

test("④ 命中当天暂存区 → 续报但不给期号（同日重复提及）", () => {
  const url = "https://example.com/today-repeat";
  const s = store({}, {
    date: "2026-09-17",
    entries: [
      { date: "2026-09-17", section: "must_read", title: "今日定调：信贷结构优化", text: "今日定调：信贷结构优化", url },
    ],
  });
  const mark = deltaOf({ title: "今日定调：信贷结构优化", text: "今日定调：信贷结构优化", url }, s);
  assert.equal(mark.state, "followup");
  assert.equal(mark.issueNo, undefined, "同日重复不给期号（否则会谎报「第 N 期」）");
});

test("⑤ annotateDeltas：只标 4 个连播板块，幂等且不 mutate", () => {
  const report = {
    date: "2026-09-17",
    hero_line: "信贷结构优化带动零售重排",
    must_read: [{ title: "经营贷利率悄然上行", why: "定价空间", url: URL_A }],
    insights: [{ topic: "消费贷贴息扩围", impact: "价格战", action: "统一口径", sources: [{ title: "x", url: "https://example.com/i" }] }],
    risk: { topic: "利率风险", evidence: "上行", impact: "息差", action: "盯存量" },
    sections: { gz_local: [{ url: "https://example.com/g", title_cn: "本地要闻" }], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  } as unknown as DailyReport;
  const s = store({ E1: record() });

  const snapshot = JSON.stringify(report);
  const out = annotateDeltas(report, s);

  assert.equal(JSON.stringify(report), snapshot, "不得 mutate 入参");
  assert.equal(out.must_read[0].delta?.state, "followup", "必读命中历史 → 续报");
  assert.ok(out.heroDelta, "定调也标三态");
  assert.ok(out.insights[0].delta, "商机也标三态");
  assert.ok(out.risk?.delta, "风险也标三态");
  assert.equal(out.sections, report.sections, "板块条目不在 A3 范围内（引用不变，零开销）");

  const again = annotateDeltas(out, s);
  assert.deepEqual(again.must_read[0].delta, out.must_read[0].delta, "幂等");
  assert.deepEqual(again.heroDelta, out.heroDelta, "幂等");
});

test("⑥ 徽章文案与悬浮说明可解释", () => {
  assert.equal(deltaLabelOf({ state: "new" }), "新增");
  assert.equal(deltaLabelOf({ state: "changed" }), "有进展");
  assert.equal(deltaLabelOf({ state: "followup", issueNo: 3 }), "续报·第3期");
  assert.equal(deltaLabelOf({ state: "followup" }), "续报", "无期号时退化为「续报」");

  const html = renderDeltaBadge({ state: "changed", issueNo: 2, highlights: ["#2.5亿元"] });
  assert.ok(html.includes("delta-changed"), "样式类须带状态（三种颜色）");
  assert.ok(html.includes("有进展"));
  assert.ok(html.includes("2.5亿元"), "悬浮说明须能看出「新在哪」");
  assert.equal(renderDeltaBadge(undefined), "", "无 delta（老报告）不渲染徽章");
});
