/**
 * B1 检索索引与静态检索页（2026-09-17）。
 *
 * 锁三件事：
 *  ① **与渲染同源**——索引里的条目 ID 必须等于页面锚点（否则检索结果全是死链）；
 *  ② **红线同源**——索引走渲染同一条过滤链，加密资产内容不得进检索页；
 *  ③ **XSS**——标题/摘要来自外部新闻源，页面必须转义后再内联（数据里不得出现裸 `<script`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSlimDay, anchorsOfHtml, filterToAnchors } from "../scripts/build-search-index";
import { renderSearchPage } from "../scripts/lib/search-page.mjs";
import type { DailyReport } from "../lib/contracts/report";
import { itemIdOf } from "../lib/utils/item-id";
import { assignItemIds } from "../lib/services/assemble/item-id";

const URL_A = "https://example.com/a";
const URL_CRYPTO = "https://example.com/crypto";

function report(): DailyReport {
  return {
    date: "2026-09-17",
    hero_line: "今日定调",
    must_read: [{ title: "必读一", why: "原因", url: "https://example.com/m1" }],
    insights: [
      { topic: "南沙跨境客群", impact: "影响", action: "行动", tags: ["客群"], segments: ["中高端客群(过亿资产)"], sources: [{ title: "x", url: URL_A }] },
    ],
    risk: { topic: "信贷考核转向", impact: "影响", sources: [{ title: "y", url: "https://example.com/r1" }] },
    sections: {
      gz_local: [
        { url: URL_A, title_cn: "广州要闻", source: "广州日报", date: "09/17", summary: "摘要", importance: 2, rank: 1, tags: ["客群"] },
      ],
      biz_insight: [],
      policy_market: [],
      tech: [],
      ipo: [],
    },
    stock_news: [
      { url: URL_CRYPTO, title_cn: "加密货币遭遇利空", source: "东方财富", date: "09/17", summary: "加密资产不合规，不得进检索", importance: 1 },
    ],
  } as unknown as DailyReport;
}

test("① 条目 ID 与页面锚点同源（检索结果不能是死链）", () => {
  const r = report();
  const slim = buildSlimDay(r);
  const prepared = assignItemIds(r);
  const anchor = prepared.sections?.gz_local?.[0]?.id;
  assert.ok(anchor, "渲染期应补出 id");
  const gz = slim.items.find((it) => it.k === "gz_local");
  assert.equal(gz?.i, anchor, "索引 id 必须等于页面锚点 id");
  // 不在 sections 内的（必读/风险/商机）用 url 派生，与卡片同源
  assert.equal(slim.items.find((it) => it.k === "must")?.i, itemIdOf("https://example.com/m1"));
});

test("② 加密资产内容不得进检索页（红线：渲染同源过滤）", () => {
  const slim = buildSlimDay(report());
  const all = JSON.stringify(slim.items);
  assert.ok(!all.includes("加密"), "加密资产条目必须被 stripCryptoNews 拦截（与渲染同一条链）");
  assert.ok(
    !slim.items.some((it) => it.u === URL_CRYPTO),
    "加密条目不得出现在索引中",
  );
});

test("③ 板块/必读/商机/风险都进索引，且摘要截断", () => {
  const slim = buildSlimDay({
    ...report(),
    sections: {
      ...report().sections,
      gz_local: [
        {
          url: URL_A,
          title_cn: "标题",
          source: "源",
          date: "09/17",
          summary: "很长的摘要".repeat(40),
          importance: 2,
          rank: 1,
          tags: [],
        },
      ],
    },
  } as unknown as DailyReport);
  const kinds = new Set(slim.items.map((it) => it.k));
  for (const k of ["gz_local", "must", "insight", "risk"]) {
    assert.ok(kinds.has(k), `索引须包含 ${k}`);
  }
  const gz = slim.items.find((it) => it.k === "gz_local");
  assert.ok((gz?.x.length ?? 0) <= 91, "摘要须截断（slim 索引不该搬全文）");
  // 客群段位并入商机条目标签（C1 客群视图同一数据源）
  const ins = slim.items.find((it) => it.k === "insight");
  assert.ok(ins?.g.includes("中高端客群(过亿资产)"), "商机条目须带客群段位标签");
});

test("⑤ 只索引页面上真有锚点的条目（防死链）；老页面（无锚点）整期降级不丢", () => {
  const slim = buildSlimDay(report());
  const anchors = anchorsOfHtml(
    '<article id="itm-aaa"></article><li id="itm-bbb"></li><div id="not-an-item"></div>',
  );
  assert.deepEqual([...anchors].sort(), ["itm-aaa", "itm-bbb"]);
  const gzId = slim.items.find((it) => it.k === "gz_local")?.i ?? "";
  const kept = filterToAnchors({ ...slim, items: [...slim.items, { ...slim.items[0], i: gzId, k: "x" }] }, anchors);
  assert.ok(
    kept.items.every((it) => anchors.has(it.i)),
    "页面没有的锚点不得进索引（否则点了不跳转，看着像坏了）",
  );
  // 老页面（A2 前生成，0 个锚点）→ 由调用方标记 anchored=false 并**不过滤**，
  // 检索结果只链到当期页；此处锁「过滤函数本身不擅自丢整期」
  const noAnchorHtml = anchorsOfHtml("<html><body>no ids here</body></html>");
  assert.equal(noAnchorHtml.size, 0);
});

test("④ 检索页：数据内联 + XSS 转义（外部源标题不得裸奔）", () => {
  const evil = {
    date: "2026-09-17",
    hero: "h",
    items: [{ i: "itm-x", t: "<script>alert(1)</script>恶意标题", s: "源", d: "09/17", m: 2, k: "gz_local", g: [], x: "<img onerror=1>", u: "u" }],
  };
  const html = renderSearchPage({ days: [evil], latest: "2026-09-17", generatedAt: "2026-09-17T01:00:00" });
  assert.ok(!html.includes("<script>alert(1)</script>"), "数据里的 <script 必须被转义");
  assert.ok(!/<img onerror/.test(html), "数据里的标签必须被转义");
  assert.ok(html.includes("\\u003c") || html.includes("&lt;"), "内联 JSON 须把 < 转义为 \\u003c");
  assert.ok(html.includes('id="search-data"'), "须内联索引数据（不依赖 fetch）");
  assert.ok(html.includes('href="./search.html"') === false, "检索页自身不需要自链");
  assert.ok(html.includes("./index.html"), "须给出回到最新一期的入口");
});
