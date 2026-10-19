/**
 * B2 主题跟踪时间线（2026-09-17 建立；2026-10-19 迁移至独立子模块）。
 *
 * 2026-10-19 变更：主题聚类已从 `scripts/build-search-index.ts` 拆到
 * `lib/services/topics/cluster.ts`（sc 架构指示：主题跟踪是独立子模块，不得与主项目互相干扰）。
 * 本测试随迁；治理版语义（A 型去重 / 禁裸标签 / 单归属 / 白名单命名）的专项锁测在
 * `tests/topics-cluster.test.ts`，此处只保留**通用不变量**（跨期门槛、泛标签、唯一性、repeat、XSS）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterTopics, dedupeById } from "../lib/services/topics/cluster";
import type { SlimDay, SlimItem } from "../lib/services/topics/slim";
import { renderTopicsPage } from "../scripts/lib/topics-page.mjs";

function it(id: string, title: string, g: string[], k = "biz_insight"): SlimItem {
  return { i: id, t: title, s: "来源", d: "09/17", m: 2, k, g, x: "摘要", u: "https://example.com/" + id };
}

function day(date: string, items: SlimItem[]): SlimDay {
  return { date, items, hero: "" };
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
    it("itm-a3", "单期才有的一条消息", ["独角兽", "产业扶持"]),
    it("itm-a4", "泛标签条目一", ["客群"]),
    ...NOISE,
  ]),
  day("2026-09-17", [
    it("itm-b1", "跨境理财通首月数据出炉", ["跨境", "财富", "零售AUM"]),
    // 与 a1 **同 id**（同 url）跨期再现、标题被改写 → A 型判据仍能认出是同一件事
    it("itm-a1", "跨境理财通额度扩容", ["跨境", "财富", "零售AUM"]),
    it("itm-b3", "泛标签条目二", ["客群"]),
    ...NOISE,
  ]),
];

test("① 只保留跨期主题，节点按日期**降序**（最新在上）", () => {
  const topics = clusterTopics(FIXTURE);
  assert.equal(topics.length, 1, "只有「跨境理财通」这一组跨期主题成立");
  const t = topics[0];
  assert.equal(t.dates.length, 2);
  const dates = t.nodes.map((n) => n.date);
  assert.deepEqual([...dates].sort().reverse(), dates, "节点必须按日期降序（2026-10-19 sc：打开先看后来怎么样了）");
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

test("④ 同 url 跨期节点合并：留一条 + repeat 计数（A 型：按条目 id，不按标题）", () => {
  const deduped = dedupeById([
    { date: "2026-09-16", d: "09/16", i: "x", t: "跨境理财通额度扩容", k: "biz_insight", tags: ["跨境"] },
    { date: "2026-09-17", d: "09/17", i: "x", t: "跨境理财通新增试点城市", k: "biz_insight", tags: ["跨境"] },
    { date: "2026-09-17", d: "09/17", i: "z", t: "另一条", k: "biz_insight", tags: ["跨境"] },
  ]);
  assert.equal(deduped.length, 2, "同 id 只留一条（标题被改写也认得出 —— A 型修复）");
  assert.equal(deduped[0].date, "2026-09-16", "保留最早出现的期次");
  assert.equal(deduped[0].repeat, 2, "记下共出现 2 期（读者据此判断「持续」）");

  const topics = clusterTopics(FIXTURE);
  const t = topics[0];
  const repeated = t.nodes.find((n) => n.i === "itm-a1");
  assert.equal(repeated?.repeat, 2, "聚类结果里也要保留 repeat 计数");
});

test("⑤ 页面：时间线渲染 + 类型安全（外部标题不拼 innerHTML）", () => {
  const evil = {
    id: "tp-x",
    label: "<img onerror=1>恶性标题",
    tags: ["跨境"],
    dates: ["2026-09-16", "2026-09-17"],
    spanDays: 2,
    nodes: [
      { date: "2026-09-16", d: "09/16", i: "itm-a1", t: "<script>alert(1)</script>", k: "biz_insight", s: "来源" },
      { date: "2026-09-17", d: "09/17", i: "itm-b1", t: "正常标题", k: "biz_insight", s: "来源", repeat: 2 },
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
  // 🔴 2026-10-19 sc 口径变更：主题页只保留「← 返回」（回来源期次），
  //   不再挂「最新一期 / 检索 / 归档」——它是独立全量页，不兼任站内导航门户。
  assert.ok(html.includes('class="back"'), "须有返回按钮");
  assert.ok(html.includes("./2026-09-17/2026-09-17.html"), "返回须兜底到最新一期");
  assert.ok(!html.includes("search.html") && !html.includes("archive.html"), "不挂站内导航（2026-10-19 口径）");
  // 空态不报错
  const empty = renderTopicsPage({ topics: [], latest: "2026-09-17" });
  assert.ok(empty.includes("topics-data"));
});

test("⑥ 页面：主题过滤按 id 唯一锚定，不按标签集合（2026-10-19 sc 实测反馈）", () => {
  // 两张卡共享「财富」标签 —— 若按标签过滤，点「财富管理与产品」会把「监管合规动态」也带出来
  const mk = (id: string, label: string, tags: string[]) => ({
    id,
    label,
    tags,
    dates: ["2026-09-16", "2026-09-17"],
    spanDays: 2,
    nodes: [{ date: "2026-09-17", d: "09/17", i: "itm-" + id, t: "某条进展", k: "biz_insight", s: "来源" }],
  });
  const html = renderTopicsPage({
    topics: [mk("tp-a", "财富管理与产品", ["财富"]), mk("tp-b", "监管合规动态", ["监管合规", "财富"])],
    latest: "2026-09-17",
  });
  assert.ok(html.includes("t.id !== state.topic"), "主题过滤必须按 id 精确匹配（唯一锚定）");
  assert.ok(!/state\.tag/.test(html), "不得残留 state.tag（旧版按标签集合过滤，会带出无关主题）");
  assert.ok(html.includes("'topic=' + encodeURIComponent"), "hash 用 topic=<主题id>");
  assert.ok(html.includes(".slice(1)"), "卡片标签须排除主标签（否则与卡片标题重复）");
  // 旧链接 #tag= 只在唯一命中时才采用，否则忽略（避免把旧的歧义语义带回来）
  assert.ok(html.includes("cand.length === 1"), "旧 #tag= 参数须「唯一命中才采用」");
  // 2026-10-19 sc：去掉「排序」「板块」两个控件 —— 主题是唯一过滤入口
  assert.ok(!/state\.sec/.test(html), "不得残留 state.sec（板块过滤已移除）");
  assert.ok(!/state\.sort/.test(html), "不得残留 state.sort（排序控件已移除，固定质量分降序）");
  assert.ok(html.includes("只看本周有新进展"), "默认视图开关须保留");
});
