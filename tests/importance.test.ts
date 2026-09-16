/**
 * A1b 重要度分级重标定（**装配期确定性规则，不动 LLM 提示词**）。
 *
 * 背景：importance 原由 LLM 逐条自评 → 2/3 级占 91%（09-16 实测 2 级 22/31 = 71%），
 * 「今日必知」既不稀缺也不可解释。改为渲染前用确定性规则重分布后，2 级占比 ≤30%。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recalibrateImportance,
  IMPORTANCE_TOP_N,
} from "../lib/services/assemble/importance";
import type { DailyReport, ReportItem } from "../lib/contracts/report";

function item(i: number, title: string): ReportItem {
  return {
    url: `u${i}`,
    title_cn: title,
    source: "源",
    source_type: "media",
    date: "09/16",
    summary: "摘要",
    importance: 2,
    rank: i,
    tags: [],
    locale: "national",
  } as ReportItem;
}

function report(items: ReportItem[]): DailyReport {
  return {
    date: "2026-09-16",
    hero_line: "",
    must_read: [],
    insights: [],
    sections: {
      gz_local: items,
      biz_insight: [],
      policy_market: [],
      tech: [],
      ipo: [],
    },
  } as unknown as DailyReport;
}

const levels = (r: DailyReport) => (r.sections.gz_local ?? []).map((i) => i.importance);

test("A1b：2 级占比 ≤30%（原 LLM 自评 71%~91%）", () => {
  const items = Array.from({ length: 31 }, (_, i) => item(i, `广州本地要闻${i} 财富管理`));
  const lv = levels(recalibrateImportance(report(items)));
  const two = lv.filter((x) => x === 2).length;
  assert.ok(two / lv.length <= 0.3, `2 级占比应 ≤30%，实际 ${two}/${lv.length}`);
});

test("A1b：Top N 进 3 级，末段降 1 级（分级可由排名解释）", () => {
  const items = Array.from({ length: 10 }, (_, i) => item(i, `信贷投放动态${i}`));
  const lv = levels(recalibrateImportance(report(items)));
  assert.equal(lv.filter((x) => x === 3).length, IMPORTANCE_TOP_N, "Top N 为 3 级");
  assert.ok(lv.includes(1), "末段应降为 1 级（折叠）");
});

test("A1b：幂等（同一报告重算结果一致）", () => {
  const r = report(Array.from({ length: 12 }, (_, i) => item(i, `私行客户需求${i}`)));
  const a = recalibrateImportance(r);
  assert.deepEqual(recalibrateImportance(a).sections, a.sections, "重复调用结果必须一致");
});

test("A1b：空报告 / 单条安全，不抛错", () => {
  assert.equal(recalibrateImportance(report([])).sections.gz_local?.length, 0);
  const one = recalibrateImportance(report([item(1, "某条要闻")]));
  assert.equal(one.sections.gz_local?.length, 1);
  assert.equal(one.sections.gz_local?.[0].importance, 3, "唯一条目应为最高级");
});
