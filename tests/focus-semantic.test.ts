/**
 * AI 语义细化（二期 WP11 · 默认关）守护。
 *
 * 钉住四条边界（比「能不能提准」更要紧，因为这是可选增强，出错代价是错标签）：
 *  ① 默认关 = 不传 semantic 时输出与规则版**逐字一致**；
 *  ② 只升不降：AI 只能把 M1→M2 / M2→M3，不能反过来；
 *  ③ 不许凭空引入：只接受「该条规则本来就命中过」的重点；
 *  ④ 失败即退回规则：模型抛错 / 返垃圾 / 空候选，都不影响日报。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySemanticUpgrade,
  buildSemanticPrompt,
  isSemanticCandidate,
  parseSemanticVerdicts,
  refineFocusWithAi,
  type FocusSemanticCandidate,
} from "../lib/services/business-focus/focus-semantic";
import { annotateFocus, collectSemanticCandidates } from "../lib/services/assemble/focus-metadata";
import type { FocusItem } from "../lib/services/business-focus/types";
import type { DailyReport, ReportItem } from "../lib/contracts/report";
import type { LlmPort } from "../lib/contracts/pipeline";

function focus(over: Partial<FocusItem> = {}): FocusItem {
  return {
    id: "a26_aum",
    name: "AUM 规模与结构优化",
    description: "中高端客户资产提升是全年主线",
    layer: "annual",
    grade: "S",
    status: "active",
    priority: 1,
    highlight: true,
    start_date: "2026-01-01",
    end_date: "2026-12-31",
    domains: ["wealth_aum"],
    core_keywords: ["AUM"],
    keywords: ["存款搬家", "代销"],
    synonyms: [],
    concepts: ["客户分层", "资产配置"],
    segments: [],
    products: [],
    exclude_keywords: [],
    source: "年度经营重点",
    description_for_ai: "",
    config_file: "config/annual-focus.json",
    ...over,
  };
}

function item(title: string, over: Partial<ReportItem> = {}): ReportItem {
  return {
    url: `https://e.com/${encodeURIComponent(title).slice(0, 12)}`,
    title_cn: title,
    source: "测试源",
    source_type: "media",
    date: "11/28",
    summary: "",
    importance: 2,
    rank: 1,
    tags: [],
    ...over,
  } as ReportItem;
}

function report(items: ReportItem[]): DailyReport {
  return {
    date: "2026-11-28",
    hero_line: "",
    must_read: [],
    insights: [],
    sections: { gz_local: items, biz_insight: [], policy_market: [], tech: [], ipo: [] },
  };
}

test("① 默认关：不传 semantic 时打标结果与规则版完全一致", () => {
  const rep = report([item("AUM 规模突破千亿"), item("代销基金费率下调")]);
  const a = annotateFocus(rep, [focus()], "f-1");
  const b = annotateFocus(rep, [focus()], "f-1", {});
  assert.deepEqual(JSON.stringify(a), JSON.stringify(b), "空选项不得产生任何差异");
  // 空 Map 同理（调用方可能传空 map）
  const c = annotateFocus(rep, [focus()], "f-1", { semantic: new Map() });
  assert.deepEqual(JSON.stringify(a), JSON.stringify(c));
});

test("② buildSemanticPrompt：带重点定义与候选标题，候选超量在调用侧截断", async () => {
  const cands: FocusSemanticCandidate[] = [{ title: "日均资产规模增长 35%", level: "M2", focusIds: ["a26_aum"] }];
  const { system, prompt } = buildSemanticPrompt(cands, [focus()]);
  assert.ok(system.includes("只输出 JSON"));
  assert.ok(prompt.includes("a26_aum") && prompt.includes("AUM 规模与结构优化"), "重点定义要带上 id 与名称");
  assert.ok(prompt.includes("[0] 日均资产规模增长 35%"), "候选带序号，便于回填");
  assert.ok(prompt.includes("core") && prompt.includes("related"), "判定标准写进 prompt");
  assert.ok(prompt.includes("不要输出这条"), "明确「不相关不输出」，减少误报");
});

test("③ parseSemanticVerdicts：未知 index / 未命中重点 / 非法等级一律丢弃", () => {
  const cands: FocusSemanticCandidate[] = [
    { title: "甲", level: "M2", focusIds: ["a26_aum"] },
    { title: "乙", level: "M1", focusIds: ["a26_aum"] },
  ];
  const allowed = new Set(["a26_aum", "a26_pb"]);
  const map = parseSemanticVerdicts(
    JSON.stringify({
      hits: [
        { i: 0, f: "a26_aum", v: "core", r: "主体即 AUM" },
        { i: 9, f: "a26_aum", v: "core", r: "越界" }, // index 越界
        { i: 1, f: "a26_pb", v: "core", r: "凭空引入" }, // 该条规则没命中 pb
        { i: 1, f: "a26_aum", v: "M3", r: "非法等级" }, // v 只接受 core/related
        { i: 1, f: "a26_aum", v: "related", r: "可作背景" },
      ],
    }),
    cands,
    allowed,
  );
  assert.equal(map.get("甲")?.length, 1);
  assert.equal(map.get("甲")?.[0].level, "M3");
  assert.equal(map.get("乙")?.length, 1, "越界/凭空/非法等级的条目都被丢掉");
  assert.equal(map.get("乙")?.[0].level, "M2");
  // 顶层直接是数组也接受
  const arr = parseSemanticVerdicts(JSON.stringify([{ i: 0, f: "a26_aum", v: "related", r: "" }]), cands, allowed);
  assert.equal(arr.get("甲")?.[0].level, "M2");
  // 垃圾输入
  assert.equal(parseSemanticVerdicts("not json", cands, allowed).size, 0);
});

test("④ applySemanticUpgrade：只升不降，且不动 bonus 字段", () => {
  const matches = [
    { focusId: "a", matchLevel: "M1" as const, reason: "命中 1 个概念", bonus: 3 },
    { focusId: "b", matchLevel: "M2" as const, reason: "领域+关键词", bonus: 10 },
    { focusId: "c", matchLevel: "M3" as const, reason: "标题双词", bonus: 15 },
  ];
  const up = applySemanticUpgrade(matches, [
    { focusId: "a", level: "M2", reason: "说的是同一件事" },
    { focusId: "b", level: "M3", reason: "主体即此事" },
    { focusId: "c", level: "M2", reason: "想降级" }, // 不允许
  ]);
  assert.equal(up[0].matchLevel, "M2", "M1 可升 M2");
  assert.equal(up[1].matchLevel, "M3", "M2 可升 M3");
  assert.equal(up[2].matchLevel, "M3", "AI 不得降级（规则命中是可核对证据）");
  assert.equal(up[0].bonus, 3, "bonus 仍是排序侧真实值，AI 不改账");
  assert.ok(up[1].reason.includes("AI 语义确认：主体即此事"), "理由追加 AI 判断，读者可核对");
  assert.ok(!up[2].reason.includes("AI 语义确认"), "未升级的不追加理由");
  // 不 mutate 入参
  assert.equal(matches[0].matchLevel, "M1");
});

test("⑤ refineFocusWithAi：成功出 map；抛错/空候选都安全", async () => {
  let calls = 0;
  const okLlm: LlmPort = {
    complete: async () => {
      calls += 1;
      return JSON.stringify({ hits: [{ i: 0, f: "a26_aum", v: "core", r: "主体即 AUM" }] });
    },
  };
  const cands: FocusSemanticCandidate[] = [{ title: "日均资产规模增长 35%", level: "M2", focusIds: ["a26_aum"] }];
  const map = await refineFocusWithAi({ candidates: cands, focuses: [focus()], llm: okLlm });
  assert.equal(calls, 1, "只调一次");
  assert.equal(map.get("日均资产规模增长 35%")?.[0].level, "M3");

  const boomLlm: LlmPort = {
    complete: async () => {
      throw new Error("quota exceeded");
    },
  };
  const safe = await refineFocusWithAi({ candidates: cands, focuses: [focus()], llm: boomLlm });
  assert.equal(safe.size, 0, "失败退回规则（不抛错）");

  calls = 0;
  const empty = await refineFocusWithAi({ candidates: [], focuses: [focus()], llm: okLlm });
  assert.equal(empty.size, 0);
  assert.equal(calls, 0, "无候选不调用模型");
});

test("⑥ collectSemanticCandidates：只收 M1/M2，M2 优先，标题去重", () => {
  const rep = report([
    item("AUM 规模突破千亿"), // 标题命中 core → M3，不进候选
    item("代销费率下调 资产配置需求上升"), // 关键词 + 概念 + 领域 → M2
    item("居民存款搬家持续"), // 仅关键词 → M1
    item("代销费率下调 资产配置需求上升"), // 重复标题
    item("今日天气晴朗"), // 无信号
  ]);
  const cands = collectSemanticCandidates(rep, [focus()]);
  const titles = cands.map((c) => c.title);
  assert.ok(!titles.includes("AUM 规模突破千亿"), "M3 不需要复核");
  assert.ok(!titles.includes("今日天气晴朗"), "M0 不进候选");
  assert.equal(titles.filter((t) => t === "代销费率下调 资产配置需求上升").length, 1, "同标题去重");
  if (cands.length >= 2) {
    assert.equal(cands[0].level, "M2", "M2 候选排在前面（截断时先保住更可能是真命中的）");
  }
  assert.ok(isSemanticCandidate("M2", ["a26_aum"]) && !isSemanticCandidate("M3", ["a26_aum"]));
});

test("⑦ annotateFocus 带 semantic：升级体现在 focus_hits 与汇总 high，不动 focusRelevance", () => {
  const rep = report([item("代销基金费率下调")]);
  const plain = annotateFocus(rep, [focus()], "f-1");
  const plainHits = plain.sections?.gz_local?.[0]?.focus_hits ?? [];
  const plainHigh = plain.focus?.items?.[0]?.high ?? 0;

  const semantic = new Map([
    ["代销基金费率下调", [{ focusId: "a26_aum" as const, level: "M3" as const, reason: "主体即代销中收" }]],
  ]);
  const withAi = annotateFocus(rep, [focus()], "f-1", { semantic });
  const aiHits = withAi.sections?.gz_local?.[0]?.focus_hits ?? [];
  assert.ok(aiHits.length >= 1, "升级后仍打标");
  assert.equal(aiHits[0].level, "M3", "等级按 AI 裁定");
  assert.ok(aiHits[0].reason.includes("AI 语义确认"), "理由留痕");
  assert.ok((withAi.focus?.items?.[0]?.high ?? 0) >= plainHigh, "汇总的实质命中数不减少");
  // bonus 不变（AI 不改账）：同级或升级都取排序侧折算值
  if (plainHits[0]) assert.equal(aiHits[0].bonus, plainHits[0].bonus, "bonus 不得因 AI 升级而变");
  void plainHits;
});
