/**
 * 新版首页 brief（核心判断 + 三段式今日经营重点）守护。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBrief,
  buildBriefPrompt,
  collectBriefCandidates,
  isCriticalRisk,
  parseBrief,
  promoteCriticalRisk,
} from "../lib/services/assemble/brief";
import type { DailyReport, ReportItem } from "../lib/contracts/report";

function item(title: string, url: string, summary = ""): ReportItem {
  return {
    url,
    title_cn: title,
    source: "测试源",
    source_type: "media",
    date: "11/28",
    summary,
    importance: 2,
    rank: 1,
    tags: [],
    locale: "gz",
  };
}

function report(): DailyReport {
  return {
    date: "2026-11-28",
    hero_line: "今日定调",
    must_read: [
      { title: "房贷利率下调", why: "影响住房金融条线", url: "https://e.com/a" },
      { title: "跨境结算便利化", why: "影响跨境客群", url: "https://e.com/b" },
      { title: "黄金配置区间", why: "影响财富货架", url: "https://e.com/c" },
    ],
    insights: [
      {
        topic: "房贷客群变化",
        tags: ["信贷"],
        impact: "按揭咨询与提前还款节奏会变。",
        sources: [{ title: "房贷", url: "https://e.com/a" }],
      },
    ],
    sections: {
      gz_local: [item("房贷利率下调", "https://e.com/a", "首套房贷利率下调 20bp。")],
      biz_insight: [item("跨境结算便利化", "https://e.com/b", "跨境结算试点扩容。")],
      policy_market: [item("黄金配置区间", "https://e.com/c", "黄金配置区间 5%~28%。")],
      tech: [],
      ipo: [],
    },
  };
}

test("brief 候选：只取 must_read，回填正文与同 URL 商机影响", () => {
  const c = collectBriefCandidates(report());
  assert.equal(c.length, 3);
  assert.equal(c[0].ref, "m1");
  assert.equal(c[0].url, "https://e.com/a");
  assert.match(c[0].fact, /首套房贷利率/);
  assert.match(c[0].impact, /按揭咨询/);
  assert.equal(c[1].impact, "", "无同 URL 商机影响时留空，不编");
});

test("brief prompt：带候选编号与三段式字段，禁止 URL/领域/状态", () => {
  const { system, prompt } = buildBriefPrompt(collectBriefCandidates(report()));
  assert.match(system, /只能使用给定候选/);
  assert.match(system, /不写操作建议/);
  assert.match(prompt, /\[m1\]/);
  assert.match(prompt, /core_judgment/);
  assert.match(prompt, /priorities/);
  assert.match(prompt, /what.*impact.*watch/s);
});

test("brief 解析：只认合法 ref 与字数，保留 URL 回填", () => {
  const cands = collectBriefCandidates(report());
  const raw = JSON.stringify({
    core_judgment: "今日主要看住房金融与跨境结算两条线，房贷利率下调带动按揭咨询升温，跨境试点扩容改变客群结算路径。",
    priorities: [
      {
        ref: "m1",
        short: "房贷利率下调 20bp",
        what: "广州首套房贷利率下调 20bp，按揭成本同步下降。",
        impact: "住房金融条线的咨询量与提前还款节奏会发生变化。",
        watch: "后续各银行跟进幅度与区域成交修复情况。",
      },
      {
        ref: "m2",
        short: "跨境结算试点扩容",
        what: "跨境结算便利化试点扩容，覆盖更多贸易场景。",
        impact: "跨境客群的收付与汇率避险需求更集中。",
        watch: "试点落地节奏与参会企业名单。",
      },
      {
        ref: "m3",
        short: "黄金配置区间量化",
        what: "世界黄金协会给出 5%~28% 的黄金配置区间。",
        impact: "财富货架的配置沟通有了量化参照。",
        watch: "金价波动与客户申赎变化。",
      },
      {
        ref: "bad",
        short: "不存在的引用",
        what: "这条应该被丢弃，因为 ref 不在候选里。",
        impact: "不应进入页面。",
        watch: "不应进入页面。",
      },
    ],
  });
  const b = parseBrief(raw, cands);
  assert.ok(b);
  assert.equal(b.priorities.length, 3);
  assert.equal(b.priorities[0].title, "房贷利率下调");
  assert.equal(b.priorities[0].url, "https://e.com/a");
  assert.ok(b.core_judgment.length >= 15);
});

test("buildBrief：一次 LLM 调用，回填候选标题/URL", async () => {
  let calls = 0;
  const raw = JSON.stringify({
    core_judgment: "今日主要看住房金融与跨境结算两条线，房贷利率下调带动按揭咨询升温，跨境试点扩容改变客群结算路径。",
    priorities: [
      {
        ref: "m1",
        short: "房贷利率下调",
        what: "广州首套房贷利率下调 20bp，按揭成本同步下降。",
        impact: "住房金融条线的咨询量与提前还款节奏会变化。",
        watch: "后续银行跟进幅度与区域成交修复情况。",
      },
      {
        ref: "m2",
        short: "跨境结算试点扩容",
        what: "跨境结算便利化试点扩容，覆盖更多贸易场景。",
        impact: "跨境客群收付与汇率避险需求更集中。",
        watch: "试点落地节奏与企业名单。",
      },
      {
        ref: "m3",
        short: "黄金配置区间量化",
        what: "世界黄金协会给出 5%~28% 的黄金配置区间。",
        impact: "财富货架配置沟通有了量化参照。",
        watch: "金价波动与客户申赎变化。",
      },
    ],
  });
  const b = await buildBrief(report(), {
    llm: { complete: async () => { calls++; return raw; } },
  });
  assert.equal(calls, 1);
  assert.ok(b);
  assert.equal(b.priorities[0].title, "房贷利率下调");
  assert.equal(b.priorities[0].url, "https://e.com/a");
});

test("重大风险硬兜底：T1 新增风险未被 brief 选中 → promotedRisk，已选中则打 riskLevel", () => {
  const base = report();
  const risk = {
    topic: "监管处罚风险",
    evidence: "监管部门对某机构作出行政处罚。",
    impact: "财富条线代销与投顾传播面临合规审视。",
    source: "T1" as const,
    delta: { state: "new" as const },
  };
  const r = { ...base, risk };
  assert.equal(isCriticalRisk(risk), true);
  const promoted = promoteCriticalRisk(r);
  assert.ok(promoted.promotedRisk);
  assert.equal(promoted.promotedRisk?.riskLevel, "critical");
  assert.equal(r.promotedRisk, undefined, "不得 mutate 入参");

  const followup = promoteCriticalRisk({ ...r, risk: { ...risk, delta: { state: "followup" as const } } });
  assert.equal(followup.promotedRisk, undefined, "纯续报不触发硬兜底");

  const briefWithRisk = {
    core_judgment: "今日核心判断。",
    priorities: [
      { title: risk.topic, short: "监管处罚风险", what: risk.evidence, impact: risk.impact, watch: "关注后续监管口径。" },
      { title: "另一件事", short: "另一件事", what: "事实发生。", impact: "经营影响。", watch: "关注后续。" },
      { title: "第三件事", short: "第三件事", what: "事实发生。", impact: "经营影响。", watch: "关注后续。" },
    ],
  };
  const marked = promoteCriticalRisk({ ...r, brief: briefWithRisk });
  assert.equal(marked.promotedRisk, undefined, "已在第二层则不重复插入");
  assert.equal(marked.brief?.priorities[0].riskLevel, "critical", "已纳入也要显式打红标");
});

test("brief 解析：核心判断超长且重点不足 3 条 → 整体回退；全空返回 undefined", () => {
  const cands = collectBriefCandidates(report());
  const longCore = "核".repeat(120);
  const raw = JSON.stringify({
    core_judgment: longCore,
    priorities: [
      {
        ref: "m1",
        short: "房贷利率下调",
        what: "首套房贷利率下调 20bp，按揭成本下降。",
        impact: "住房金融条线的按揭咨询量与提前还款节奏会变化。",
        watch: "后续银行跟进与成交修复。",
      },
    ],
  });
  const b = parseBrief(raw, cands);
  assert.equal(b, undefined, "只有 1 条重点 + core 非法 → 不用半成品");
  assert.equal(parseBrief("{}", cands), undefined);
  assert.equal(parseBrief("not json", cands), undefined);
});
