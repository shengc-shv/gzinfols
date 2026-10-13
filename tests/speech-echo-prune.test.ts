/**
 * R2b：口播商机段的**文本级**复读裁剪（2026-10-13 sc 口径）。
 *
 * sc 口径：「今日必读演化出来的商机，如果是**不同维度**对同一事件的分析 → 可以接受；
 * 但同一件事在口播里念两遍 → 这个不行。」
 *
 * 为什么需要 R2b（而非复用 R2）：R2 的判据是「商机 sources[].url == 必读 url」，
 * 而 ① 商机 sources 常为空（10-13 实测 6 条全 undefined）；② 商机口播是 LLM 按客群改写的文本，
 * `stripOnce` 拿卡面 impact 去匹配必然找不到（R2 注释自认「退为安全网」）；
 * ③ 同一事件不同来源 URL 本就不同。实测近 7 天 4/7 天有复读、共 8 处。
 *
 * 判据（与 sc 共同确认）：**复用率** = 商机句中有多少内容能在必读口播段找到
 * （≥8 字连续重合才算命中）；≥0.6 且剥离后剩余 <15 字 → 纯复读，整句删除；
 * 否则只剥离重合片段（保住「不同维度」的新事实）。
 * ⚠️ 数字保护：回切边界邻接数字/数词/量词时**保守跳过**（避免切出「理财规模三十三点五」这类残句）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneInsightEchoes } from "../lib/services/voice/condense";

test("R2b：纯复读句整句删除；带新维度的句子保留", () => {
  const must = "三季度高频数据折射经济向好。实体融资需求与零售信贷投放环境或有改善。";
  const ins =
    "普惠小微方面，三季度高频数据折射经济向好，实体融资需求与零售信贷投放环境边际改善。" +
    "本地消费方面，广交会一期聚焦先进制造，外卡与结售汇需求集中释放。";
  const r = pruneInsightEchoes(ins, must);
  assert.ok(!r.text.includes("普惠小微方面"), `纯复读句应整句删除：${r.text}`);
  assert.ok(r.text.includes("广交会一期聚焦先进制造"), "有新内容的句子必须保留");
  assert.equal(r.removedSentences, 1);
});

test("R2b：保留「不同维度」的新事实（sc 明确可接受的那类）", () => {
  const must = "美联储加息搅动全球债市。全球债市波动仍会传导至客户避险情绪与外币资产配置选择。";
  const ins = "高端客户方面，黄金定价权向亚洲转移、美联储加息搅动全球债市，避险与对冲类配置需求同步抬升。";
  const r = pruneInsightEchoes(ins, must);
  assert.ok(r.text.includes("黄金定价权向亚洲转移"), "新维度必须保留");
  assert.ok(!r.text.includes("美联储加息搅动全球债市"), "复读片段应被剥离");
  assert.equal(r.trimmedSentences, 1);
  assert.equal(r.removedSentences, 0);
});

test("R2b：数字保护 —— 边界邻接数字时保守跳过，不得产生被切断的数字残句", () => {
  const must = "9月末理财规模维稳33.5万亿，但收益与兑付率全线走低。";
  const ins =
    "零售AUM方面，本周六十五只新发公募基金开启认购，理财规模三十三点五万亿但收益与兑付率全线走低，客户对净值回撤的敏感度明显上升。";
  const r = pruneInsightEchoes(ins, must);
  assert.ok(r.skippedNumeric >= 1, "应因数字保护而跳过");
  assert.ok(!r.text.includes("理财规模三十三点五，"), `不得留数字残句：${r.text}`);
});

test("R2b：剥离后清理悬空助词（「，的」）", () => {
  const must = "央行连续二十三个月增持黄金。贵金属与外币资产值得关注。";
  const ins = "高端客户方面，央行连续二十三个月增持黄金、外储三万四千亿美元，贵金属与外币资产的配置咨询明显增多。";
  const r = pruneInsightEchoes(ins, must);
  assert.ok(!r.text.includes("，的"), `不得留悬空助词：${r.text}`);
  assert.ok(r.text.includes("配置咨询明显增多"), "新内容保留");
});

test("R2b：幂等 + 不 mutate 入参 + 缺省不凭空生成", () => {
  const must = "美联储加息搅动全球债市。";
  const ins = "高端客户方面，黄金定价权向亚洲转移、美联储加息搅动全球债市，避险配置需求抬升。";
  const once = pruneInsightEchoes(ins, must);
  const twice = pruneInsightEchoes(once.text, must);
  assert.equal(twice.text, once.text, "幂等");
  assert.ok(ins.includes("美联储加息搅动全球债市"), "入参未被 mutate");
  assert.equal(pruneInsightEchoes(undefined, must).text, "");
  assert.equal(pruneInsightEchoes(ins, undefined).text, ins, "无必读段 → 原样返回");
});
