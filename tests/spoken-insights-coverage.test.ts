/**
 * 商机口播「先听后找」覆盖自检（`auditSpokenInsightsCoverage`）守护（2026-09-30 sc 口径）。
 *
 * 锁定的两类失败（均来自 2026-09-30 真实产物实测）：
 *  ① 口播念了卡面没有的组名 → 听众照此名去页面找，找不到入口；
 *  ② 卡面有、口播没念 → 听众不知道页面有这条。
 * 本函数**只判不改**（返回结果由调用方打 ::warning::），故测试只断言判定结果。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { auditSpokenInsightsCoverage } from "../lib/services/enrich/executive-summary";
import { groupInsightsForSpeech } from "../lib/services/voice/speech-lines";

test("① 口播组名逐字取自卡面 group → 不做 unknownGroups 告警", () => {
  const audit = auditSpokenInsightsCoverage({
    insights: [
      { topic: "房贷贴息客群清单梳理", group: "本地消费场景", segments: ["零售AUM"] },
      { topic: "支农支小再贷款额度增加", group: "普惠小微", segments: ["普惠小微贷款客户"] },
    ],
    spokenInsights:
      "本地消费场景方面，房贷贴息客群清单梳理，本周梳理临穗客群清单。普惠小微方面，支农支小再贷款额度增加，本周对照支持领域梳理项目储备。",
  });
  assert.deepEqual(audit.unknownGroups, [], "组名与卡面 group 一致，不应告警");
  assert.deepEqual(audit.uncoveredTopics, [], "两条 topic 均被念到");
});

test("② 口播自拟了卡面不存在的组名 → unknownGroups 命中（2026-09-30 实测场景）", () => {
  // 卡面 6 条的 segments 只有三类客群、无 group → 「本地消费场景」不在可见标签集合里
  const audit = auditSpokenInsightsCoverage({
    insights: [
      { topic: "房贷贴息客群清单梳理", segments: ["零售AUM"] },
      { topic: "东莞购房补贴联动按揭", segments: ["零售AUM"] },
    ],
    spokenInsights:
      "零售AUM方面，房贷贴息客群清单梳理，本周梳理临穗客群清单。本地消费场景方面，东莞购房补贴联动按揭，本周联动家装分期。",
  });
  assert.deepEqual(audit.unknownGroups, ["本地消费场景"], "「本地消费场景」不在卡面标签集合 → 应告警");
});

test("③ 卡面有、口播没念 → uncoveredTopics 命中（反向断链）", () => {
  const audit = auditSpokenInsightsCoverage({
    insights: [
      { topic: "东盟客群跨境结算对接", segments: ["中高端客群(过亿资产)"] },
      { topic: "离岸金融体系化布局", segments: ["中高端客群(过亿资产)"] },
    ],
    spokenInsights: "高端客户方面，离岸金融体系化布局，本周更新私行产品准入清单。",
  });
  assert.deepEqual(audit.uncoveredTopics, ["东盟客群跨境结算对接"], "没被念到的 topic 应列出");
});

test("④ 兜底名（其他机会 / 其他业务线）不算 unknownGroups —— 避免噪音告警", () => {
  const audit = auditSpokenInsightsCoverage({
    insights: [{ topic: "某条无线索商机" }],
    spokenInsights: "其他机会方面，某条无线索商机，本周先摸底。",
  });
  assert.deepEqual(audit.unknownGroups, [], "两个兜底名都是允许的");
});

test("⑤ 空输入 / 无口播 → 一律不告警（优雅降级）", () => {
  assert.deepEqual(auditSpokenInsightsCoverage({}), { unknownGroups: [], uncoveredTopics: [] });
  assert.deepEqual(
    auditSpokenInsightsCoverage({ insights: [{ topic: "x" }], spokenInsights: "  " }),
    { unknownGroups: [], uncoveredTopics: [] },
  );
  assert.deepEqual(
    auditSpokenInsightsCoverage({ insights: [], spokenInsights: "零售AUM方面，A，本周做B。" }),
    { unknownGroups: [], uncoveredTopics: [] },
  );
});

test("⑥ 口播组名 = 卡面 group（标签同源）：groupInsightsForSpeech 逐字使用 group", () => {
  const groups = groupInsightsForSpeech([
    { topic: "房贷贴息客群清单梳理", impact: "临穗客群资金留存的窗口在假期前", group: "本地消费场景", segments: ["零售AUM"] },
    { topic: "东莞购房补贴联动按揭", impact: "按揭与家装的联动需求集中在补贴期内", group: "本地消费场景", segments: ["零售AUM"] },
    { topic: "支农支小再贷款额度增加", impact: "再贷款额度扩张直接利好小微投放", group: "普惠小微", segments: ["普惠小微贷款客户"] },
  ]);
  assert.equal(groups.length, 2, "同 group 合成一组");
  assert.equal(groups[0]!.label, "本地消费场景", "组名逐字用 group（与卡面 chip 同源）");
  assert.equal(groups[1]!.label, "普惠小微");
});

test("⑦ 无 group 时回落既有客群短名（行为不变）", () => {
  const groups = groupInsightsForSpeech([
    { topic: "家族信托升级", impact: "高净值客户对家族信托的接受度上升", segments: ["中高端客群(过亿资产)"] },
    { topic: "无线索商机", impact: "线索尚不明确" },
  ]);
  assert.equal(groups[0]!.label, "高端客户");
  assert.equal(groups[1]!.label, "其他机会");
});
