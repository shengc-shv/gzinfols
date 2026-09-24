/**
 * 判重增量：**「新时点 = 新一期」**（2026-09-24 用户口径，回归测试）
 *
 * 用户原话：「一个是9月加息，1个是10月加息，**月份是他们两个信息里面最核心的差异之一**」。
 *
 * 背景（实测 2026-09-24）：`extractFacts` 的 `NUM_RE` 把「10月」和「25基点」都抽成
 * `#数字锚点`，于是「9月已落地」与「10月概率七成」被判为同一件事的重复表述 ——
 * 定调被 dedupe 掉（novelty 0.383 vs 门槛 0.43，**仅差 0.047**），改成了无关的补位事件。
 *
 * 修法：时点事实（月份/年度/季度）单独作一路信号 `newPeriod` —— 对周期性事件
 * （议息、LPR、月度数据），新的一期本身就是实质进展。它是**自限的**：
 * 一旦播报，该时点事实会记进 `broadcastedFacts`，后续同月内容不再享受加成。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { computeNovelty, evaluateCandidate } from "../lib/services/memory/event-decide";
import type { EventMemoryStore, EventRecord } from "../lib/services/memory/event-types";

/** 默认夹具 = 2026-09-17 实际播过的「美联储重启加息25基点」（字段取自线上记忆库）。 */
function rec(over: Partial<EventRecord> = {}): EventRecord {
  return {
    id: "#25基点|利率|客群|美联储",
    topicTags: ["利率流动性", "私行客群", "广州本地"],
    anchors: ["美联储", "利率", "客群", "#25基点", "广州", "存款", "私行", "房贷", "个贷", "理财", "#7.2%"],
    kind: "generic",
    firstBroadcastAt: "2026-09-17",
    lastBroadcastAt: "2026-09-17",
    broadcastCount: 1,
    sections: ["hero", "must_read"],
    anglesUsed: [],
    samples: [
      {
        date: "2026-09-17",
        section: "hero",
        title: "美联储重启加息25基点，美元利率中枢抬升，跨境客群结售汇与外币配置窗口打开。",
        text: "美联储重启加息25基点，美元利率中枢抬升，跨境客群结售汇与外币配置窗口打开。",
      },
    ],
    broadcastedTexts: ["美联储重启加息25基点，美元利率中枢抬升，跨境客群结售汇与外币配置窗口打开。"],
    broadcastedFacts: ["#25基点", "!加息", "@美联储", "@广州", "#25个基点", "#7.2%"],
    peakScore: 89,
    ...over,
  } as EventRecord;
}

function store(r: EventRecord): EventMemoryStore {
  return { version: 1, events: { [r.id]: r } } as EventMemoryStore;
}

/** 线上原文（2026-09-24 被误拦的定调）。 */
const HERO_10月 =
  "美联储10月加息概率逼近七成，美元存款利率超4%，广州分行外币货架与结售汇窗口同步打开。";

test("新时点：9 月已播 → 10 月新信息，应判为「新一期」并放行", () => {
  const r = rec();
  const cand = { title: HERO_10月 };
  const n = computeNovelty(cand, r);
  assert.equal(n.newPeriod, true, "候选带记录里没有的 #10月 → newPeriod");
  assert.ok(
    n.newFacts.includes("#10月"),
    `#10月 应被识别为新事实：${JSON.stringify(n.newFacts)}`,
  );

  const d = evaluateCandidate({ cand, section: "hero", today: "2026-09-24", store: store(r) });
  assert.equal(d.allow, true, `应放行（verdict=${d.verdict}，增量 ${n.novelty.toFixed(3)}）`);
  assert.notEqual(d.verdict, "duplicate", "不得判为重复表述");
});

test("新时点是**自限**的：同一期（记录已有 #10月）再报 → 不再享受加成，按重复拦下", () => {
  const r = rec({ broadcastedFacts: [...rec().broadcastedFacts, "#10月"] });
  const cand = { title: HERO_10月 };
  const n = computeNovelty(cand, r);
  assert.equal(n.newPeriod, false, "记录里已有 #10月 → 不是新一期");
  const d = evaluateCandidate({ cand, section: "hero", today: "2026-09-24", store: store(r) });
  assert.equal(d.allow, false, "同一期内重复表述仍应拦下");
});

test("纯重复仍然拦得死（对照组：标题逐字相同 → novelty 0）", () => {
  const r = rec({
    id: "利率|美联储",
    lastBroadcastAt: "2026-09-21",
    anchors: ["美联储", "利率"],
    samples: [{ date: "2026-09-21", section: "hero", title: "美联储加息落地 全球利率现分化博弈", text: "美联储加息落地 全球利率现分化博弈" }],
    broadcastedTexts: ["美联储加息落地 全球利率现分化博弈"],
    broadcastedFacts: ["!落地", "!加息", "@美联储"],
  });
  const cand = { title: "美联储加息落地 全球利率现分化博弈" };
  const n = computeNovelty(cand, r);
  assert.equal(n.novelty, 0, "逐字相同的重复，增量应为 0");
  assert.equal(n.newPeriod, false);
  const d = evaluateCandidate({ cand, section: "hero", today: "2026-09-24", store: store(r) });
  assert.equal(d.allow, false);
});

test("时点识别只认「时点」：时长类数字（10个月 / 3年）不得算新一期", () => {
  const r = rec();
  const n = computeNovelty({ title: "美联储本轮政策观察期还有10个月，未来3年利率路径待定" }, r);
  assert.equal(n.newPeriod, false, "「10个月」「3年」是时长，不是时点 → 不得触发 newPeriod");
});

test("新时点不是「无脑放行」：仅有新月份、无其他新增内容时仍不足", () => {
  // 记录已含全部事实与措辞 → 只有 #11月 是新的
  const r = rec({
    broadcastedFacts: [...rec().broadcastedFacts, "#11月"],
    broadcastedTexts: [
      "美联储重启加息25基点，美元利率中枢抬升，跨境客群结售汇与外币配置窗口打开。",
      "美联储11月加息概率抬升，美元利率中枢上行，跨境客群结售汇与外币配置窗口同步打开。",
    ],
  });
  const n = computeNovelty({ title: "美联储11月加息概率抬升，美元利率中枢上行，跨境客群结售汇与外币配置窗口同步打开。" }, r);
  assert.equal(n.newPeriod, false, "该月份已在记录中 → 无加成");
});
