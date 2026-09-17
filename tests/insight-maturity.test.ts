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
import { MATURITY_CSS, renderMaturityBadge, renderNextStep } from "../lib/services/render/maturity-badge";
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
  assert.equal(renderNextStep(undefined), "");
  assert.ok(MATURITY_CSS.includes(".maturity-landed"));
});

test("⑤ 下一步按「阶段 × 客群」给，且同一阶段不同客群确实不同", () => {
  const base = { topic: "广州某产业园开工", impact: "", action: "" };
  const aum = maturityMarkOf({ ...base, segments: ["零售AUM"] });
  const hnw = maturityMarkOf({ ...base, segments: ["中高端客群(过亿资产)"] });
  const inc = maturityMarkOf({ ...base, segments: ["普惠小微贷款客户"] });
  assert.equal(aum.stage, "progress");
  assert.ok(aum.nextStep && hnw.nextStep && inc.nextStep);
  assert.notEqual(aum.nextStep, hnw.nextStep, "不同客群的下一步不该是同一句");
  assert.notEqual(hnw.nextStep, inc.nextStep);
  // 未标注客群 → 走兜底文案，不抛错
  const other = maturityMarkOf(base);
  assert.ok(other.nextStep && other.nextStep.length > 0);
});

test("⑥ 🔴 文案边界：不得暗示行内状态或已介入（成熟度是公开信息阶段）", () => {
  const marks = [
    maturityMarkOf({ topic: "项目已开业", segments: ["零售AUM"] }),
    maturityMarkOf({ topic: "项目获批", segments: ["中高端客群(过亿资产)"] }),
    maturityMarkOf({ topic: "发布产业规划", segments: ["普惠小微贷款客户"] }),
    maturityMarkOf({ topic: "发布产业规划" }),
  ];
  for (const m of marks) {
    const text = m.nextStep ?? "";
    for (const bad of ["我行已", "已落地我行", "已签约我行", "已经营", "存量客户", "内部"]) {
      assert.ok(!text.includes(bad), `下一步文案不得暗示行内状态：「${bad}」出现在「${text}」`);
    }
    // 也不得出现强硬祈使（与 PASS2 既有口径一致）
    for (const hard of ["必须", "立即", "尽快落实", "务必"]) {
      assert.ok(!text.includes(hard), `下一步文案须低承诺：「${hard}」`);
    }
  }
});

test("⑦ 报告级标注：幂等、不 mutate 入参、不碰非商机字段", () => {
  const report = {
    date: "2026-09-17",
    hero_line: "定调",
    must_read: [{ url: "https://e.com/a", why: "w" }],
    insights: [
      { topic: "某项目开工", tags: [], impact: "i", action: "a", segments: ["零售AUM"] },
      { topic: "某规划发布", tags: [], impact: "i", action: "a" },
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

test("⑧ 两个实测坑：中文跨词误配 + action 不参与判定", () => {
  // 坑 1（2026-09-17 实测）：中文没有词边界，「存**量产**品业绩基准调整」曾被
  // 跨词匹配成「量产」→ 一条理财信披商机被判成「落地」。词表已加前置否定断言。
  assert.equal(maturityOf("存量产品业绩基准分批调整").stage, "clue");
  assert.equal(maturityOf("库存量产线已调试完毕").stage, "clue");
  assert.equal(maturityOf("该工厂正式量产").stage, "landed", "真正的量产仍应识别");

  // 坑 2：action 是「建议动作」，天然带未来语境，不得参与判定
  const m = maturityMarkOf({
    topic: "理财信披调整客户沟通",
    impact: "理财统一信披进入实操、存量产品业绩基准分批调整。",
    action: "本周完成存量产品披露口径自查，并推动专区分批上线。",
  });
  assert.equal(m.stage, "clue", "建议动作里的「完成/上线」不得把条目抬成落地");

  // 取材只到影响的首句：后文的延伸分析不参与判定
  const later = maturityMarkOf({
    topic: "某产业规划发布",
    impact: "该规划正式印发。下一步相关园区将陆续开工并争取年内投产。",
  });
  assert.equal(later.stage, "clue", "首句无信号即线索，后文的未来规划不参与");
});
