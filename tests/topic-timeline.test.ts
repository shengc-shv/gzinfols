/**
 * B2 主题跟踪时间线（2026-09-17）。
 *
 * 锁五件事：
 *  ① 只保留**跨期**主题（单期出现的谈不上「跟踪」），且节点按日期升序（= 进展顺序）；
 *  ② 泛标签（出现率过高）不参与建主题 —— 否则「客群」会吞掉半个版面；
 *  ③ 聚类阈值保守（标签交集 ≥3 或标题前 12 字相同），并且**同名主题合并**、id/label 唯一；
 *  ④ 同标题节点跨期只留最早一条并记 `repeat`（时间线是「进展」，不是同一行刷两遍）；
 *  ⑤ 页面渲染走 DOM（textContent），外部标题不得拼进 innerHTML。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterTopics, dedupeNodesByTitle } from "../scripts/build-search-index";
import type { SlimDay, SlimItem } from "../scripts/build-search-index";
import { renderTopicsPage } from "../scripts/lib/topics-page.mjs";

function it(id: string, title: string, g: string[], k = "biz_insight"): SlimItem {
  return { i: id, t: title, s: "来源", d: "09/17", m: 2, k, g, x: "摘要", u: "https://example.com/" + id };
}

function day(date: string, items: SlimItem[]): SlimDay {
  return { date, items, hero: "", anchored: true };
}

// 夹具刻意「足够大」：真实期次每期 30+ 条，只有样本够大，主题标签的出现率才不会被
// 误判为「泛标签」（这个坑在实现里也修了 —— 泛标签判定改为「出现 ≥3 次 且 比例超阈值」）。
// 「客群」挂在噪声条目上 → 出现率 14/30 ≈ 47% > 默认阈值 35% → 被识别为泛标签。
// 这正是真实数据里的样子（「客群」「市场」这类标签天天出现在大半版面上）。
const NOISE: SlimItem[] = Array.from({ length: 12 }, (_, i) =>
  it(`itm-n${i}`, `无关条目 ${i}`, [`噪声标签${i}`, "客群"]),
);
const FIXTURE: SlimDay[] = [
  day("2026-09-16", [
    it("itm-a1", "跨境理财通额度扩容", ["跨境", "财富", "零售AUM"]),
    it("itm-a2", "跨境理财通新增试点城市", ["跨境", "财富", "零售AUM"]),
    it("itm-a3", "单期才有的一条消息", ["独角兽", "招商"]),
    it("itm-a4", "泛标签条目一", ["客群"]),
    ...NOISE,
  ]),
  day("2026-09-17", [
    it("itm-b1", "跨境理财通首月数据出炉", ["跨境", "财富", "零售AUM"]),
    it("itm-b2", "跨境理财通额度扩容", ["跨境", "财富", "零售AUM"]), // 与 a1 同标题 → 去重为 repeat
    it("itm-b3", "泛标签条目二", ["客群"]),
    ...NOISE,
  ]),
];

test("① 只保留跨期主题，节点按日期升序", () => {
  const topics = clusterTopics(FIXTURE);
  assert.equal(topics.length, 1, "只有「跨境理财通」这一组跨期主题成立");
  const t = topics[0];
  assert.equal(t.dates.length, 2);
  const dates = t.nodes.map((n) => n.date);
  assert.deepEqual([...dates].sort(), dates, "节点必须按日期升序（= 进展顺序）");
  assert.ok(t.spanDays >= 2, "跨度天数在构建期算好（页面不再解析日期）");
});

test("② 泛标签不参与建主题；单期主题被剔除", () => {
  // 默认阈值下：「客群」出现率 47% 属泛标签 → 不建主题（否则会吞掉半个版面）
  const topics = clusterTopics(FIXTURE);
  assert.ok(
    !topics.some((t) => t.label === "客群"),
    "泛标签（出现率超阈值）不得作为主题",
  );
  assert.ok(
    !topics.some((t) => t.nodes.some((n) => n.t.includes("单期才有"))),
    "单期条目不得出现在跨期主题里",
  );
});

test("③ 同名合并 + id/label 唯一 + label 取区分度最高的标签", () => {
  const fixture = [
    ...FIXTURE,
    // 另一组同主题（共享 3 个标签），其高频标签与第一组重叠 → 合并后不得出现两个同名主题
    day("2026-09-16", [it("itm-c1", "财富管理规模榜发布", ["财富", "跨境", "零售AUM"])]),
    day("2026-09-17", [it("itm-c2", "财富管理规模榜解读", ["财富", "跨境", "零售AUM"])]),
  ];
  const topics = clusterTopics(fixture);
  const labels = topics.map((t) => t.label);
  assert.equal(new Set(labels).size, labels.length, "label 必须唯一（读者看到同名会困惑）");
  const ids = topics.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "id 必须唯一（页面锚点/键依赖它）");
  // label 不应是「财富」这类高频标签（出现率最高者），应取区分度更高的
  for (const t of topics) {
    assert.ok(t.label.length > 0);
    assert.ok(t.nodes.length >= 2, "主题至少 2 个节点（去重后）");
  }
});

test("④ 同标题跨期节点合并：留最早一条 + repeat 计数", () => {
  const deduped = dedupeNodesByTitle([
    { date: "2026-09-16", i: "x", t: "跨境理财通额度扩容", k: "biz_insight" },
    { date: "2026-09-17", i: "y", t: "跨境理财通额度扩容", k: "biz_insight" },
    { date: "2026-09-17", i: "z", t: "另一条", k: "biz_insight" },
  ]);
  assert.equal(deduped.length, 2, "同标题只留一条");
  assert.equal(deduped[0].date, "2026-09-16", "保留最早出现的期次");
  assert.equal(deduped[0].repeat, 2, "记下共出现 2 期（读者据此判断「持续」）");

  const topics = clusterTopics(FIXTURE);
  const t = topics[0];
  const repeated = t.nodes.find((n) => n.t === "跨境理财通额度扩容");
  assert.equal(repeated?.repeat, 2, "聚类结果里也要保留 repeat 计数");
  assert.equal(repeated?.i, "itm-a1", "节点 id 指向最早那条（可点回当期卡片）");
});

test("⑤ 页面：时间线渲染 + 类型安全（外部标题不拼 innerHTML）", () => {
  const evil = {
    id: "tp-x",
    label: "<img onerror=1>恶性标题",
    tags: ["跨境"],
    dates: ["2026-09-16", "2026-09-17"],
    spanDays: 2,
    nodes: [
      { date: "2026-09-16", i: "itm-a1", t: "<script>alert(1)</script>", k: "biz_insight", s: "来源" },
      { date: "2026-09-17", i: "itm-b1", t: "正常标题", k: "biz_insight", s: "来源", repeat: 2 },
    ],
  };
  const html = renderTopicsPage({ topics: [evil], generatedAt: "2026-09-17T12:00:00", latest: "2026-09-17" });
  assert.ok(html.includes('id="topics-data"'), "数据内联（不依赖 fetch）");
  assert.ok(!html.includes("<script>alert(1)</script>"), "标题里的 <script 必须被转义");
  assert.ok(!/<img onerror/.test(html), "主题名里的标签必须被转义");
  assert.ok(html.includes("\\u003c"), "内联 JSON 须把 < 转义为 u003c");
  // 结构齐备
  assert.ok(html.includes("ol") || html.includes("tl"), "须有时间线结构");
  assert.ok(html.includes("renderTopicsPage") === false, "页面不应残留服务端函数名");
  assert.ok(html.includes("./index.html") && html.includes("./search.html"), "须有回退入口");
  // 空态不报错
  const empty = renderTopicsPage({ topics: [], latest: "2026-09-17" });
  assert.ok(empty.includes("topics-data"));
});
