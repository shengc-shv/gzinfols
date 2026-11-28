/**
 * 经营重点规则匹配 + 评分封顶（二期 WP3/WP4）守护。
 *
 * 锁住规格 3.3 / 4.3 / 4.5 的判定口径：
 *  - 关键词偶然出现只到 M1；M2 起必须有领域或 ≥2 概念佐证；M3 必须在标题命中；
 *  - 排除词一票否决；
 *  - 加分：最高为主、次高 0.3 衰减、最多计两个、单条封顶 30；
 *  - 弱条目（base<40）加分减半，drop 档零加分 —— 低质不得靠重点上位；
 *  - 基础分不被改写（finalScore 只用于排序）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchFocus } from "../lib/services/business-focus/focus-matcher";
import { scoreFocus, bonusOf, WEAK_BASE_SCORE } from "../lib/services/business-focus/focus-scoring";
import type { FocusItem } from "../lib/services/business-focus/types";

function focus(over: Partial<FocusItem> = {}): FocusItem {
  return {
    id: "q4_customer_aum",
    name: "中高端客户AUM提升",
    description: "",
    layer: "quarterly",
    grade: "S",
    status: "active",
    priority: 1.5,
    highlight: true,
    start_date: "2026-10-01",
    end_date: "2026-12-31",
    domains: ["wealth_aum", "customer_growth"],
    core_keywords: ["AUM", "私行"],
    keywords: ["资产配置", "财富客户"],
    synonyms: ["客户金融资产"],
    concepts: ["客户分层", "基金", "保险"],
    segments: ["中高端"],
    products: ["理财"],
    exclude_keywords: ["金价"],
    source: "季度经营重点",
    description_for_ai: "",
    config_file: "config/quarterly-focus.json",
    ...over,
  };
}

test("① M3：标题命中核心词 + 领域匹配", () => {
  const m = matchFocus({ title: "某行AUM突破千亿", domains: ["wealth_aum"] }, [focus()]);
  assert.equal(m.length, 1);
  assert.equal(m[0].matchLevel, "M3");
  assert.match(m[0].reason, /核心词/);
  assert.ok(m[0].signals.domainMatched);
});

test("② M3：标题命中两个普通关键词 + 领域匹配", () => {
  const m = matchFocus({ title: "资产配置与财富客户双增长", domains: ["wealth_aum"] }, [focus()]);
  assert.equal(m[0].matchLevel, "M3");
});

test("③ 单个关键词 + 领域匹配最多 M1（不足 M2，防「关键词偶然出现」）", () => {
  // 2026-11-28 回放校准：旧口径给 M2 +18，让 base 42 的统计稿「金融监管总局：银行业
  // 总资产…」（仅命中机构名 + 领域）窜到 56 分政策稿之上，属 False Boost。
  // 现在同一条只到 M1 +3，排位不动；要升到 M2 必须有概念级佐证。
  const m = matchFocus({ title: "银行加码资产配置服务", domains: ["wealth_aum"] }, [focus()]);
  assert.equal(m[0].matchLevel, "M1");
});

test("④ M2：无关键词但命中两个关联概念", () => {
  const m = matchFocus({ title: "客户分层下的基金与保险配置", domains: [] }, [focus()]);
  assert.equal(m[0].matchLevel, "M2");
  assert.ok(m[0].signals.concepts.length >= 2, `概念命中数不足：${m[0].signals.concepts.join("/")}`);
  assert.ok(m[0].signals.concepts.includes("客户分层"));
  assert.ok(!m[0].signals.domainMatched, "本例领域未匹配，靠概念佐证升到 M2");
});

test("⑤ 只靠领域匹配只到 M1；只命中一个概念也只到 M1", () => {
  // 领域是宽分类（「黄金」→ 财富、`金融监管` → 风险管理），单靠它对上最多 +3，
  // 这样一条新闻即使同时命中五个重点，也最多按前两条计 +3+0.9，不会改变量级。
  const byDomain = matchFocus({ title: "某行发布零售业务季度数据", domains: ["wealth_aum"] }, [focus()]);
  assert.equal(byDomain[0].matchLevel, "M1");
  const byConcept = matchFocus({ title: "银行推进客户分层", domains: [] }, [focus()]);
  assert.equal(byConcept[0].matchLevel, "M1");
});

test("⑥ 仅词面命中、无领域佐证：最多 M1，不得升到 M2/M3", () => {
  const m = matchFocus({ title: "资产配置与财富客户专题", domains: ["retail_credit"] }, [focus()]);
  assert.equal(m[0].matchLevel, "M1", "两个词但领域不匹配，只能是弱相关");
});

test("⑦ 排除词一票否决：原文出现「金价」不算财富重点", () => {
  const m = matchFocus(
    { title: "AUM 与资产配置双升", excerpt: "受金价波动影响，客户转向积存金", domains: ["wealth_aum"] },
    [focus()],
  );
  assert.deepEqual(m, [], "排除词命中必须整条判 M0");
});

test("⑧ 无信号 / 无生效重点：不产出匹配", () => {
  assert.deepEqual(matchFocus({ title: "国足热身赛", domains: [] }, [focus()]), []);
  assert.deepEqual(matchFocus({ title: "AUM 突破", domains: ["wealth_aum"] }, []), []);
  assert.deepEqual(matchFocus({ title: "", domains: [] }, [focus()]), []);
});

test("⑨ 每条命中都带可核对依据：reason 非空、evidence 是原文子串且 ≤30 字", () => {
  const text = "广州某行中高端客户AUM 同比增长 18%，资产配置渗透率提升";
  const m = matchFocus({ title: text, domains: ["wealth_aum"] }, [focus()]);
  assert.ok(m[0].reason.length > 0);
  assert.ok(m[0].evidence.length > 0, "必须有证据片段");
  for (const e of m[0].evidence) {
    assert.ok(text.includes(e.replace(/\s+/g, " ")) || text.includes(e), `证据必须来自原文：${e}`);
    assert.ok(e.length <= 30);
  }
});

test("⑩ 确定性：同一输入两次匹配结果逐字一致，且按等级降序", () => {
  const inputs = [
    focus({ id: "q1", layer: "quarterly", grade: "S" }),
    focus({ id: "a1", layer: "annual", grade: "A", core_keywords: [], keywords: ["资产配置", "财富客户"], concepts: [] }),
  ];
  const a = matchFocus({ title: "AUM 与资产配置", domains: ["wealth_aum"] }, inputs);
  const b = matchFocus({ title: "AUM 与资产配置", domains: ["wealth_aum"] }, inputs);
  assert.deepEqual(a, b);
  // q1 命中核心词（AUM）+ 领域 → M3；a1 只命中 1 个关键词、无核心词无概念 → M1
  assert.deepEqual(a.map((x) => x.matchLevel), ["M3", "M1"]);
});

test("⑪ 加分：季度 M3 = 20，finalScore = base + 20，基础分不被改写", () => {
  const [m] = matchFocus({ title: "AUM 突破", domains: ["wealth_aum"] }, [focus()]);
  const r = scoreFocus({ base: 68, tier: "must_read", matches: [m] }, [focus()]);
  assert.equal(r.focusRelevance, 20);
  assert.equal(r.finalScore, 88);
  assert.equal(r.counted.length, 1);
});

test("⑫ 多命中：最高为主 + 次高 0.3 衰减，最多计两个", () => {
  const f = focus();
  const sig = { core: ["AUM"], keywords: [], concepts: [], domainMatched: true };
  const m3 = { focusId: "q3", name: f.name, layer: f.layer, grade: f.grade, matchLevel: "M3" as const, reason: "", evidence: [], signals: sig };
  const m2 = { ...m3, focusId: "q2", matchLevel: "M2" as const };
  const m1 = { ...m3, focusId: "q1", matchLevel: "M1" as const };
  const r = scoreFocus({ base: 60, matches: [m3, m2, m1] }, [f]);
  assert.equal(r.focusRelevance, 23.6, "20 + 12×0.3，第三条忽略");
  assert.equal(r.counted.length, 2);
  assert.ok(r.guards.some((g) => /仅计前 2 个/.test(g)));
});

test("⑬ 封顶：临时专项 M3(30) + 次高也超不过 CAP=30", () => {
  const t = focus({ id: "t1", layer: "temporary", grade: "S", core_keywords: ["楼市"], keywords: [], concepts: [] });
  const t2 = focus({ id: "t2", layer: "temporary", grade: "A" });
  const m1 = { focusId: "t1", name: t.name, layer: "temporary" as const, grade: "S" as const, matchLevel: "M3" as const, reason: "", evidence: [], signals: { core: [], keywords: [], concepts: [], domainMatched: true } };
  const m2 = { ...m1, focusId: "t2", grade: "A" as const, matchLevel: "M2" as const };
  const r = scoreFocus({ base: 50, matches: [m1, m2] }, [t, t2]);
  assert.equal(r.focusRelevance, 30, "30 + 18×0.3 = 35.4 → 封顶 30");
  assert.ok(r.guards.some((g) => /封顶/.test(g)));
});

test("⑭ 弱条目：base < 40 加分减半；drop 档零加分", () => {
  const f = focus();
  const [m] = matchFocus({ title: "AUM 突破", domains: ["wealth_aum"] }, [f]);
  const weak = scoreFocus({ base: WEAK_BASE_SCORE - 10, matches: [m] }, [f]);
  assert.equal(weak.focusRelevance, 10, "20 减半");
  assert.ok(weak.guards.some((g) => /减半/.test(g)));
  const dropped = scoreFocus({ base: 70, tier: "drop", matches: [m] }, [f]);
  assert.equal(dropped.focusRelevance, 0);
  assert.equal(dropped.finalScore, 70, "drop 档排序分不得被抬高");
});

test("⑮ 无命中：零加分、finalScore === base（引擎不得改变基础排序）", () => {
  const r = scoreFocus({ base: 55, matches: [] }, [focus()]);
  assert.equal(r.focusRelevance, 0);
  assert.equal(r.finalScore, 55);
  assert.deepEqual(r.counted, []);
});

test("⑯ weight 覆盖：显式配了 weight 时按配置分值折算，M2 为一档的 0.6", () => {
  const f = focus({ weight: 25 });
  assert.equal(bonusOf({ layer: "quarterly", matchLevel: "M3" }, f), 25);
  assert.equal(bonusOf({ layer: "quarterly", matchLevel: "M2" }, f), 15, "25 × (12/20)");
  assert.equal(bonusOf({ layer: "quarterly", matchLevel: "M3" }, focus()), 20, "未配 weight 用默认表");
});
