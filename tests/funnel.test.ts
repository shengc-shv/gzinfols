import { test } from "node:test";
import assert from "node:assert/strict";
import { applyKeywordFilter } from "../lib/services/select/funnel";
import type { KeywordConfig } from "../lib/services/select/funnel";

const cfg: KeywordConfig = {
  global_exclude: { hard_exclude: ["彩票"] },
  dimensions: {},
  opportunity_tracker: {},
  risk_tracker: {},
};

test("参考区（tech）漏斗直接放行，仅扫商机/风险追踪器", () => {
  const r = applyKeywordFilter({ title: "AI 大模型新突破", content: "", category: "tech" }, cfg);
  assert.equal(r.pass, true);
});

test("L0 硬排除：标题命中全局黑名单即丢弃", () => {
  const r = applyKeywordFilter({ title: "今日彩票开奖号码", content: "", category: "finance" }, cfg);
  assert.equal(r.pass, false);
  assert.equal(r.bucket, "dropped");
});

test("非参考区金融条目：即使无维度命中也不被 L0 丢弃（漏斗只做硬闸，准度交 AI）", () => {
  const r = applyKeywordFilter({ title: "银行理财净值波动", content: "", category: "finance" }, cfg);
  assert.equal(r.pass, true);
});

test("商机追踪器命中：产出 opportunities 并置 opportunity bucket", () => {
  const c: KeywordConfig = {
    global_exclude: {},
    dimensions: {},
    opportunity_tracker: {
      gov_subsidy: {
        priority: "S",
        strong_triggers: ["补贴", "专项资金"],
        action: "跟进申报",
        fields: ["地区", "行业"],
      },
    },
    risk_tracker: {},
  };
  const r = applyKeywordFilter(
    { title: "广州发放产业补贴专项资金", content: "", category: "finance" },
    c,
  );
  assert.equal(r.pass, true);
  assert.ok(r.opportunities && r.opportunities.length === 1);
  assert.equal(r.bucket, "opportunity");
});
