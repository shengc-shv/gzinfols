/**
 * C2 商机成熟度与行动项锁（2026-09-17）。
 *
 * 这一项的核心风险不是「算不出来」，而是**算错方向**：
 * 把「拟于明年开业」判成「已落地」，或把「公开信息推进」说成「我行已介入」。
 * 故测试重点在两条：① 未来时降级；② 文案不得越界（不得暗示行内状态）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MATURITY_LABEL,
  MATURITY_ORDER,
  maturityOf,
} from "../lib/services/classify/maturity";
import { annotateMaturity, maturityMarkOf } from "../lib/services/assemble/maturity";
import { MATURITY_CSS, renderMaturityBadge } from "../lib/services/render/maturity-badge";
import type { DailyReport } from "../lib/contracts/report";

test("① 三档判定：完成动作 → 落地；程序动作 → 推进；其余 → 线索", () => {
  assert.equal(maturityOf("广州某产业园正式开业运营").stage, "landed");
  assert.equal(maturityOf("该中心已竣工并交付使用").stage, "landed");
  assert.equal(maturityOf("项目完成公开招标").stage, "progress");
  assert.equal(maturityOf("该企业获批发债资格").stage, "progress");
  assert.equal(maturityOf("广州发布低空经济产业规划").stage, "clue");
  assert.equal(maturityOf("").stage, "clue");
});

test("② 未来时降级：规划态不得判成已完成（最易犯的错）", () => {
  // 含「开业」但是规划 —— 必须落回 clue
  assert.equal(maturityOf("拟于广州建设华南总部，计划 2027 年开业").stage, "clue");
  assert.equal(maturityOf("预计明年竣工投产").stage, "clue");
  assert.equal(maturityOf("有望于年内动工").stage, "clue");
  // 不含量词的确定表述仍应判 landed
  assert.equal(maturityOf("该项目已开业").stage, "landed");
});

test("③ 判定依据词随结果返回（读者能回原文核对，而不是只能相信机器）", () => {
  const v = maturityOf("广州某科技园正式开工");
  assert.equal(v.stage, "progress");
  assert.equal(v.evidence, "开工");
});

test("④ 阶段条与文案：顺序固定，徽章带进度点与可核对的 tooltip", () => {
  assert.deepEqual([...MATURITY_ORDER], ["clue", "progress", "landed"]);
  assert.equal(MATURITY_LABEL.landed, "落地");

  const html = renderMaturityBadge({ stage: "progress", evidence: "批复" });
  assert.ok(html.includes("maturity-progress"), "须带阶段类名");
  assert.ok(html.includes("推进"), "须带阶段文案");
  assert.ok(html.includes("批复"), "tooltip 须带判定依据词");
  // 进度点：clue 亮 1、progress 亮 2、landed 亮 3
  const dots = (s: string) => (s.match(/mt-on/g) ?? []).length;
  assert.equal(dots(renderMaturityBadge({ stage: "clue" })), 1);
  assert.equal(dots(renderMaturityBadge({ stage: "progress" })), 2);
  assert.equal(dots(renderMaturityBadge({ stage: "landed" })), 3);
  // 向后兼容：老报告无 maturity → 不渲染
  assert.equal(renderMaturityBadge(undefined), "");
  assert.ok(MATURITY_CSS.includes(".maturity-landed"));
});

test("⑤ ⛔ 已删除：「下一步」动作行不得复活（2026-10-01 sc 口径：全篇不给行动指引）", () => {
  const m = maturityMarkOf({ topic: "广州某产业园开工", impact: "" });
  assert.equal(m.stage, "progress", "阶段判定仍保留（客观状态，非行动指令）");
  assert.equal("nextStep" in m, false, "不得再产出 nextStep（动作库已删）");
  assert.ok(!MATURITY_CSS.includes(".maturity-next"), "不得再有「下一步」行样式");
  assert.ok(!renderMaturityBadge(m).includes("下一步"), "徽章不得带行动指引");
});

test("⑥ 报告级标注：幂等、不 mutate 入参、不碰非商机字段", () => {
  const report = {
    date: "2026-09-17",
    hero_line: "定调",
    must_read: [{ url: "https://e.com/a", why: "w" }],
    insights: [
      { topic: "某项目开工", tags: [], impact: "i", segments: ["零售AUM"] },
      { topic: "某规划发布", tags: [], impact: "i" },
    ],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  } as unknown as DailyReport;

  const once = annotateMaturity(report);
  const twice = annotateMaturity(once);
  assert.deepEqual(twice.insights, once.insights, "幂等");
  assert.equal(report.insights[0].maturity, undefined, "不得 mutate 入参");
  assert.equal(once.must_read[0].delta, undefined, "不碰必读条目");
  assert.equal(once.insights[0].maturity?.stage, "progress");
  assert.equal(once.insights[1].maturity?.stage, "clue");
});

test("⑦ 两个实测坑：中文跨词误配 + 判定取材已结构性收窄", () => {
  // 坑 1（2026-09-17 实测）：中文没有词边界，「存**量产**品业绩基准调整」曾被
  // 跨词匹配成「量产」→ 一条理财信披商机被判成「落地」。词表已加前置否定断言。
  assert.equal(maturityOf("存量产品业绩基准分批调整").stage, "clue");
  assert.equal(maturityOf("库存量产线已调试完毕").stage, "clue");
  assert.equal(maturityOf("该工厂正式量产").stage, "landed", "真正的量产仍应识别");

  // 坑 2：判定取材只剩 `topic + impact` —— `action` 已从 `maturityMarkOf` 接口移除
  // （2026-10-01 全篇去 action），「建议动作天然带未来语境」的问题由**接口层面结构性消除**：
  // 想传也传不进来。此处守住「impact 里没有程序性动作词 → 仍是线索」。
  const m = maturityMarkOf({
    topic: "理财信披调整客户沟通",
    impact: "理财统一信披进入实操、存量产品业绩基准分批调整。",
  });
  assert.equal(m.stage, "clue", "impact 无程序性动作词 → 不得抬成落地");

  // 取材只到影响的首句：后文的延伸分析不参与判定
  const later = maturityMarkOf({
    topic: "某产业规划发布",
    impact: "该规划正式印发。下一步相关园区将陆续开工并争取年内投产。",
  });
  assert.equal(later.stage, "clue", "首句无信号即线索，后文的未来规划不参与");
});
