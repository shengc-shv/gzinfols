/**
 * 事件锚点「候选覆盖率」（2026-10-03 sc 立项）。
 *
 * 背景：10-03 期把 09-28 播过的「公募规模 40 万亿」又播了一遍（同日定调+必读+商机 3 处）。
 * 离线复现（10-01 记忆库 + `findMatchingEvent`）定位到三个原因，本文件锁住其中"可修的那一个"：
 *
 *   🔴 `record.anchors` **只增不减** → `anchorJaccard` 分母 |A∪B| 膨胀 →
 *      **同一个事件，历史记录越"丰富"，越难被再次匹配**（自恶化）。
 *
 * 修法：补一路**候选侧覆盖率** `|A∩B| / |A|` —— 只看候选的锚有多少被历史覆盖，与历史膨胀无关。
 *
 * 两个实测校准点（务必保留）：
 *  ① **有效**：10-03 商机候选 `["基金","#40万亿","#39.63万亿元"]` vs 09-28 事件（6 个锚）
 *     → Jaccard 仅 0.333（不达标），覆盖率 0.667（达标且独占第一，次名仅 0.25）；
 *  ② **必须加守卫**：10-03 必读候选只有 `["广州","#40万亿"]` 两个锚（"公募"未被词表识别 → 锚点缺失），
 *     若允许"只共享 1 个锚"就达标，它会与 **6 个无关事件并列 0.500**（按揭/保险/客群…）→ 误并。
 *     故要求 **至少共享 2 个锚**（与 `sameEvent` 的 minShared 同口径）。
 *
 * ③ **地域锚只认标题**（2026-10-03 sc 追加）：候选取文是 `title + why/impact`，而 why/impact
 *     是 LLM 写的**面向我行**的解读。「公募 40 万亿」是**全国数据**，正文里那句
 *     「…广州分行零售AUM的结构…」说的是"与我行的关系"，**不是**"事件发生在哪"。
 *     它被抽成 `@广州` 后：既当锚点又当"新事实"，一条就贡献 `0.45×(1/2)=0.225` 的 novelty
 *     （0.17 → 0.396，正好跨过必读门槛 0.3）→ 同一件事 09-28 播过、10-03 又放行。
 *     修法：`candidateAnchors` = 标题锚 ∪（正文锚 − 地域）；`candidateFacts` 同理。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  anchorJaccard,
  candidateAnchors,
  candidateCoverage,
  candidateFacts,
  extractFacts,
} from "../lib/services/memory/event-text";
import { findMatchingEvent } from "../lib/services/memory/event-decide";

/** 09-28「公募基金规模达39.63万亿」事件累积后的锚点（真实值，6 个）。 */
const REC_PUBLIC_FUND = ["基金", "#39.63万亿", "理财", "存款", "#40万亿", "#1300亿元"];

test("candidateCoverage：抗历史锚点膨胀 —— 同一事件讲得越多，历史锚越全，Jaccard 越救不了", () => {
  const cand = ["基金", "#40万亿", "#39.63万亿元"]; // 10-03 商机候选（3 个锚）
  assert.equal(candidateCoverage(cand, REC_PUBLIC_FUND), 2 / 3, "候选 3 个锚中被覆盖 2 个 → 0.667");
  assert.ok(
    anchorJaccard(cand, REC_PUBLIC_FUND) < 0.5,
    "同一对输入，Jaccard 因分母 |A∪B|=7 被稀释到 0.333 → 这正是漏召回的自恶化机制",
  );
});

test("candidateCoverage 守卫：只共享 1 个锚 → 0（防误并，10-03 实测校准）", () => {
  // 必读#2 的真实形态：只有 2 个锚，且其中 `广州` 是通用地域词
  assert.equal(
    candidateCoverage(["广州", "#40万亿"], REC_PUBLIC_FUND),
    0,
    "只共享 `#40万亿` 1 个锚 → 必须判 0（否则会与 6 个无关事件并列 0.5）",
  );
  assert.equal(candidateCoverage(["广州", "#40万亿"], ["按揭", "#40万亿", "楼市"]), 0, "同上：单锚共享不足以判同");
});

test("candidateCoverage 守卫：单锚候选 / 空集 → 0", () => {
  assert.equal(candidateCoverage(["基金"], REC_PUBLIC_FUND), 0, "候选侧锚点 < 2 → 信息量不足");
  assert.equal(candidateCoverage(["基金", "#40万亿"], ["基金"]), 0, "历史侧锚点 < 2");
  assert.equal(candidateCoverage([], REC_PUBLIC_FUND), 0);
  assert.equal(candidateCoverage(["基金", "#40万亿"], []), 0);
});

// ---------------------------------------------------------------------------
// ⑤ 覆盖率守卫：锚点「大杂烩」事件不得被虚高覆盖率误召回（2026-10-03 实证）
// ---------------------------------------------------------------------------

/** 10-03 实证的「大杂烩」事件：`按揭` —— 10 个锚、9 次播报，样本是 5 件不相干的事。 */
const BIG_POT_ANCHORS = [
  "按揭", "客群", "广州", "消费贷", "代发", "信用卡", "房贷", "购房", "贴息", "#3万元",
];

/** 最小记忆库（仅 long-term events + 空暂存区）。 */
function storeWith(id: string, anchors: string[], topicTags: string[]): never {
  return {
    version: 1,
    events: {
      [id]: {
        id,
        anchors,
        topicTags,
        samples: [{ date: "2026-10-01", section: "insights", title: "某条历史播报", text: "x" }],
        broadcastedFacts: [],
        broadcastedTexts: [],
        kind: "local",
        firstBroadcastAt: "2026-09-16",
        lastBroadcastAt: "2026-10-01",
        broadcastCount: 9,
        sections: [],
        anglesUsed: [],
        peakScore: 0,
      },
    },
    today: { date: "2026-10-03", entries: [] },
  } as never;
}

test("覆盖率守卫：大杂烩事件（10 个锚）不得被「虚高覆盖率」误召回", () => {
  const cand = { title: "房贷贴息细则落地", text: "已审未发贷款可办理、五年期满恢复计息。" };
  const anchors = candidateAnchors(cand);
  assert.equal(
    candidateCoverage(anchors, BIG_POT_ANCHORS),
    1,
    "覆盖率本身会虚高到 1（大杂烩里什么锚都有）—— 这正是要防的",
  );
  assert.ok(
    anchorJaccard(anchors, BIG_POT_ANCHORS) < 0.3,
    "Jaccard 只有 0.2 → 说明两者并非同一事件",
  );
  assert.equal(
    findMatchingEvent(cand as never, storeWith("按揭", BIG_POT_ANCHORS, ["住房金融", "广州本地"])),
    null,
    "aj < HARD_CORROB → 覆盖率失效 → 不得误召回（否则正常必读会被冷却期拦掉）",
  );
});

test("覆盖率守卫：同事件（锚点分布集中）照常命中 —— 守卫不能把该抓的也放走", () => {
  const cand = { title: "公募规模近40万亿", text: "居民资产向净值化产品迁移趋势延续。" };
  const rec = ["基金", "#39.63万亿", "理财", "存款", "#40万亿"];
  assert.ok(anchorJaccard(candidateAnchors(cand), rec) >= 0.3, "同事件的 Jaccard 应在门槛之上");
  assert.ok(
    findMatchingEvent(cand as never, storeWith("#39.63万亿|基金", rec, ["财富管理"])),
    "锚点分布集中 → 覆盖率生效 → 必须命中（这是本轮要修的漏召回）",
  );
});

test("candidateCoverage：无共享锚 → 0；完全覆盖 → 1", () => {
  assert.equal(candidateCoverage(["黄金", "#5000元"], REC_PUBLIC_FUND), 0, "无交集");
  assert.equal(candidateCoverage(["基金", "#40万亿"], ["基金", "#40万亿"]), 1, "两锚全中");
});

// ---------------------------------------------------------------------------
// ③ 地域锚的取材边界：正文里的「广州分行」不算事件事实
// ---------------------------------------------------------------------------

/** 10-03 必读#2 的真实形态：全国性数据 + LLM 解读里提到「广州分行」。 */
const PUBLIC_FUND_CAND = {
  title: "公募规模近40万亿",
  text: "公募规模近40万亿 居民资产向净值化产品迁移趋势延续，广州分行零售AUM的结构与客户陪伴方式面临重估。",
};

test("地域锚只认标题：正文里的「广州分行」不进锚点（10-03 实证）", () => {
  assert.deepEqual(
    candidateAnchors(PUBLIC_FUND_CAND),
    ["基金", "#40万亿"],
    "「广州」来自 LLM 解读的「广州分行」，说的是与我行的关系，不是事件发生在哪",
  );
  assert.ok(
    candidateAnchors({ title: "广州楼市新政落地" }).includes("广州"),
    "标题里的地域是事件属性，必须保留",
  );
  assert.ok(
    candidateAnchors({ title: "广东消费补贴扩围", text: "广东…" }).includes("广东"),
    "标题地域照常进入锚点",
  );
});

test("正文地域不算「新事实」：一条「广州分行」不再撑高 novelty", () => {
  const facts = candidateFacts(PUBLIC_FUND_CAND);
  assert.ok(!facts.includes("@广州"), "正文地域不进事实集 —— 否则它是「伪增量」");
  assert.ok(facts.includes("#40万亿"), "数字事实照常抽取");
  assert.ok(
    candidateFacts({ title: "广州出台楼市新政" }).includes("@广州"),
    "标题里的地域仍算事实（事件确实发生在广州）",
  );
});

test("地域修复后：必读候选能精准命中老事件（覆盖率 1.0，且不再有伪增量）", () => {
  const anchors = candidateAnchors(PUBLIC_FUND_CAND); // ["基金","#40万亿"]
  const cov = candidateCoverage(anchors, REC_PUBLIC_FUND);
  assert.equal(cov, 1, "候选 2 个锚全部被历史覆盖（修复前为 2/3，被「广州」稀释）");
  assert.deepEqual(
    candidateFacts(PUBLIC_FUND_CAND),
    ["#40万亿"],
    "只抽出数字事实 —— 正文的「广州分行」已被排除（修复前它会被当成「新事实」）",
  );
});

// ---------------------------------------------------------------------------
// ④ 事实锚的单位写法归一：`39.63万亿元` 与 `39.63万亿` 是同一个事实
// ---------------------------------------------------------------------------

test("事实锚单位归一：「万亿元」与「万亿」不得算作两个事实（2026-10-03）", () => {
  assert.deepEqual(
    extractFacts("公募规模达39.63万亿元"),
    extractFacts("公募规模达39.63万亿"),
    "同一数值的两种单位写法 → 必须抽出同一个事实锚",
  );
  assert.deepEqual(extractFacts("公募规模达39.63万亿元"), ["#39.63万亿"]);

  // 10-03 商机#2 的真实形态：历史已播 `#39.63万亿`，候选写成 `#39.63万亿元` →
  // 修复前它被算作「新事实」→ newFactRatio 0.5 → novelty 0.37 → 跨过商机门槛 0.22 放行。
  const cand = { title: "公募规模逼近40万亿", text: "公募规模达39.63万亿元，居民资产向净值化产品迁移延续。" };
  const facts = candidateFacts(cand);
  const histFacts = ["#39.63万亿", "#40万亿"];
  assert.equal(
    facts.filter((f) => !histFacts.includes(f)).length,
    0,
    "对 09-28 已播事实零新增 → 不再冒领「增量」",
  );
});
