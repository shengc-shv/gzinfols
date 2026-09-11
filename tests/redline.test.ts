/**
 * 红线回归测试（三条业务红线，QA 独立验证用）。
 *
 * 红线①：无真实 publishedAt 一律丢弃，绝不用抓取时间兜底（normalize 唯一裁决点）。
 * 红线②：板块归属由内容判定，不读 sourceId/category 字符串做一般归属
 *        （category 仅限 IPO 内容态与参考区豁免）。
 * 红线③：业务相关性——与客群/财富/私人银行/信贷无关且非商机政策的条目，
 *        在 ai 模式相关性回检中被丢弃（仅显式 relevant=false 才丢）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runPipeline } from "../lib/pipeline";
import { createContext } from "../lib/orchestrator";
import { enrich, assignSection } from "../lib/services/enrich";
import { normalize } from "../lib/services/normalize";
import type { PipelineDeps, LlmPort } from "../lib/contracts/pipeline";
import type { SourceDef } from "../lib/contracts/source";
import type { ArticleInput } from "../lib/contracts/article";
import { MemFs, FakeHttp, FakeClock, SilentLog } from "./helpers";

const sources: SourceDef[] = [
  {
    id: "test",
    name: "测试源",
    type: "rss",
    url: "https://example.com/feed",
    category: "finance",
    tier: "T1",
    enabled: true,
  },
];

const KEYWORDS = { global_exclude: {}, dimensions: {}, opportunity_tracker: {}, risk_tracker: {} };

const NOW = new Date("2026-09-11T08:00:00Z");

function articleInput(over: Partial<ArticleInput>): ArticleInput {
  return {
    sourceId: "test",
    title: "标题",
    url: "u",
    category: "finance",
    publishedAt: NOW,
    excerpt: "摘要",
    isIpo: false,
    tier: "T2",
    source: "测试源",
    ...over,
  } as ArticleInput;
}

/** 可编排 LLM：按 system 关键词分流；相关性判定结果由用例注入。 */
class ScriptedLlm implements LlmPort {
  calls = 0;
  /** url → relevant 映射（相关性回检用）。 */
  verdicts: Array<{ url: string; relevant: boolean }> = [];
  /** 相关性回检返回的原始 JSON（用于幻觉 url 用例直接注入）。 */
  relevanceJson?: string;

  async complete(opts: { system?: string; prompt: string }): Promise<string> {
    this.calls++;
    const sys = opts.system ?? "";
    if (sys.includes("相关性")) {
      if (this.relevanceJson !== undefined) return this.relevanceJson;
      return JSON.stringify(this.verdicts);
    }
    if (sys.includes("简报编辑")) {
      const items = [...opts.prompt.matchAll(/(\d+)\. 标题：/g)].map((m) => ({
        i: Number(m[1]),
        title_cn: "改写标题",
        summary: "改写摘要。",
        tags: ["标签"],
        importance: 2,
      }));
      return JSON.stringify(items);
    }
    // 报告级
    return JSON.stringify({ hero_line: "定调", insights: [], must_read: [], risk: undefined });
  }
}

// ————— 红线①：无真实 publishedAt 一律丢弃，不进任何下游 —————

test("红线① e2e：缺失 pubDate 的条目被丢弃，不进板块/HTML/历史库", async () => {
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>t</title>
<item>
  <title>广州小微企业信贷政策落地</title>
  <link>https://example.com/valid</link>
  <description>银行信贷投放创历史新高，普惠金融持续加码。</description>
  <pubDate>${NOW.toUTCString()}</pubDate>
</item>
<item>
  <title>无时间戳的神秘条目</title>
  <link>https://example.com/no-date</link>
  <description>这条没有发布时间。</description>
</item>
</channel></rss>`;

  const fs = new MemFs();
  fs.setJson("sources.config.json", { sources });
  fs.setJson("sources.keywords.json", KEYWORDS);
  const deps: PipelineDeps = {
    fs,
    clock: new FakeClock(),
    llm: new FakeLlmForRedline(),
    http: new FakeHttp(rss),
  };
  const ctx = createContext({
    date: "2026-09-11",
    mode: { kind: "ai" },
    sources,
    log: new SilentLog(),
    startTime: NOW,
  });

  const out = await runPipeline(ctx, deps);

  const allTitles = Object.values(out.report.sections)
    .flat()
    .map((it) => it.title_cn)
    .join("|");
  assert.ok(!allTitles.includes("无时间戳的神秘条目"), "无发布时间条目不得进任何板块");
  assert.ok(!out.html.includes("无时间戳的神秘条目"), "无发布时间条目不得进 HTML");
  assert.ok(!out.markdown.includes("无时间戳的神秘条目"), "无发布时间条目不得进 Markdown");
  const hist = await fs.readJson<{ items: Array<{ url: string }> }>("data/history.json");
  assert.ok(
    hist && hist.items.every((it) => it.url !== "https://example.com/no-date"),
    "无发布时间条目不得进历史库",
  );
  // 对照组：有效条目正常上榜
  assert.ok(
    Object.values(out.report.sections).flat().some((it) => it.url === "https://example.com/valid"),
    "有效条目应正常上榜",
  );
});

test("红线① 单元：Invalid Date 与缺失 publishedAt 均被 normalize 丢弃", () => {
  const ctx = createContext({
    date: "2026-09-11",
    mode: { kind: "ai" },
    sources,
    log: new SilentLog(),
    startTime: NOW,
  });
  const r = normalize(
    [
      articleInput({ url: "invalid", publishedAt: new Date("not-a-date") }),
      articleInput({ url: "missing", publishedAt: undefined }),
      articleInput({ url: "ok" }),
    ] as unknown as Parameters<typeof normalize>[0],
    ctx,
  );
  assert.equal(r.dropped, 2, "Invalid Date 与缺失 publishedAt 均应被丢弃");
  assert.deepEqual(r.articles.map((a) => (a as { url: string }).url), ["ok"]);
});

// ————— 红线②：板块归属由内容判定，不读 category 字符串 —————

test("红线②：category=finance 且标题含「广州」→ gz_local", () => {
  const a = articleInput({
    category: "finance",
    title: "广州出台营商环境改革新举措",
    excerpt: "面向企业的惠企政策发布。",
  });
  assert.equal(assignSection(a), "gz_local");
});

test("红线②：category=tech 但标题纯金融词 → 不得进 tech（归 biz_insight/policy_market）", () => {
  const biz = articleInput({
    category: "tech",
    title: "银行信贷理财业务规模再创新高",
    excerpt: "财富管理需求旺盛。",
  });
  const s1 = assignSection(biz);
  assert.notEqual(s1, "tech", "不得因 category=tech 进入 tech 板块");
  assert.ok(s1 === "biz_insight" || s1 === "policy_market", `应归业务/政策板块，实际 ${s1}`);

  const policy = articleInput({
    category: "tech",
    title: "央行降准释放流动性支持实体经济",
    excerpt: "宏观政策动态。",
  });
  const s2 = assignSection(policy);
  assert.notEqual(s2, "tech");
  assert.equal(s2, "policy_market");
});

// ————— 红线③：ai 模式相关性回检确实丢弃 relevant=false 的无关条目 —————

test("红线③：与银行业务无关的 finance 条目（娱乐八卦）被回检丢弃", async () => {
  const gossip = articleInput({
    url: "https://example.com/gossip",
    title: "某明星离婚案庭审细节曝光",
    excerpt: "娱乐圈八卦新闻，与金融业务无关。",
  });
  const relevant = articleInput({
    url: "https://example.com/bank",
    title: "银行小微企业信贷投放创新高",
    excerpt: "普惠信贷政策带动投放增长。",
  });

  const ctx = createContext({
    date: "2026-09-11",
    mode: { kind: "ai" },
    sources,
    log: new SilentLog(),
    startTime: NOW,
  });
  const llm = new ScriptedLlm();
  llm.verdicts = [
    { url: "https://example.com/gossip", relevant: false },
    { url: "https://example.com/bank", relevant: true },
  ];

  const report = await enrich([gossip, relevant], ctx, { llm });

  const allTitles = Object.values(report.sections)
    .flat()
    .map((it) => it.title_cn)
    .join("|");
  assert.ok(!allTitles.includes("某明星离婚案庭审细节曝光"), "relevant=false 的无关条目应被丢弃");
  assert.ok(
    Object.values(report.sections).flat().some((it) => it.url === "https://example.com/bank"),
    "relevant=true 的相关条目应保留",
  );
  assert.equal(ctx.stats.recheckDropped, 1, "回检丢弃计数应为 1");
  assert.ok(ctx.stats.llmCalls && ctx.stats.llmCalls >= 1, "ai 模式应发生 LLM 调用");
});

test("红线③ 补充：LLM 幻觉 url（不在输入集合）不得误伤任何真实条目", async () => {
  const a = articleInput({ url: "https://example.com/real", title: "银行信贷政策落地" });
  const ctx = createContext({
    date: "2026-09-11",
    mode: { kind: "ai" },
    sources,
    log: new SilentLog(),
    startTime: NOW,
  });
  const llm = new ScriptedLlm();
  // 模型幻觉：只返回一条不存在的 url，且判 false
  llm.relevanceJson = JSON.stringify([{ url: "https://hallucinated.example/x", relevant: false }]);

  const report = await enrich([a], ctx, { llm });
  const total = Object.values(report.sections).flat().length;
  assert.equal(total, 1, "幻觉 url 不得导致真实条目被丢弃");
  assert.equal(ctx.stats.recheckDropped ?? 0, 0);
});

test("红线③ 补充：相关性回检解析失败时整批保留（宁误放不误杀）", async () => {
  const a = articleInput({ url: "https://example.com/real2", title: "财富管理客户活动" });
  const ctx = createContext({
    date: "2026-09-11",
    mode: { kind: "ai" },
    sources,
    log: new SilentLog(),
    startTime: NOW,
  });
  const llm = new ScriptedLlm();
  llm.relevanceJson = "这不是JSON{{{";

  const report = await enrich([a], ctx, { llm });
  const total = Object.values(report.sections).flat().length;
  assert.equal(total, 1, "解析失败批次应整批保留");
  assert.equal(ctx.stats.llmFailures, 1, "应计入失败观测");
});

/** 红线① e2e 用的最小 FakeLlm（与 helpers.FakeLlm 同协议，本地独立避免耦合）。 */
class FakeLlmForRedline {
  async complete(opts: { system?: string; prompt: string }): Promise<string> {
    const sys = opts.system ?? "";
    if (sys.includes("相关性")) {
      const urls = [...opts.prompt.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]);
      return JSON.stringify(urls.map((u) => ({ url: u, relevant: true })));
    }
    if (sys.includes("简报编辑")) {
      const items = [...opts.prompt.matchAll(/(\d+)\. 标题：/g)].map((m) => ({
        i: Number(m[1]),
        title_cn: "改写后的条目标题",
        summary: "改写后的摘要。",
        tags: ["标签"],
        importance: 2,
      }));
      return JSON.stringify(items);
    }
    return JSON.stringify({ hero_line: "定调", insights: [], must_read: [], risk: undefined });
  }
}
