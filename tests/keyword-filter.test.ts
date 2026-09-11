/**
 * 关键词漏斗（lib/filters/keyword-filter.ts）单测。
 * 使用真实配置 sources.keywords.json（银行零售业务关键词体系 v4）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import path from "node:path";
import type { KeywordConfig } from "../lib/services/select/funnel";
const loadKeywordConfig = (): KeywordConfig =>
  JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "sources.keywords.json"), "utf8")) as KeywordConfig;
import { applyKeywordFilter } from "../lib/services/select/funnel";
import type { RawArticleInput } from "../lib/services/select/funnel";

const cfg = loadKeywordConfig();

const art = (title: string, content = ""): RawArticleInput => ({
  title,
  content,
  sourceId: "test-src",
  url: "https://x/" + encodeURIComponent(title),
});

test("L0 硬排除：标题含全局排除词直接丢弃（负向优先）", () => {
  const r = applyKeywordFilter(art("A股今日涨停，沪指报3400点"), cfg);
  assert.equal(r.pass, false);
  assert.equal(r.bucket, "dropped");
  assert.ok(r.matched.length > 0, "应记录命中的排除词");
});

test("L0 硬排除：非金融干扰词（招聘）同样丢弃", () => {
  assert.equal(applyKeywordFilter(art("某公司招聘500人"), cfg).pass, false);
});

test("geo+维度：广州房贷利率下调 → 个人信贷命中（多维度 all_hit）", () => {
  const r = applyKeywordFilter(art("广州房贷利率下调，首付比例调整"), cfg);
  assert.equal(r.pass, true);
  assert.equal(r.bucket, "daily");
  assert.ok(r.dimensions.includes("personal_credit"), "应命中个人信贷");
});

test("weak 共现：消费贷款命中个人信贷；纯弱词无共现不命中", () => {
  const hit = applyKeywordFilter(art("广州消费贷款利率优惠"), cfg);
  assert.equal(hit.pass, true);
  assert.ok(hit.dimensions.includes("personal_credit"));

  const miss = applyKeywordFilter(art("信贷规模持续增长"), cfg);
  assert.equal(miss.pass, true, "L0 放行进 AI：纯『信贷规模』无地域/商机信号，相关性交由 PASS1/PASS2 裁决");
  assert.ok(!miss.dimensions.includes("personal_credit"), "无共现词仍不应打维度标签");
});

test("商机S：上市辅导备案 → listing_pipeline（需地域命中 geo_lock）", () => {
  const r = applyKeywordFilter(art("广州某企业启动上市辅导备案"), cfg);
  assert.equal(r.pass, true);
  assert.equal(r.bucket, "opportunity");
  assert.equal(r.opportunities?.[0]?.tracker, "listing_pipeline");
  assert.equal(r.opportunities?.[0]?.priority, "S");
});

test("商机A：落户广州设立研发中心 → branch_expansion；北京被 exclude_if_in_title 排除", () => {
  const hit = applyKeywordFilter(art("某企业落户广州设立研发中心扩编500人"), cfg);
  assert.equal(hit.bucket, "opportunity");
  assert.equal(hit.opportunities?.[0]?.tracker, "branch_expansion");

  const skip = applyKeywordFilter(art("某企业落户北京设立研发中心扩编500人"), cfg);
  assert.equal(skip.pass, true, "L0-only：exclude_if_in_title 只挡商机追踪，不放行拦截");
  assert.equal(skip.bucket, "daily", "未命中商机 → daily 兜底");
  assert.equal((skip.opportunities ?? []).length, 0, "含北京不应命中 branch_expansion");
});

test("修复#32：纯招聘软文（招聘仅在正文、无地理锚定）不再误判为机构扩张商机", () => {
  // 此前 branch_expansion 含 "招聘.*人" token，会导致正文中出现「招聘…人」的纯招聘
  // 软文（标题无「招聘」故 L0 拦不到）被误判为机构扩张商机保留进池。移除该冲突
  // token 后，纯招聘噪声不再触发 branch_expansion，落回 daily 兜底（相关性交由 AI 裁决）。
  const r = applyKeywordFilter(art("某公司发布人才发展计划", "公司拟招聘200名新员工填补岗位空缺"), cfg);
  assert.equal(r.pass, true, "L0 仅匹配标题，『招聘』在正文中不触发排除 → 放行进 AI 研判");
  assert.equal((r.opportunities ?? []).length, 0, "移除 招聘.*人 后 branch_expansion 不再误收纯招聘");
  assert.equal(r.bucket, "daily", "无商机命中 → daily 兜底（相关性交由 AI）");
});

test("修复#32：广州地理锚定的扩张线索（招聘在正文）仍正确命中 branch_expansion", () => {
  // 验证地理锚定触发词（落户广州/广州研发中心/扩编）未受影响，真实广州扩张新闻
  // 即便正文带「招聘」也能经地理词命中 branch_expansion，不再依赖已被移除的冲突 token。
  const r = applyKeywordFilter(
    art("某车企落户广州设立研发中心", "项目计划扩编并招聘500名研发人员"),
    cfg,
  );
  assert.equal(r.pass, true);
  assert.equal(r.bucket, "opportunity");
  assert.equal(r.opportunities?.[0]?.tracker, "branch_expansion");
});

test("周报池：私行维度命中 → weekly bucket", () => {
  const r = applyKeywordFilter(art("高净值客户家族信托需求增长"), cfg);
  assert.equal(r.bucket, "weekly");
  assert.ok(r.dimensions.includes("private_banking"));
});

test("多商机：一条信息同时命中 listing_pipeline 与 funding_milestones", () => {
  const r = applyKeywordFilter(art("广州某企业启动上市辅导备案并完成B轮融资"), cfg);
  assert.equal(r.bucket, "opportunity");
  const trackers = (r.opportunities ?? []).map((o) => o.tracker);
  assert.ok(trackers.includes("listing_pipeline"), "应收录上市进程商机");
  assert.ok(trackers.includes("funding_milestones"), "应收录融资里程碑商机");
  assert.equal(r.opportunities?.[0]?.priority, "S", "优先级 S 应排在最前");
});

test("漏斗 L0 放行：纯科技产品/通用新闻不命中 L0 → 放行进 AI（相关性由 AI 裁决）", () => {
  const r = applyKeywordFilter(art("某科技公司发布新款手机"), cfg);
  assert.equal(r.pass, true, "L0 仅拦明显噪声；纯科技无零售信号条目放行进 AI 研判");
  assert.equal(r.bucket, "daily");
});

test("漏斗 L0 放行宏观政策类进 AI：利率/货币信贷/总量宏观均放行进 PASS1/PASS2 研判", () => {
  // 2026-08-22 回退：漏斗只做 L0 明显噪声排除，不再对宏观做相关性预判。
  // 「纯总量/就业类宏观是否相关」交由 PASS1/PASS2 AI 回检裁决（准确性第一）。
  for (const t of [
    "美联储宣布加息25个基点，利率升至5.5%",
    "央行发布2026年第二季度货币政策执行报告",
    "美国非农就业数据超预期，经济保持韧性",
    "国内生产总值上半年同比增长",
  ]) {
    const r = applyKeywordFilter(art(t), cfg);
    assert.equal(r.pass, true, `宏观类应放行进 AI 研判（相关性由 AI 裁决）: ${t}`);
  }
});

// —— 参考区豁免（2026-08-19 修复：tech/ipo/gd-ipo/politics 不过银行零售漏斗）——
test("参考区豁免：tech 技术动态不过漏斗，直接放行", () => {
  const r = applyKeywordFilter({ ...art("OpenAI 发布 GPT-5，多模态能力大幅提升"), category: "tech" }, cfg);
  assert.equal(r.pass, true, "参考区条目应放行");
  assert.notEqual(r.bucket, "dropped");
});

test("参考区豁免：L0 全局排除词对参考区不生效（仅银行零售线适用）", () => {
  const r = applyKeywordFilter({ ...art("A股涨停，沪指报3400点"), category: "tech" }, cfg);
  assert.equal(r.pass, true, "tech 参考区不受 L0 排除词约束");
});

test("参考区豁免：tech 条目仍可触发商机追踪器", () => {
  const r = applyKeywordFilter({ ...art("广州某 AI 公司完成B轮融资"), category: "tech" }, cfg);
  assert.equal(r.pass, true);
  assert.equal(r.bucket, "opportunity");
  const trackers = (r.opportunities ?? []).map((o) => o.tracker);
  assert.ok(trackers.includes("funding_milestones"), "tech 参考区里的融资新闻应进商机池");
});

test("参考区豁免：ipo/gd-ipo/politics 同样放行", () => {
  for (const category of ["ipo", "gd-ipo", "politics"]) {
    const r = applyKeywordFilter(
      { ...art(`[${category}] 常规参考区内容示例`), category },
      cfg,
    );
    assert.equal(r.pass, true, `${category} 参考区应放行`);
  }
});

test("相关性闸门：finance/gz 命中维度即放行；含 L0 噪声词丢弃", () => {
  // 维度命中（加息 = macro_policy strong）→ 放行
  for (const category of ["finance", "gz"]) {
    const r = applyKeywordFilter({ ...art("美联储宣布加息25个基点"), category }, cfg);
    assert.equal(r.pass, true, `${category} 命中维度应放行`);
  }
  // L0 噪声（个股行情）→ 仍 DROP
  for (const category of ["finance", "gz"]) {
    const r = applyKeywordFilter({ ...art("A股今日涨停，沪指报3400点"), category }, cfg);
    assert.equal(r.pass, false, `${category} 含 L0 噪声词应丢弃`);
  }
});

test("相关性闸门：纯国际政治/军事（无零售传导）丢弃", () => {
  for (const t of [
    "特朗普称不会放弃对伊朗的军事选项",
    "广州下半年女兵征集体检完成",
    "以色列空袭黎巴嫩南部",
  ]) {
    const r = applyKeywordFilter(art(t), cfg);
    assert.equal(r.pass, false, `国际政治/军事应丢弃: ${t}`);
    assert.equal(r.bucket, "dropped");
  }
});

test("相关性闸门：广州本地非业务新闻（征兵/天气）丢弃，本地零售业务新闻放行", () => {
  // 本地非业务 → 丢弃
  for (const t of [
    "广州下半年女兵征集体检完成",
    "台风回旋蓄势，未来几天广州阴雨天气持续",
  ]) {
    const r = applyKeywordFilter(art(t), cfg);
    assert.equal(r.pass, false, `广州本地非业务应丢弃: ${t}`);
    assert.equal(r.bucket, "dropped");
  }
  // 本地零售业务（地域 + 本地业务信号）→ 放行
  for (const t of [
    "广州举办国际消费节促零售回暖",
    "番禺区举办轨道交通产业链招商大会系列活动",
  ]) {
    const r = applyKeywordFilter(art(t), cfg);
    assert.equal(r.pass, true, `广州本地零售业务应放行: ${t}`);
  }
});
