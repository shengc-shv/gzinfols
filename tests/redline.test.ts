/**
 * 红线回归测试（三条业务红线）。
 *
 * 红线①：无真实 publishedAt 一律丢弃，绝不用抓取时间兜底（normalize 唯一裁决点）。
 * 红线②：板块归属由内容判定（gzinfo categoryToSection：内容判定 + tech/ipo 栏目例外）。
 * 红线③：业务相关性——PASS1 keep=false 丢弃无关条目（gzinfo 保留标准 1-4 条，
 *        由 scripted runner 模拟 AI 判定；2.0 早期自创回检已退役，由 PASS1 承担）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { setPersistenceBaseDir } from "../lib/adapters/persistence";
import { runPipeline } from "../lib/pipeline";
import { createContext } from "../lib/orchestrator";
import { generateDaily } from "../lib/services/enrich/pipeline";
import { extractJson } from "../lib/services/enrich/json-util";
import { toPass1Input } from "../lib/services/enrich/pass1-input";
import type { LlmRunner } from "../lib/services/enrich/pass1";
import { normalize } from "../lib/services/normalize";
import type { PipelineDeps, LlmPort } from "../lib/contracts/pipeline";
import type { SourceDef } from "../lib/contracts/source";
import type { ArticleInput } from "../lib/contracts/article";
import { MemFs, FakeHttp, FakeClock, SilentLog, FakeLlm } from "./helpers";

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

  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "gzinfols-redline-"));
  setPersistenceBaseDir(tmp);
  const fs = new MemFs();
  fs.setJson("sources.config.json", { sources });
  fs.setJson("sources.keywords.json", KEYWORDS);
  const deps: PipelineDeps = {
    fs,
    clock: new FakeClock(),
    llm: new FakeLlm(),
    http: new FakeHttp(rss),
  };
  const ctx = createContext({
    date: "2026-09-11",
    mode: { kind: "ai" },
    sources,
    log: new SilentLog(),
    startTime: NOW,
  });

  let out;
  try {
    out = await runPipeline(ctx, deps);
  } finally {
    setPersistenceBaseDir(undefined);
  }

  const allTitles = Object.values(out.report.sections)
    .flat()
    .map((it) => it.title_cn)
    .join("|");
  assert.ok(!allTitles.includes("无时间戳的神秘条目"), "无发布时间条目不得进任何板块");
  assert.ok(!out.html.includes("无时间戳的神秘条目"), "无发布时间条目不得进 HTML");
  assert.ok(!out.markdown.includes("无时间戳的神秘条目"), "无发布时间条目不得进 Markdown");
  const histPath = path.join(tmp, "data", "article-history.json");
  const hist = JSON.parse(fsSync.readFileSync(histPath, "utf8")) as Record<string, { url: string }>;
  assert.ok(
    Object.values(hist).every((it) => it.url !== "https://example.com/no-date"),
    "无发布时间条目不得进历史库",
  );
  // 对照组：有效条目正常上榜（板块或必读——gzinfo 跨层级去重语义：
  // 必读涵盖的事件会从资讯板块收编，故两个位置命中其一即为「上榜」）
  const inSections = Object.values(out.report.sections)
    .flat()
    .some((it) => it.url === "https://example.com/valid");
  const inMustRead = out.report.must_read.some((m) => m.url === "https://example.com/valid");
  assert.ok(
    inSections || inMustRead,
    "有效条目应上榜（板块或必读其一）",
  );
  fsSync.rmSync(tmp, { recursive: true, force: true });
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

// ————— 红线②：板块归属由内容判定（tests/assignSection.test.ts 详细覆盖）—————

// ————— 红线③：PASS1 keep=false 丢弃无关条目（gzinfo 保留标准语义）—————

/** 构造 scripted runner：PASS1 按 url→keep 决定保留；PASS2 回显成稿。 */
function scriptedRunner(keepMap: Map<string, boolean>): LlmRunner {
  return async (system, user) => {
    const slice = (p: string) => {
      try {
        const parsed = JSON.parse(extractJson(p));
        return Array.isArray(parsed) ? parsed : (parsed?.items ?? []);
      } catch {
        return [];
      }
    };
    if (system.includes("资讯筛选编辑")) {
      const arr = slice(user) as Array<{ url: string; title: string; category?: string }>;
      return JSON.stringify({
        items: arr.map((it) => ({
          url: it.url,
          keep: keepMap.get(it.url) ?? true,
          section: "biz_insight",
          source_type: "media",
          locale: "national",
          locale_evidence: "",
          tags: ["市场"],
          title_cn: it.title,
          title_orig: "",
          importance_candidate: 2,
        })),
      });
    }
    // PASS2：回显
    const arr = slice(user) as Array<{
      url: string; title_cn: string; source: string; source_type: string; date: string;
      tags: string[]; locale: string; locale_evidence?: string; section: string; raw_text?: string;
    }>;
    const sections: Record<string, unknown[]> = { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] };
    for (const it of arr) {
      (sections[it.section] ?? sections.biz_insight).push({
        url: it.url,
        title_cn: it.title_cn,
        title_orig: "",
        source: it.source,
        source_type: it.source_type,
        date: it.date,
        summary: "信贷投放数据更新，关注客群影响。",
        importance: 2,
        tags: it.tags ?? [],
        locale: it.locale,
        locale_evidence: it.locale_evidence ?? "",
      });
    }
    return JSON.stringify({
      hero_line: "今日关注：信贷与财富条线动态，详见各板块提示。",
      must_read: [],
      insights: [],
      sections,
    });
  };
}

test("红线③：与银行业务无关的条目（娱乐八卦）PASS1 keep=false 被丢弃", async () => {
  const gossipUrl = "https://example.com/gossip";
  const bankUrl = "https://example.com/bank";
  const inputs = [
    toPass1Input(articleInput({ url: gossipUrl, title: "某明星离婚案庭审细节曝光", excerpt: "娱乐圈八卦新闻。" })),
    toPass1Input(articleInput({ url: bankUrl, title: "银行小微企业信贷投放创新高", excerpt: "普惠信贷政策带动投放增长。" })),
  ];
  const runner = scriptedRunner(
    new Map([
      [gossipUrl, false],
      [bankUrl, true],
    ]),
  );
  const report = await generateDaily(inputs, "2026-09-11", { runner });
  const allTitles = Object.values(report.sections)
    .flat()
    .map((it) => it.title_cn)
    .join("|");
  assert.ok(!allTitles.includes("某明星离婚案庭审细节曝光"), "keep=false 的无关条目应被丢弃");
  assert.ok(
    Object.values(report.sections).flat().some((it) => it.url === bankUrl),
    "keep=true 的相关条目应保留",
  );
});

test("红线③ 补充：PASS1 整批丢弃 → 合法空报告（不抛异常，gzinfo 同款）", async () => {
  const inputs = [toPass1Input(articleInput({ url: "u1", title: "无关条目一" }))];
  const runner = scriptedRunner(new Map([["u1", false]]));
  const report = await generateDaily(inputs, "2026-09-11", { runner });
  assert.equal(report.hero_line, "今日暂无可推送重点，详见各板块资讯。", "gzinfo HERO_FALLBACK");
  assert.equal(Object.values(report.sections).flat().length, 0);
});
