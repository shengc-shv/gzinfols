import { test } from "node:test";
import assert from "node:assert/strict";
import { categoryToSection } from "../lib/services/enrich/pipeline";
import {
  isGzLocalCandidate,
  isPolicyMarketCandidate,
} from "../lib/services/enrich/heuristics";

/**
 * 红线②：板块归属由内容判定（gzinfo categoryToSection 语义）。
 * gzinfo 口径：gz_local/policy_market/biz_insight 由内容判定（gz 锚/政策词/市场信号）；
 * tech/ipo 是独立内容栏目，按 category 归栏（文档化的展示窗口例外）。
 */

test("红线②：category=finance 且标题含广州锚+业务词 → gz_local", () => {
  assert.equal(
    categoryToSection("finance", "广州出台营商环境改革新举措", "面向企业的惠企政策发布。"),
    "gz_local",
  );
  assert.ok(isGzLocalCandidate("广州出台营商环境改革新举措", "面向企业的惠企政策发布。"));
});

test("红线②：政策词命中 → policy_market（内容判定，与 category 无关）", () => {
  assert.equal(
    categoryToSection("finance", "央行降准释放流动性支持实体经济", "宏观政策动态。"),
    "policy_market",
  );
  assert.ok(isPolicyMarketCandidate("央行降准释放流动性支持实体经济", "宏观政策动态。"));
});

test("红线②：tech/ipo 独立内容栏目按 category 归栏（gzinfo 文档化例外）", () => {
  assert.equal(categoryToSection("tech", "任意标题"), "tech");
  assert.equal(categoryToSection("ipo", "任意标题"), "ipo");
  assert.equal(categoryToSection("gd-ipo", "任意标题"), "ipo");
});

test("红线②：本地生活政务（广州锚但无业务词）不进 gz_local", () => {
  assert.equal(isGzLocalCandidate("广州某公园志愿者招募启动", "面向市民的公益活动。"), false,
    "无银行业务词 → 不是 gz_local 候选（宁缺毋滥门槛）");
  assert.equal(categoryToSection("finance", "广州某公园志愿者招募启动", "公益活动。"), "biz_insight",
    "无政策词/市场词 → biz_insight");
});

test("红线②：无命中 → biz_insight 兜底", () => {
  assert.equal(categoryToSection("finance", "一则普通社会新闻标题", ""), "biz_insight");
});

/**
 * ============================================================================
 * 2026-10-04 归栏复查（sc「检查全部归栏逻辑」）新增守护
 * ============================================================================
 */

test("归栏：国际/境外宏观 → policy_market（此前无国际地域锚 → 全落兜底 biz_insight）", () => {
  // 实证背景：`FOREIGN_REGION_RE` 只覆盖**国内外地**省市，于是国际宏观没有任何锚可命中
  // → 全部落 `biz_insight`；而该栏是最拥挤的栏（10-04 实测 81 条候选争 8 个展示位）
  // → 国际面被业务条目整批挤出，读者与定调都看不到。
  const cases: Array<[string, string]> = [
    ["美股三大指数集体收涨 纳指盘中创新高", "科技股领涨。"],
    ["G7同意联手释放1亿桶能源储备", "换取美国放弃柴油出口禁令。"],
    ["欧洲债市剧震背后的三重压力", ""],
    ["美国9月非农就业人数增加2.9万人大幅低于预期", ""],
    ["【财经分析】法国缘何成为欧洲债市动荡关注焦点", ""],
    ["加息预期骤变！美联储官员鹰派立场软化", ""],
    ["港股国庆后首日交易遇冷 三大指数集体重挫", ""],
  ];
  for (const [t, ex] of cases) {
    assert.equal(categoryToSection("finance", t, ex), "policy_market", `${t}｜国际宏观应归政策与市场`);
    assert.ok(isPolicyMarketCandidate(t, ex), `${t}｜isPolicyMarketCandidate 应为真`);
  }
});

test("归栏：泛化词「国际/全球」不得把本地新闻吸进 policy_market（收词原则）", () => {
  // 实测踩到：若把裸词「国际」当地域锚，「中国国际漫画节广州开幕」
  // 「花都…广州国际商业港建设一线」都会被拉进政策与市场。
  for (const t of [
    "中国国际漫画节广州开幕，金龙奖揭晓年度好动漫",
    "花都「六懂英才」在广州国际商业港建设一线淬炼成长",
  ]) {
    assert.equal(categoryToSection("gz", t, ""), "biz_insight", `${t}｜泛词不是地域锚，不得迁移`);
  }
});

test("归栏：境外锚不得抢走广州本地条目（gz_local 优先级高于 policy_market）", () => {
  assert.equal(
    categoryToSection("finance", "广州企业赴美上市，跨境电商融资需求上升", "广州银行业务机会。"),
    "gz_local",
    "含广州锚 + 业务词 → 先判 gz_local，不能被境外锚抢走",
  );
});

test("归栏单一真源：两处 categoryToSection 必须是同一个函数（防再次漂移）", async () => {
  // 2026-10-04 实测的漂移：`render/report-from-articles` 版多一条 isGdIpoCandidate 判定，
  // 导致「同一条广东 IPO 媒体报道」在预览脚本与生产管线归到不同板块。
  const p = await import("../lib/services/enrich/pipeline");
  const r = await import("../lib/services/render/report-from-articles");
  assert.equal(
    p.categoryToSection,
    r.categoryToSection,
    "两处必须是同一引用（re-export），不得各自实现",
  );
});

test("归栏：媒体源广东企业 IPO 报道 → ipo（补齐的那个漂移分支）", () => {
  for (const t of ["证监会同意粤芯半导体IPO注册", "粤芯半导体：IPO注册生效（拟科创板）"]) {
    assert.equal(categoryToSection("finance", t, ""), "ipo", `${t}｜广东企业 IPO 进展应归 IPO 栏目`);
  }
});
