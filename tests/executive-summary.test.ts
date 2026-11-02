/**
 * resolveInsightSources（商机洞察来源回链）功能测试。
 * 验证：生成时按相似度从当日 finance+gz 精选池回链 1-3 条真实来源；
 * 相关项命中、无关项拒绝、无 url 的输入不参与。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveInsightSources, isMarketViewInsight } from "../lib/services/enrich/executive-summary";

const inputs = [
  { title: "8月LPR保持不变，今年房贷还能否下调？", summary: "LPR 不变但下调预期升温。", url: "https://a/lpr" },
  { title: "黄金，多极时代的新底仓？", summary: "黄金避险需求上升。", url: "https://a/gold" },
];

test("相关洞察回链到正确来源，无关洞察不挂来源", () => {
  const r = resolveInsightSources("房贷下调预期", "LPR下调预期影响按揭客户行为。", inputs);
  assert.equal(r.length, 1, "房贷洞察应命中 1 条");
  assert.equal(r[0].url, "https://a/lpr", "命中 LPR 政策原文");
  assert.equal(resolveInsightSources("AI芯片突破", "算力提升", inputs).length, 0, "无关不挂来源");
});

test("无 url 的输入不参与回链", () => {
  const r = resolveInsightSources("房贷下调预期", "x", [
    { title: "8月LPR保持不变今年房贷还能否下调", summary: "s", url: "" },
  ]);
  assert.equal(r.length, 0);
});

test("多来源时按相似度取前 3 条", () => {
  const pool = [
    { title: "南沙金融30条落地", summary: "利好对公", url: "https://n/1" },
    { title: "南沙跨境结算试点", summary: "跨境", url: "https://n/2" },
    { title: "南沙自贸区扩区", summary: "扩区", url: "https://n/3" },
    { title: "南沙人才政策", summary: "人才", url: "https://n/4" },
    { title: "黄金避险", summary: "避险", url: "https://a/gold" },
  ];
  const r = resolveInsightSources("南沙金融利好对公", "对公存款迎窗口", pool);
  assert.ok(r.length >= 1 && r.length <= 3, "来源数在 1-3");
  assert.ok(r.every((s) => s.url.startsWith("https://n/")), "仅命中南沙相关来源");
});

test("改写表述的单源洞察也能回链（共享 bigram 门槛接住）", () => {
  const pool = [
    { title: "存1年=存2年=存3年，存款利率罕见“持平”", summary: "长期限存款利率出现倒挂后的拉平。", url: "https://a/deposit-flat" },
    { title: "30个托位、12月龄即可入托！广州南沙普惠托育园", summary: "托育。", url: "https://a/tuoyu" },
  ];
  // 「存款利率期限拉平」与「存1年=存2年=存3年，存款利率罕见持平」同主题但措辞改写
  const hit = resolveInsightSources("存款利率期限拉平", "长期限存款定价趋同", pool);
  assert.equal(hit.length, 1, "应命中存款利率原文（单源）");
  assert.equal(hit[0].url, "https://a/deposit-flat");
  // 共享 bigram 门槛必须挡掉完全无关（托育园）的错源
  const wrong = resolveInsightSources("小微融资协调机制升级", "影响普惠客群", pool);
  assert.equal(wrong.length, 0, "无任何共享字符片段→不臆造错源");
});


/* ------------------------------------------------------------------ *
 * 2026-11-02 sc：商机不许拿「市场观点」凑数
 * ------------------------------------------------------------------ */

test("商机口径：券商研判 / 估值观点 / 配置建议 一律判为市场观点（应剔除）", () => {
  // 11-02 实测 6 条商机里有 4 条是这类，全部落不到客群/产品上
  const bad: Array<[string, string, Array<{ title: string }>?]> = [
    ["机构建议均衡配置", "客户对弹性资产与防御底仓的搭配诉求上升。"],
    ["中金称估值有吸引力", "机构对估值吸引力的表态增多。"],
    ["六大机构后市研判分歧", "机构观点分歧仍存，客户沟通素材增多。"],
    ["红利资产咨询升温", "稳健型客户对分红类产品的关注度上升。", [{ title: "红利资产成香饽饽！机构最新解读" }]],
    ["券商晨会要点", "关注度提升。"],
  ];
  for (const [topic, impact, src] of bad) {
    assert.ok(isMarketViewInsight(topic, impact, src), `应剔除：${topic}`);
  }
});

test("商机口径反向守护：落到客群/产品的真线索不得被误杀", () => {
  const good: Array<[string, string, Array<{ title: string }>?]> = [
    ["大额存单上新与定存降息分化", "中长期存单集中供给，客户在期限与收益间的选择出现空档。"],
    ["双十一消费贷贴息叠加分期战", "贴息与购物节叠加，大额分期定价与额度竞争升温。"],
    ["同业压缩互联网助贷新增合作", "消费贷获客渠道结构面临调整，合作方名单发生变化。"],
    ["外资调仓与主题配置", "外资增持创新药与红利股。", [{ title: "三季度外资机构大调仓增持创新药及红利股" }]],
    // 只要有一条来源落到实事上就保留（宁可错留，不可错杀）
    ["红利资产咨询升温", "客户关注度上升。", [{ title: "红利资产成香饽饽！机构最新解读" }, { title: "某行发布红利主题理财产品" }]],
  ];
  for (const [topic, impact, src] of good) {
    assert.ok(!isMarketViewInsight(topic, impact, src), `不得误杀：${topic}`);
  }
});
