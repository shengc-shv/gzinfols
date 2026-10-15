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
import { pruneInsightEchoes, condenseSpeech, formatOverlapLog } from "../lib/services/voice/condense";

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

// ---------------------------------------------------------------------------
// 安全剥点守卫（2026-10-15 sc 定案 A + 结构守卫）：
// 10-14 线上实测 R2b 剥出 3 处**语义残缺**（比复读更伤 —— 口播只能听不能回看）：
//   ① 「公募新规为~~两万五千亿理财资金~~打开投资工具空间」→ 缺宾语
//   ② 「港交所加码人民币产品，~~跨境客户的人民币资产配置与结算需求~~也在联动」→ 缺主语
//   ③ 「…明确到二〇二九年的目标，~~本地科创企业的融资与结算需求~~在扩容」→ 缺主语
// ⚠️ 关键教训：②③ 的剥点前一个字符**正是「，」** → 纯标点判据救不了；
// 根因 = 被剥片段是后随谓词的**主语** / 前述介词的**宾语** → 补两道结构守卫。
// ---------------------------------------------------------------------------

test("安全剥点：被剥片段是宾语（前接悬空介词「为」）→ 保守跳过，句子原样保留", () => {
  const must = "三季度社融数据发布。公募新规落地，两万五千亿理财资金迎来新规。";
  const ins = "零售AUM方面，公募新规为两万五千亿理财资金打开投资工具空间，长尾客群渗透在加快。";
  const r = pruneInsightEchoes(ins, must);
  assert.equal(r.skippedStruct, 1, `应因剥点不安全而跳过：${JSON.stringify(r)}`);
  assert.ok(r.text.includes("公募新规为两万五千亿理财资金打开投资工具空间"), "残宾语风险 → 原句保留");
  assert.ok(!r.text.includes("公募新规为打开投资工具空间"), "不得剥成缺宾语残句");
});

test("安全剥点：被剥片段是主语（后接悬空谓词「也在联动」「在扩容」）→ 保守跳过", () => {
  const must =
    "跨境客户的人民币资产配置与结算需求是重点。本地科创企业的融资与结算需求值得关注。";
  const ins =
    "高端客户方面，港交所加码人民币产品，跨境客户的人民币资产配置与结算需求也在联动。" +
    "普惠小微方面，广州未来产业先导区方案明确到二〇二九年的目标，本地科创企业的融资与结算需求在扩容。";
  const r = pruneInsightEchoes(ins, must);
  assert.ok(r.skippedStruct >= 2, `两处都应因剥点不安全而跳过：${JSON.stringify({ s: r.skippedStruct, e: r.echoes, d: r.removedSentences })}`);
  assert.ok(r.text.includes("跨境客户的人民币资产配置与结算需求也在联动"), "不得剥成「也在联动」缺主语残句");
  assert.ok(r.text.includes("本地科创企业的融资与结算需求在扩容"), "不得剥成「在扩容」缺主语残句");
});

test("安全剥点：后侧切在词中间（「市场|情绪」）→ 跳过；「、」+「，」双标点的真增量仍正常剥离", () => {
  const must = "美债收益率大幅波动。美联储加息预期反复扰动市场。";
  // ① 后侧剥点在词中间：片段后紧跟「情绪」无标点 → 跳过
  const r1 = pruneInsightEchoes("跨境联动方面，美联储加息预期反复扰动市场情绪，外币资产的咨询在增多。", must);
  assert.ok(r1.skippedStruct >= 1, `词中剥点应跳过：${JSON.stringify(r1)}`);
  assert.ok(r1.text.includes("扰动市场情绪"), "不得把「市场情绪」剥断");
  // ② 对照：前侧「、」+ 后侧「，」→ 四条守卫全过，仍剥离
  const r2 = pruneInsightEchoes("高端客户方面，黄金定价权向亚洲转移、美联储加息预期反复扰动市场，避险配置需求抬升。", must);
  assert.equal(r2.trimmedSentences, 1, "安全剥点的真增量仍应剥离");
  assert.ok(r2.text.includes("黄金定价权向亚洲转移"));
  assert.ok(!r2.text.includes("美联储加息预期反复扰动市场"));
});

test("安全剥点：skippedStruct 进日志（只拦不剥时可观测，不得隐形）", () => {
  const must = "三季度社融数据发布。公募新规落地，两万五千亿理财资金迎来新规。";
  const ins = "零售AUM方面，公募新规为两万五千亿理财资金打开投资工具空间，渗透在加快。";
  const { stats } = condenseSpeech({
    spoken_insights: ins,
    spoken_must_read: must,
    must_read: [],
    insights: [],
  });
  assert.equal(stats.skippedStruct, 1, "stats 必须记录 skippedStruct");
  const log = formatOverlapLog(stats);
  assert.ok(log.includes("1 句剥点不安全保守跳过"), `日志应含守卫计数：${log}`);
});
