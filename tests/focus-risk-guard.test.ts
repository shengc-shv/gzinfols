/**
 * 二期 WP6 守护：**经营重点加权绝不触碰风险段**（规格 6.4 / 9.4）。
 *
 * 设计里写死的一条红线：focus 只改「候选优先级」，风险是单条 `report.risk`，由
 * `extractRiskCandidates`（关键词，上限 5）→ LLM 挑 1 条产出，**整条链路不经过 focus**。
 * 但「没写代码去动它」不等于「以后也不会被动到」—— 这里用回放级断言把它钉住：
 *
 *  ① 加权前后 exec 池的**条目集合完全相同**（只改顺序、不删条 —— 加权不得把人挤掉）；
 *  ② 池顺序严格 = 「正文优先 / 国家政策优先 / (base + focus) 降序」，
 *     证明加权真的参与了排序（不是被悄悄关掉），且没有第四种未声明的比较项；
 *  ③ 被选为风险条目的那条，加权重后**仍在池内**（不会因加权被挤出候选）；
 *  ④ `report.risk` / `must_read` / `insights` 在打标前后逐字不变（focus 只多一个
 *     `focus_hits` 字段，不动任何既有内容）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTwoDayExecPool, type ExecPoolArticle } from "../lib/services/enrich/exec-pool";
import { applyFocus } from "../lib/services/business-focus/focus-apply";
import { scoreBranchRelevance } from "../lib/services/select/filters/relevance-score";
import { annotateFocus } from "../lib/services/assemble/focus-metadata";
import type { FocusItem } from "../lib/services/business-focus/types";
import type { DailyReport, ReportItem } from "../lib/contracts/report";

const TODAY = "2026-11-28";

function focus(over: Partial<FocusItem> = {}): FocusItem {
  return {
    id: "a26_aum",
    name: "AUM 规模与结构优化",
    description: "",
    layer: "annual",
    grade: "S",
    status: "active",
    priority: 1,
    // 显式给 weight=30：让加权幅度可预期（M2 得 20 分），测试不依赖 default 表的具体数字
    weight: 30,
    highlight: true,
    start_date: "2026-01-01",
    end_date: "2026-12-31",
    domains: ["wealth_aum"],
    core_keywords: ["AUM"],
    keywords: ["存款搬家"],
    synonyms: [],
    concepts: ["客户分层", "基金", "保险"],
    segments: [],
    products: [],
    exclude_keywords: ["金价"],
    source: "年度经营重点",
    description_for_ai: "",
    config_file: "config/annual-focus.json",
    ...over,
  };
}

/** 三条今日正文条目：一条命中重点（低基础分）、一条风险载体、一条普通条目。 */
const FOCUS_URL = "https://e.com/aum";
const RISK_URL = "https://e.com/risk";
const PLAIN_URL = "https://e.com/plain";

function item(url: string, title: string, summary: string): ReportItem {
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

const REPORT: DailyReport = {
  date: TODAY,
  hero_line: "",
  must_read: [],
  insights: [],
  risk: {
    topic: "提前还款压力",
    evidence: "部分支行反映提前还款量上升",
    impact: "按揭余额增长承压",
    url: RISK_URL,
    sources: [{ title: "风险源", url: RISK_URL }],
  },
  sections: {
    gz_local: [
      item(FOCUS_URL, "开门红聚焦客户分层与基金保险代销", "多家银行启动开门红，围绕客户分层推进基金、保险代销。"),
      item(RISK_URL, "广州部分区域房贷提前还款量上升", "部分支行反映提前还款量上升，按揭余额增长承压。"),
      item(PLAIN_URL, "广州商圈周末消费活动启动", "商圈联合商户推出周末促消费活动。"),
    ],
    biz_insight: [],
    policy_market: [],
    tech: [],
    ipo: [],
  },
};

const ARTICLES: ExecPoolArticle[] = [
  {
    url: FOCUS_URL,
    publishedAt: `${TODAY}T09:00:00+08:00`,
    category: "gz",
    title: "开门红聚焦客户分层与基金保险代销",
    excerpt: "多家银行启动开门红，围绕客户分层推进基金、保险代销。",
  },
  {
    url: RISK_URL,
    publishedAt: `${TODAY}T10:00:00+08:00`,
    category: "gz",
    title: "广州部分区域房贷提前还款量上升",
    excerpt: "部分支行反映提前还款量上升，按揭余额增长承压。",
  },
  {
    url: PLAIN_URL,
    publishedAt: `${TODAY}T11:00:00+08:00`,
    category: "gz",
    title: "广州商圈周末消费活动启动",
    excerpt: "商圈联合商户推出周末促消费活动。",
  },
];

function pool(focuses?: FocusItem[]) {
  return buildTwoDayExecPool({
    history: {},
    articles: ARTICLES,
    report: REPORT,
    today: TODAY,
    now: new Date(`${TODAY}T12:00:00+08:00`),
    ...(focuses?.length ? { focus: focuses } : {}),
  });
}

/** 与 exec 池内部同口径的基础分（S5：优先源站原文）。 */
function baseOf(it: { title: string; excerpt?: string; summary?: string }): number {
  return scoreBranchRelevance({
    title: it.title,
    ...(it.excerpt?.trim() ? { summary: it.excerpt } : it.summary ? { summary: it.summary } : {}),
  }).score;
}

/** 与 exec 池内部同口径的总分（有 focus 才有加分）。 */
function finalOf(it: { title: string; excerpt?: string; summary?: string }, focuses: FocusItem[]): number {
  const base = baseOf(it);
  if (!focuses.length) return base;
  return applyFocus({ title: it.title, ...(it.excerpt?.trim() ? { excerpt: it.excerpt } : {}) }, base, focuses)
    .finalScore;
}

test("① 加权只改顺序、不删条：exec 池条目集合在加权前后完全相同", () => {
  const a = pool();
  const b = pool([focus()]);
  const urls = (p: ReturnType<typeof pool>) => p.gz.map((i) => i.url).sort();
  assert.deepEqual(urls(a), urls(b), "加权不得让任何条目掉出候选池");
  assert.equal(a.gz.length, 3);
  assert.equal(b.gz.length, 3);
});

test("② 池顺序 = 正文优先 / 国家政策优先 / (base+focus) 降序，没有第四种比较项", () => {
  const focuses = [focus()];
  const p = pool(focuses);
  // 三条都在正文、都不是国家政策稿 → 只应剩 base+focus 一个比较项
  const expect = [...p.gz].sort((x, y) => finalOf(y, focuses) - finalOf(x, focuses)).map((i) => i.url);
  assert.deepEqual(p.gz.map((i) => i.url), expect, "顺序必须严格等于加权总分降序");
  // 加权真的生效：至少一条被提分且顺序确实发生变化
  const boosted = p.gz.filter((i) => finalOf(i, focuses) - baseOf(i) > 0);
  assert.equal(boosted.length, 1, "只有命中重点的那一条被提分");
  const plainOrder = pool().gz.map((i) => i.url);
  assert.notDeepEqual(p.gz.map((i) => i.url), plainOrder, "加权后顺序应有变化（否则引擎等于没接）");
});

test("③ 风险条目加权后仍在池内，且不会被加权条目挤出候选", () => {
  const withFocus = pool([focus()]);
  assert.ok(
    withFocus.gz.some((i) => i.url === RISK_URL),
    "风险条必须留在 exec 池：曾被选为风险的内容不得因重点加权消失",
  );
  // 极端情形：命中重点的条目加分拉满，风险条基础分低 → 依然必须在池内（不删条）
  const heavy = pool([focus({ weight: 30, concepts: ["提前还款", "按揭", "余额"] })]);
  assert.ok(heavy.gz.some((i) => i.url === RISK_URL), "即使风险条自己也命中重点，其所在位置也不得改变其存在性");
});

test("④ 打标不动风险/必读/商机任何一个既有字段（只多一个 focus_hits）", () => {
  const before = JSON.parse(JSON.stringify(REPORT)) as DailyReport;
  const after = annotateFocus(REPORT, [focus()], "f-00000001");
  assert.deepEqual(after.risk, before.risk, "report.risk 必须逐字不变");
  assert.deepEqual(after.must_read, before.must_read);
  assert.deepEqual(after.insights, before.insights);
  assert.equal(after.sections.gz_local.length, before.sections.gz_local.length);
  for (let i = 0; i < before.sections.gz_local.length; i++) {
    const b = before.sections.gz_local[i];
    const a = after.sections.gz_local[i];
    // 除新增 focus_hits 外，其余字段逐字一致（标题/摘要/日期/链接都不得被改写）
    assert.deepEqual({ ...a, focus_hits: undefined, focus: undefined }, { ...b, focus_hits: undefined, focus: undefined });
  }
  assert.deepEqual(
    after.sections.gz_local.map((i) => i.title_cn),
    before.sections.gz_local.map((i) => i.title_cn),
    "顺序与标题不变",
  );
});
