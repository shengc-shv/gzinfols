/**
 * 经营领域专题页（WP10 · scripts/lib/domains-page.mjs）守护。
 *
 * ① 无索引 → 空态页（入口不 404），不假装有数据；
 * ② 领域 / 二级主题 / 条目三层结构齐全，计数与 chip 一致；
 * ③ 板块键必须显示中文（含语料里额外的落位键 must/insight/stock/risk），不漏英文；
 * ④ 未归二级主题的条目归「其他」且能被筛出来；
 * ⑤ 外部标题转义、无 url 不造空链接。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDomainsPage } from "../scripts/lib/domains-page.mjs";

const LATEST = "2026-11-28";

function idx(over: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    generatedAt: LATEST,
    windowRuns: 30,
    total: 3,
    classified: 3,
    domains: [
      {
        id: "wealth_aum",
        name: "财富管理与AUM",
        short: "财富管理",
        count: 2,
        subtopics: [{ name: "代销与中收", count: 1 }],
        segments: ["中高端客群", "私行客户"],
        products: ["理财", "基金"],
        eventTypes: [],
        items: [
          { id: "a", date: LATEST, title: "代销基金费率下调", url: "https://e.com/a", source: "证券时报", section: "biz_insight", subtopic: "代销与中收", itemDate: "11/28" },
          { id: "b", date: LATEST, title: "居民资产再配置", url: "", source: "今日必读", section: "must", subtopic: null, itemDate: "11/28" },
        ],
      },
      {
        id: "retail_credit",
        name: "零售信贷与住房金融",
        short: "零售信贷",
        count: 1,
        subtopics: [],
        segments: [],
        products: [],
        eventTypes: [],
        items: [
          { id: "c", date: LATEST, title: "<script>x</script> 房贷新政", url: "https://e.com/c", source: "广州日报", section: "gz_local", subtopic: null, itemDate: "11/28" },
        ],
      },
    ],
    ...over,
  };
}

test("① 无索引 → 空态页，返回按钮指向最新一期", () => {
  for (const input of [null, { domains: [] }]) {
    const html = renderDomainsPage({ index: input as never, generatedAt: LATEST, latest: LATEST });
    assert.ok(html.includes("还没有可归入经营领域的资讯"), "空态说明");
    assert.ok(html.includes("语料随每期日报累积"), "说清数据从哪来");
    assert.ok(html.includes(`href="./${LATEST}/${LATEST}.html"`), "返回最新一期");
  }
});

test("② 三层结构：领域 tab（含计数）/ 二级主题 chip（含其他）/ 条目", () => {
  const html = renderDomainsPage({ index: idx(), generatedAt: LATEST, latest: LATEST });
  assert.ok(html.includes("近 30 期 3 条中 3 条可归入领域"), "归类率说清口径");
  assert.ok(html.includes('data-filter-domain="wealth_aum"'), "领域筛选 chip");
  assert.ok(html.includes("财富管理<span class=\"c\">2</span>"), "chip 带计数");
  assert.ok(html.includes('data-filter-sub="代销与中收"'), "二级主题 chip");
  // 没有二级主题的条目 → 「其他」必须可筛（否则这批条目永远看不到）
  assert.ok(html.includes('data-filter-sub="其他"'), "其他 chip");
  assert.ok(html.includes('data-sub="其他"'), "未归类条目挂在其他");
  assert.ok(html.includes("常见客群：中高端客群 / 私行客户"), "客群提示来自配置");
  assert.ok(html.includes("相关产品：理财 / 基金"), "产品提示来自配置");
  // 空的领域不渲染区块（避免满页 0 条的空壳）
  assert.ok(!html.includes('id="d-channel_ai"'), "0 条领域不出区块");
});

test("③ 板块键显示中文：含语料额外落位键，未知键不泄漏英文", () => {
  const html = renderDomainsPage({
    index: idx({
      domains: [
        {
          id: "wealth_aum",
          name: "财富管理与AUM",
          short: "财富管理",
          count: 2,
          subtopics: [],
          items: [
            { id: "s1", date: LATEST, title: "甲", url: "https://e.com/1", source: "T1", section: "must", subtopic: null },
            { id: "s2", date: LATEST, title: "乙", url: "https://e.com/2", source: "T2", section: "mystery_key", subtopic: null },
          ],
        },
      ],
    }),
    generatedAt: LATEST,
    latest: LATEST,
  });
  assert.ok(html.includes("今日必读"), "must 键翻成中文");
  assert.ok(!html.includes("mystery_key"), "未知板块键不上页面（宁可少一个标签，也不把英文键漏出去）");
});

test("④ 来源与板块同名时不重复（今日必读 · 今日必读）", () => {
  const html = renderDomainsPage({
    index: idx({
      domains: [
        {
          id: "wealth_aum",
          name: "财富管理与AUM",
          short: "财富管理",
          count: 1,
          subtopics: [],
          items: [{ id: "d1", date: LATEST, title: "丙", url: "https://e.com/3", source: "今日必读", section: "must", subtopic: null, itemDate: "11/28" }],
        },
      ],
    }),
    generatedAt: LATEST,
    latest: LATEST,
  });
  const meta = html.match(/<p class="di-m">([\s\S]*?)<\/p>/)?.[1] ?? "";
  assert.equal((meta.match(/今日必读/g) ?? []).length, 1, "同一词只出现一次（来源与板块重名）");
  assert.ok(meta.includes("11/28"), "日期照常展示");
});

test("⑤ 标题转义、无 url 不造空链接", () => {
  const html = renderDomainsPage({ index: idx(), generatedAt: LATEST, latest: LATEST });
  assert.ok(!html.includes("<script>x</script>"), "标题转义");
  assert.ok(html.includes("&lt;script&gt;x&lt;/script&gt;"), "转义后的可见文本");
  assert.ok(!html.includes('href=""'), "无 url 不造空链接");
});
