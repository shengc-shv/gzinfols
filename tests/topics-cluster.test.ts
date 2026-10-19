/**
 * 主题跟踪 · 聚类治理锁测（2026-10-19）。
 *
 * 每条测试都对应一次**真实语料实测发现**（11~13 期 / 444~525 条）：
 *  ① A 型去重：9/118 节点重复，7 处是「正文卡 ↔ 商机洞察」同 url 双节点
 *     （LLM 两次改写标题，旧版按标题前 12 字去重必失效）→ 改按条目 id 去重；
 *  ② 禁裸标签：「市场」「客群」等机器标签实测成过主题名 → 白名单制；
 *  ③ 单标签主题（IPO 的「粤」）曾被 median 守卫误杀 130/134 条 → 入簇只看共享标签数；
 *  ④ B 型：TopicNode 漏传 MM/DD → 全部节点日期 undefined。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterTopics, TOPIC_LABELS, BANNED_TOPIC_LABELS } from "../lib/services/topics/cluster";
import type { SlimDay, SlimItem } from "../lib/services/topics/slim";
import { buildTopics, activeView } from "../lib/services/topics/assemble";

const item = (over: Partial<SlimItem> & { t: string }): SlimItem => ({
  i: `itm-${over.t.slice(0, 6)}`,
  s: "测试源",
  d: "10/19",
  m: 2,
  k: "biz_insight",
  g: [],
  x: "",
  u: "",
  ...over,
});

const day = (date: string, items: SlimItem[]): SlimDay => ({ date, hero: "", items });
/**
 * 噪声条目：小 fixture 里任何标签都会 100% 出现率 → 必然被判泛标签。
 * 加噪声把目标标签的出现率压到 35% 以下，才测得到聚类逻辑本身
 * （与 tests/topic-timeline.test.ts 同一手法）。
 */
const NOISE: SlimItem[] = Array.from({ length: 12 }, (_, i) =>
  ({ i: `itm-noise${i}`, t: `无关条目${i}`, s: "源", d: "10/19", m: 1, k: "biz_insight", g: [`噪声标签${i}`], x: "", u: "" }),
);

test("A 型去重：正文卡与商机洞察同 url（标题被 LLM 改写）→ 只保留一个节点", () => {
  // 同一 url 派生同 id；两条标题差异极大（模拟 LLM 两次改写）
  const days: SlimDay[] = [
    day("2026-10-14", [
      item({ i: "itm-x1", t: "抄底黄金ETF的人，被坑了？", k: "biz_insight", g: ["财富", "客群", "黄金", "零售AUM"], x: "摘要甲" }),
      item({ i: "itm-x2", t: "黄金ETF规模创新高", k: "biz_insight", g: ["财富", "零售AUM", "黄金"] }),
    ]),
    day("2026-10-15", [
      item({ i: "itm-x1", t: "黄金类产品客户浮亏风险", k: "insight", g: ["零售AUM", "财富", "黄金"], x: "摘要乙乙乙乙乙乙乙乙" }),
      item({ i: "itm-x3", t: "金价回调下的配置策略", k: "biz_insight", g: ["财富", "零售AUM", "黄金"] }),
      ...NOISE,
    ]),
  ];
  const topics = clusterTopics(days);
  const withX = topics.filter((t) => t.nodes.some((n) => n.i === "itm-x1"));
  assert.equal(withX.length, 1, `同 id 只能出现在一个主题里：${withX.map((t) => t.label).join("+")}`);
  const node = withX[0].nodes.find((n) => n.i === "itm-x1")!;
  assert.ok(node.repeat && node.repeat >= 2, "应记录跨期出现次数");
  assert.equal(node.t, "黄金类产品客户浮亏风险", "应保留信息量更高（摘要更长）的那一版标题");
});

test("A 型去重：同一主题内同 id 不重复计数（密度因子才可信）", () => {
  const days: SlimDay[] = [
    day("2026-10-14", [
      item({ i: "itm-a", t: "某监管新规出台", g: ["监管合规"] }),
      item({ i: "itm-a2", t: "配套细则征求意见", g: ["监管合规"] }),
    ]),
    day("2026-10-15", [item({ i: "itm-a", t: "监管新规细则落地", g: ["监管合规"] })]),
    day("2026-10-16", [
      item({ i: "itm-a", t: "新规实施首周观察", g: ["监管合规"] }),
      ...NOISE,
    ]),
  ];
  const topics = clusterTopics(days);
  const t = topics.find((x) => x.label === "监管合规动态");
  assert.ok(t, "应产出监管合规主题");
  assert.equal(t!.nodes.filter((n) => n.i === "itm-a").length, 1, "同 id 只能有一个节点");
});

test("禁裸标签：「市场」「客群」等机器标签不得成为主题名", () => {
  const days: SlimDay[] = [
    day("2026-10-14", [item({ t: "A股收评", g: ["市场", "客群"] })]),
    day("2026-10-15", [item({ t: "港股收评", g: ["市场", "客群"] })]),
    day("2026-10-16", [item({ t: "美股收评", g: ["市场", "客群"] })]),
  ];
  const topics = clusterTopics(days);
  assert.deepEqual(topics, [], "只有被禁标签的条目不得产出任何主题（宁缺毋滥）");
  // 白名单与禁名单互斥（防呆）
  for (const b of BANNED_TOPIC_LABELS) {
    assert.equal(TOPIC_LABELS[b], undefined, `禁名单标签「${b}」不应出现在主题名白名单里`);
  }
});

test("地域/板块标签不得作为主题名：「粤」不得成主题（sc 2026-10-19 指出）", () => {
  // 只有地域标签的条目 → 无业务标签 → 不成主题（宁缺毋滥）
  const days: SlimDay[] = [
    day("2026-10-14", [
      item({ i: "itm-i1", t: "甲公司：IPO问询中（拟创业板）", k: "ipo", g: ["粤"] }),
      item({ i: "itm-i2", t: "乙公司：IPO注册生效", k: "ipo", g: ["粤"] }),
      ...NOISE,
    ]),
    day("2026-10-15", [item({ i: "itm-i3", t: "丙公司 (辅导备案) [广东证监局]", k: "ipo", g: ["粤"] })]),
  ];
  const topics = clusterTopics(days);
  const labels = topics.map((t) => t.label);
  assert.ok(!labels.includes("广东IPO动态"), `「粤」是地域/板块标签，不得作为主题名：${labels.join("/")}`);
  assert.ok(labels.every((l) => l !== "粤"), "不得出现裸地域标签主题名");
  // 白名单本身也不得含地域/板块标签
  assert.equal(TOPIC_LABELS["粤"], undefined, "TOPIC_LABELS 不得包含「粤」（板块冒充主题）");
});

test("IPO 条目带业务标签时，按业务主题归入（不是被丢弃）", () => {
  // 带「科技金融」的 IPO 条目 → 应进入「科技金融」主题，与同标签的业务条目同簇
  const days: SlimDay[] = [
    day("2026-10-14", [
      item({ i: "itm-k1", t: "某芯片公司IPO辅导备案", k: "ipo", g: ["粤", "科技金融"] }),
      item({ i: "itm-k2", t: "科技型企业贷款贴息新政", k: "policy_market", g: ["科技金融"] }),
      ...NOISE,
    ]),
    day("2026-10-15", [
      item({ i: "itm-k3", t: "某芯片公司问询回复", k: "ipo", g: ["粤", "科技金融"] }),
      item({ i: "itm-k4", t: "科技金融专营机构扩容", k: "policy_market", g: ["科技金融"] }),
    ]),
  ];
  const topics = clusterTopics(days);
  const t = topics.find((x) => x.label === "科技金融");
  assert.ok(t, `带业务标签的 IPO 条目应归入业务主题：${topics.map((x) => x.label).join("/")}`);
  assert.ok(
    t!.nodes.some((n) => n.k === "ipo"),
    "IPO 条目应作为节点出现在业务主题里（IPO 是板块不是主题，但它的内容属于业务脉络）",
  );
});

test("B 型：TopicNode 必须带 MM/DD（旧版漏传致全部节点日期 undefined）", () => {
  const days: SlimDay[] = [
    day("2026-10-14", [item({ t: "房贷利率下调", d: "10/14", g: ["住房金融"] })]),
    day("2026-10-15", [item({ t: "贴息细则落地", d: "10/15", g: ["住房金融"] })]),
  ];
  const topics = clusterTopics(days);
  const nodes = topics.flatMap((t) => t.nodes);
  assert.ok(nodes.length > 0, "应有主题产出");
  for (const n of nodes) {
    assert.ok(n.d && /^\d{2}\/\d{2}$/.test(n.d), `节点必须带 MM/DD，实际 ${JSON.stringify(n.d)}`);
  }
});

test("节点默认不截断（2026-10-19 sc：数据全量，折叠交给渲染层）；maxNodes 仍可显式收口", () => {
  const items: SlimItem[] = [];
  for (let i = 0; i < 30; i++) {
    items.push(item({ i: `itm-cap${i}`, t: `房贷进展${i}`, g: ["住房金融"], k: "biz_insight" }));
  }
  const days: SlimDay[] = [day("2026-10-14", items.slice(0, 15)), day("2026-10-15", items.slice(15))];
  // 旧口径默认截 12，会把时间线中段整段砍掉（房贷主题 9-18~10-12 曾因此消失）
  assert.equal(clusterTopics(days)[0].nodes.length, 30, "默认保留全部节点");
  assert.equal(clusterTopics(days, { maxNodes: 20 })[0].nodes.length, 20, "显式 maxNodes 仍生效（保首尾）");
});

test("质量分：大主题不得被小主题靠「连续性饱和」反超（实测信用卡 3 节点曾拿 99 分第一）", () => {
  const days: SlimDay[] = [
    day("2026-10-15", [
      item({ i: "itm-b1", t: "信用卡盗刷案通报", g: ["信用卡"] }),
      item({ i: "itm-b2", t: "信用卡分期新规", g: ["信用卡"] }),
    ]),
    day("2026-10-16", [item({ i: "itm-b3", t: "信用卡权益调整", g: ["信用卡"] })]),
    // 同期：一个跟了 8 期的大主题
    ...Array.from({ length: 6 }, (_, i) =>
      day(`2026-10-${String(10 + i).padStart(2, "0")}`, [
        item({ i: `itm-c${i}`, t: `房贷政策进展${i}`, g: ["住房金融"] }),
      ]),
    ),
  ];
  const topics = buildTopics(days, "2026-10-19");
  const cc = topics.find((t) => t.label === "信用卡业务")!;
  const house = topics.find((t) => t.label === "房贷与住房金融")!;
  assert.ok(house.q > cc.q, `大主题分数应更高：房贷 ${house.q} vs 信用卡 ${cc.q}`);
});

test("默认视图：只含本周有进展且未沉底的主题", () => {
  const days: SlimDay[] = [
    day("2026-09-01", [item({ t: "很久以前的事", g: ["养老"] })]),
    day("2026-09-02", [item({ t: "更久以前的事", g: ["养老"] })]),
    day("2026-10-18", [item({ t: "本周新进展", g: ["住房金融"] })]),
    day("2026-10-19", [item({ t: "本周另一进展", g: ["住房金融"] })]),
  ];
  const topics = buildTopics(days, "2026-10-19");
  const act = activeView(topics);
  assert.ok(act.every((t) => t.active && !t.dormant), "默认视图不得含沉底主题");
  assert.ok(act.some((t) => t.label === "房贷与住房金融"), "本周有进展的主题应在默认视图");
  assert.ok(!act.some((t) => t.label === "养老金融"), "90 天无进展的「养老」应被排除");
});

test("minDates 门槛：只跨 1 期的「主题」不得输出", () => {
  const days: SlimDay[] = [day("2026-10-14", [item({ t: "单期事件甲", g: ["消费贷"] })])];
  assert.deepEqual(clusterTopics(days), [], "单期不得成主题");
});

test("空语料 / 空条目不炸", () => {
  assert.deepEqual(clusterTopics([]), []);
  assert.deepEqual(clusterTopics([day("2026-10-14", [])]), []);
});

test("节点数门槛：一条新闻跨多期（同 id）不算主题 —— 那是重复报道，不是跟踪", () => {
  const days: SlimDay[] = [
    day("2026-10-14", [item({ i: "itm-only", t: "同一条新闻", g: ["住房金融"] })]),
    day("2026-10-15", [item({ i: "itm-only", t: "同一条新闻（改写）", g: ["住房金融"] })]),
    day("2026-10-16", [item({ i: "itm-only", t: "同一条新闻（再改写）", g: ["住房金融"] })]),
  ];
  const topics = clusterTopics(days);
  assert.ok(
    !topics.some((t) => t.label === "房贷与住房金融"),
    `单条新闻跨 3 期不应成为主题（读者看时间线会看到同一件事刷三遍）：${JSON.stringify(topics.map((t) => t.label))}`,
  );
});

test("节点截断：超容量时**保留首尾**（不得把最新进展全砍掉）", () => {
  const items: SlimItem[] = [];
  for (let i = 0; i < 20; i++) {
    items.push(
      item({
        i: `itm-n${String(i).padStart(2, "0")}`,
        t: `房贷进展第${i}条`,
        g: ["住房金融"],
        d: `10/${String(i + 1).padStart(2, "0")}`,
      }),
    );
  }
  // 每天 2 条，跨 10 天
  const days: SlimDay[] = [];
  for (let d = 0; d < 10; d++) {
    days.push(day(`2026-10-${String(10 + d).padStart(2, "0")}`, items.slice(d * 2, d * 2 + 2)));
  }
  const topics = clusterTopics(days, { maxNodes: 6 });
  const t = topics.find((x) => x.label === "房贷与住房金融")!;
  assert.equal(t.nodes.length, 6, "应按 maxNodes=6 截断");
  const dates = t.nodes.map((n) => n.date);
  // 输出为**降序**（2026-10-19 sc：「主题里面倒序好一点」—— 打开就想看后来怎么样了）
  assert.equal(dates[0], "2026-10-19", "最新进展必须在最上");
  assert.equal(dates[dates.length - 1], "2026-10-10", "最早（起点）必须在末尾 —— 截断不能丢起点");
});

// ---------------------------------------------------------------------------
// 主题身份 / 相关标签（2026-10-19 sc 实测反馈）
//   「我点击主题的时候，不能唯一锚定，比如我选了财富，但监管合规也出来了。」
// 根因两层：
//   ① 页面过滤走的是 t.tags（每张卡的相关标签集合）—— 标签跨主题共享，点一个带出一堆；
//   ② chips 又是按**全局最高频**选的，把「财富」(22%)「信贷」(10%) 硬塞进 9/12 个主题。
// ---------------------------------------------------------------------------

/** 两个业务组：房贷 6 条 / 监管合规 6 条，各有一半条目被采集层打了「财富」标签（模拟真实泛滥）。 */
function floodFixture(): SlimDay[] {
  const hf = Array.from({ length: 6 }, (_, i) =>
    item({ i: `itm-hf${i}`, t: `房贷进展${i}`, g: ["住房金融", "财富"] }),
  );
  const rc = Array.from({ length: 6 }, (_, i) =>
    item({ i: `itm-rc${i}`, t: `监管新规${i}`, g: ["监管合规", "财富"] }),
  );
  return [
    day("2026-10-14", [...hf.slice(0, 3), ...rc.slice(0, 3), ...NOISE]),
    day("2026-10-15", [...hf.slice(3), ...rc.slice(3)]),
  ];
}

test("主题 id：只由主标签派生 → 语料增删后同一主题 id 不变（hash 锚点才可收藏/分享）", () => {
  const base = floodFixture();
  const a = clusterTopics(base);
  // 同主题再加一天新节点（每天语料都会变，首节点必然变）
  const grown = base.concat([
    day("2026-10-16", [
      item({ i: "itm-hf9", t: "房贷新进展", g: ["住房金融", "财富"] }),
      item({ i: "itm-rc9", t: "监管新进展", g: ["监管合规", "财富"] }),
    ]),
  ]);
  const b = clusterTopics(grown);
  const idOf = (ts: typeof a, label: string) => ts.find((t) => t.label === label)?.id;
  assert.ok(idOf(a, "房贷与住房金融"), "基线应有房贷主题");
  assert.equal(
    idOf(a, "房贷与住房金融"),
    idOf(b, "房贷与住房金融"),
    "语料增长后 id 必须不变（曾拼入首节点 id → 每天漂移，旧链接失效）",
  );
  // 顺序无关
  const c = clusterTopics([...base].reverse());
  assert.equal(idOf(a, "监管合规动态"), idOf(c, "监管合规动态"), "id 不得依赖语料顺序");
  // id 唯一（页面过滤靠它精确锚定）
  const ids = a.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "主题 id 必须唯一");
});

test("相关标签：泛滥词（全局占比 ≥15%）不得出现在任何主题的 chips 里", () => {
  const topics = clusterTopics(floodFixture());
  const labels = topics.map((t) => t.label);
  assert.ok(labels.includes("房贷与住房金融"), `应有房贷主题：${labels.join("/")}`);
  assert.ok(labels.includes("监管合规动态"), `应有监管合规主题：${labels.join("/")}`);
  // 「财富」覆盖 12/24 = 50%，对「这个主题还涉及什么」没有描述力 → 一律不进 chips
  for (const t of topics) {
    assert.ok(
      !(t.tags || []).includes("财富"),
      `「${t.label}」的相关标签不得含泛滥词「财富」：${JSON.stringify(t.tags)}`,
    );
  }
});

test("主题卡标签：主标签固定在首位（页面靠 slice(1) 区分「相关标签」，不重复渲染标题）", () => {
  for (const t of clusterTopics(floodFixture())) {
    assert.ok((t.tags || []).length >= 1, `「${t.label}」至少要带主标签`);
  }
});

test("主题内时间线：一律**降序**（最新在最上），且首尾都不能丢", () => {
  const topics = clusterTopics(floodFixture());
  assert.ok(topics.length > 0, "fixture 应产出主题");
  for (const t of topics) {
    const ds = t.nodes.map((n) => n.date);
    assert.ok(
      ds.every((d, i) => i === 0 || ds[i - 1] >= d),
      `「${t.label}」节点必须按日期降序（最新在上）：${ds.join(",")}`,
    );
  }
});
