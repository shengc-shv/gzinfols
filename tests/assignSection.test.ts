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
