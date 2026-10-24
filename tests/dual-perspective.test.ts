/**
 * 双视角打分单测（2026-10-23 sc：商机从 6 条塌到 1 条的根因修复）。
 *
 * 校准样本全部取自 10-22 / 10-23 两期**线上真实标题**；
 * 判定标准：
 *  - 纯宏观 → macro > biz
 *  - 纯商机 → biz > macro
 *  - 双视角 → 两维均 ≥ DUAL_THRESHOLD（卡片双呈现）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreDualPerspective,
  DUAL_THRESHOLD,
} from "../lib/services/select/filters/dual-perspective";
import {
  groupInsightsForSpeech,
  groupedInsightsSpeech,
  insightSpeechAligned,
} from "../lib/services/voice/speech-lines";

test("纯宏观素材：宏观分显著高于商机分", () => {
  const cases = ["扩大内需实施方案在研", "寿险利差损风险被点名", "北交所拟引入市值配售", "隔夜逆回购首日800亿"];
  for (const t of cases) {
    const r = scoreDualPerspective({ title: t });
    assert.ok(r.macro > r.biz, `${t}: macro ${r.macro} 应 > biz ${r.biz}`);
    assert.ok(r.macro >= DUAL_THRESHOLD, `${t}: 宏观分应 ≥ ${DUAL_THRESHOLD}，实得 ${r.macro}`);
  }
});

test("纯商机素材：商机分显著高于宏观分", () => {
  const cases = [
    "主动ETF发行火速定档",
    "债基限购潮再起，近一月至少150只产品收紧申购",
    "个别中小银行小幅上调部分存款利率",
    "选择个人养老金理财产品的四大理由",
  ];
  for (const t of cases) {
    const r = scoreDualPerspective({ title: t });
    assert.ok(r.biz > r.macro, `${t}: biz ${r.biz} 应 > macro ${r.macro}`);
    assert.ok(r.biz >= 40, `${t}: 商机分应 ≥ 40，实得 ${r.biz}`);
  }
});

test("双视角素材：两维都达阈值（10-23 事故的三条主素材）", () => {
  const cases = [
    "三季度末银行理财存续规模超35万亿元",
    "广东五篇大文章贷款14.1万亿",
    "政策利率拟换锚，债市冲高回落",
  ];
  for (const t of cases) {
    const r = scoreDualPerspective({ title: t });
    assert.ok(r.dual, `${t}: 应判双视角（macro ${r.macro} / biz ${r.biz}，阈值 ${DUAL_THRESHOLD}）`);
  }
});

test("泛化词防护：「亿」必须带数字前缀，不误判娱乐稿为宏观", () => {
  // 「47亿分手费」带数字前缀 → 命中总量 25；但不含政策/产品词 → 非 dual
  const gossip = scoreDualPerspective({ title: "韩国天价离婚！顶级大佬卖股票，筹集47亿分手费" });
  assert.equal(gossip.dual, false, "娱乐稿不该判双视角");
  assert.equal(gossip.biz, 0, "「股票」「卖」不该命中商机侧（裸词「股票」刻意不收）");
});

test("否定断言：「客户端」不算零售客群", () => {
  const a = scoreDualPerspective({ title: "手机银行客户端完成升级，提升响应速度" });
  const b = scoreDualPerspective({ title: "零售客户分层经营方案落地" });
  assert.equal(a.bizSignals.includes("客群"), false, "「客户端」不该命中客群类");
  assert.equal(b.bizSignals.includes("客群"), true, "「客户」应命中客群类");
});

test("商机口播：与必读已念的数字事实重复时，该组不进口播", () => {
  const insights = [
    { topic: "固收货架收窄", impact: "客户配置选择变少，理财经理沟通素材需要更新。", segments: ["零售AUM"] },
    { topic: "跨境配置需求", impact: "外币货架询单增加。", segments: ["中高端客群(过亿资产)"] },
  ];
  // 必读口播讲了「150 只债基收紧申购」
  // 必读口播由 mustReadSpeechLine 从**标题原文**确定性派生 → 数字是阿拉伯数字（150 只）
  const mustReadSpeech = "必读第一条，债基限购潮再起，近一月 150 只产品收紧申购。";
  const withFilter = groupInsightsForSpeech(insights, { mustReadSpeech });
  const without = groupInsightsForSpeech(insights);
  // 「固收货架收窄」本身不含 150 这个数字 → 不该被误杀
  assert.equal(withFilter.length, without.length, "不含数字锚的组不应被剔除");

  // 若商机组复述了同一个数字 → 该组被剔除
  const dupInsights = [
    { topic: "150只债基收紧申购", impact: "客户可选面变窄，配置诉求转移。", segments: ["零售AUM"] },
    { topic: "跨境配置需求", impact: "外币货架询单增加。", segments: ["中高端客群(过亿资产)"] },
  ];
  const filtered = groupInsightsForSpeech(dupInsights, { mustReadSpeech });
  assert.equal(filtered.length, 1, "复述必读数字的组应被剔除，只剩另一组");
  assert.ok(!filtered.some((g) => g.topics.includes("150只债基收紧申购")));
});

test("LLM 口播稿对齐校验：讲多了（复述必读）→ 判不对齐 → 回退确定性派生", () => {
  const ins = [{ topic: "海外科技股回撤", impact: "QDII 客户账面回撤明显。", segments: ["中高端客群(过亿资产)"] }];
  // 10-23 真实稿：338 字，讲了理财规模/债基限购/政策利率/五篇大文章 —— 卡片只有 1 条
  const overLong =
    "零售AUM方面，银行理财规模连涨两季重回三十五万亿上方，客户资金回流仍在延续；" +
    "近一个月至少一百五十只债基收紧申购，固收可选面收窄，客户配置选择正在发生变化。" +
    "高端客户方面，政策利率拟换锚后国债期货冲高回落，固收类净值波动加大；" +
    "美股纳指跌超百分之二、费城半导体指数跌超百分之六，QDII与科技主题持仓客户的账面波动同步放大。" +
    "普惠小微方面，广东五篇大文章贷款十四点一万亿、占比近五成，科技绿色普惠口径是考核重点。";
  assert.equal(insightSpeechAligned(overLong, ins), false, "讲多了应判不对齐");

  // 对齐的稿（只讲卡片内容、长度合理）
  const aligned = "高端客户方面，海外科技股回撤，QDII 客户账面回撤明显。";
  assert.equal(insightSpeechAligned(aligned, ins), true, "只讲卡片内容应判对齐");

  // 漏讲（卡片 2 条但稿子只提 1 条）
  const two = [
    { topic: "海外科技股回撤", impact: "QDII 客户账面回撤明显。", segments: ["中高端客群(过亿资产)"] },
    { topic: "存款利率上调", impact: "负债成本抬升。", segments: ["零售AUM"] },
  ];
  assert.equal(insightSpeechAligned(aligned, two), false, "漏讲一条应判不对齐");
});

test("确定性派生：归并后的商机口播不含必读数字，且组名与卡片 chip 同源", () => {
  const ins = [
    { topic: "固收货架收窄", impact: "客户配置选择变少。", segments: ["零售AUM"], group: "零售AUM" },
    { topic: "外币货架询单增加", impact: "跨境沟通素材变多。", segments: ["中高端客群(过亿资产)"], group: "高端客户" },
  ];
  const speech = groupedInsightsSpeech(ins);
  assert.ok(speech.includes("零售AUM方面"), "组名应逐字来自 group 字段");
  assert.ok(speech.includes("高端客户方面"));
  assert.ok(!speech.includes("建议"), "不得含行动建议");
});

test("LLM 稿讲了被记忆判重挡掉的条目 → 判不对齐（10-24 实测场景）", () => {
  // 10-24 真实场景：LLM 写了 12 条候选，其中「理财规模重回扩容」因 10-23 刚播过被跳过；
  // LLM 写口播稿时看不到去重结果，仍把它讲成第一句 → 口播与卡片不一致。
  const played = [
    { topic: "金价跌破4000美元", impact: "贵金属配置诉求升温。", segments: ["中高端客群(过亿资产)"] },
    { topic: "家庭养老韧性框架首提", impact: "长期配置有了新抓手。", segments: ["中高端客群(过亿资产)"] },
    { topic: "涉农贷款数据报送趋严", impact: "小微绿色账本要算得更细。", segments: ["普惠小微贷款客户"] },
  ];
  // 长度接近但内容错位：讲了被挡掉的「理财规模」，漏讲了「涉农贷款」
  const mismatched =
    "零售AUM方面，理财规模重回扩容、稳债市工具给理财公司垫了缓冲，客户对净值波动的容忍度在回升。" +
    "高端客户方面，国际金价跌破四千美元、金饰单日降三十元，贵金属配置诉求在升温；家庭养老韧性框架首次提出，长期配置的对话有了新抓手。";
  assert.equal(
    insightSpeechAligned(mismatched, played, ["理财规模重回扩容"]),
    false,
    "讲了被去重挡掉的条目必须判不对齐",
  );
  // 不传 unplayedTopics 时仅靠长度判不出（这正是 10-24 漏判的原因）
  assert.equal(insightSpeechAligned(mismatched, played), true, "仅长度判据抓不到换主题");
  // 正常稿（只讲入选卡片）应通过
  const ok =
    "零售AUM方面，金价跌破四千美元，贵金属配置诉求在升温。高端客户方面，家庭养老韧性框架首次提出，长期配置有了新抓手。普惠小微方面，涉农贷款数据报送趋严，小微绿色账本要算得更细。";
  assert.equal(insightSpeechAligned(ok, played, ["理财规模重回扩容"]), true, "只讲入选卡片应通过对齐");
});
