/**
 * 主题跟踪 · 自有语料快照锁测（2026-10-19）。
 *
 * 为什么必须有它：`history/` 有保留周期（cleanup 设计 7 天），而主题跟踪是**长窗口趋势观察**。
 * 若语料跟着主项目归档被裁，主题就「越跟越短」—— 这是 sc 2026-10-19 明确要求
 * 「数据要单独保存下来」的原因。本测试锁住三条不变量：
 *  ① **永久保留**：任何天数门槛都不得裁剪旧期（与主项目 history/ 的本质区别）；
 *  ② **增量合并**：新日期并入、同日重跑以新数据为准、按 id 记**首见**（不被后来的覆盖）；
 *  ③ **损坏不阻断**：语料文件坏了按空语料处理（聚类仍能跑，只是历史薄）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyCorpus,
  mergeCorpus,
  corpusDays,
  corpusStats,
  repeatCountOf,
  bestVersionOf,
} from "../lib/services/topics/corpus";
import type { SlimDay, SlimItem } from "../lib/services/topics/slim";

const item = (over: Partial<SlimItem> & { t: string }): SlimItem => ({
  i: `itm-${over.t.slice(0, 8)}`,
  s: "源",
  d: "10/19",
  m: 2,
  k: "biz_insight",
  g: [],
  x: "",
  u: "",
  ...over,
});

const day = (date: string, items: SlimItem[]): SlimDay => ({ date, hero: "", items });

test("合并：新日期并入，旧日期**永不裁剪**（与 history/ 归档周期解耦）", () => {
  let c = emptyCorpus();
  // 100 天前的一期（在 history/ 里早已被 cleanup 删掉）
  c = mergeCorpus(c, [day("2026-07-01", [item({ i: "itm-old", t: "很久以前的一条" })])]);
  c = mergeCorpus(c, [day("2026-10-19", [item({ i: "itm-new", t: "今天的一条" })])]);
  assert.ok(c.days["2026-07-01"], "100 天前的期次必须保留（永久语料）");
  assert.ok(c.days["2026-10-19"]);
  assert.equal(corpusStats(c).days, 2);
});

test("合并：同日重跑以新数据为准；首见日期取更早（不被后来的覆盖）", () => {
  let c = emptyCorpus();
  c = mergeCorpus(c, [day("2026-10-18", [item({ i: "itm-x", t: "同一条新闻" })])]);
  // 同 id 次日再现 → 首见仍为 10-18
  c = mergeCorpus(c, [day("2026-10-19", [item({ i: "itm-x", t: "同一条新闻（标题被改写）" })])]);
  assert.equal(c.firstSeen["itm-x"], "2026-10-18", "首见日期必须是更早的 10-18");
  assert.equal(repeatCountOf(c, "itm-x"), 2, "跨 2 期");

  // 同日重跑：该日条目被替换（不累加旧条目）
  c = mergeCorpus(c, [day("2026-10-19", [item({ i: "itm-y", t: "修正后的一条" })])]);
  assert.equal(c.days["2026-10-19"].items.length, 1, "同日重跑以新数据为准");
  assert.equal(c.days["2026-10-19"].items[0].i, "itm-y");
});

test("合并：不 mutate 入参（纯函数）", () => {
  const base = mergeCorpus(emptyCorpus(), [day("2026-10-18", [item({ i: "itm-a", t: "甲" })])]);
  const snapshot = JSON.stringify(base);
  mergeCorpus(base, [day("2026-10-19", [item({ i: "itm-b", t: "乙" })])]);
  assert.equal(JSON.stringify(base), snapshot, "原语料对象不得被修改");
});

test("合并：空日期 / 缺 items 的坏数据被跳过而不炸", () => {
  const c = mergeCorpus(emptyCorpus(), [
    { date: "", hero: "", items: [] } as SlimDay,
    { date: "2026-10-19", hero: "", items: undefined as unknown as SlimItem[] } as SlimDay,
  ]);
  assert.deepEqual(Object.keys(c.days), ["2026-10-19"], "空日期跳过；缺 items 按空数组");
});

test("corpusDays：只给有条目的日期，且升序（聚类输入口径）", () => {
  const c = mergeCorpus(emptyCorpus(), [
    day("2026-10-19", [item({ t: "乙" })]),
    day("2026-10-17", [item({ t: "甲" })]),
    day("2026-10-18", []), // 空期不参与聚类
  ]);
  assert.deepEqual(corpusDays(c).map((d) => d.date), ["2026-10-17", "2026-10-19"]);
});

test("bestVersionOf：同 id 多版本取信息量最高者（标题被 AI 改写时的兜底）", () => {
  const c = mergeCorpus(emptyCorpus(), [
    day("2026-10-18", [item({ i: "itm-z", t: "短标题", x: "短" })]),
    day("2026-10-19", [item({ i: "itm-z", t: "更完整的标题（含来源与口径）", x: "这是一段更长的摘要，能说明问题" })]),
  ]);
  const best = bestVersionOf(c, "itm-z");
  assert.ok(best, "应取到版本");
  assert.equal(best.t, "更完整的标题（含来源与口径）", "应保留信息量更高的那版");
});

test("corpusStats：去重条目数与跨期条目数口径正确", () => {
  const c = mergeCorpus(emptyCorpus(), [
    day("2026-10-18", [item({ i: "itm-1", t: "甲" }), item({ i: "itm-2", t: "乙" })]),
    day("2026-10-19", [item({ i: "itm-2", t: "乙（改写）" }), item({ i: "itm-3", t: "丙" })]),
  ]);
  const st = corpusStats(c);
  assert.equal(st.days, 2);
  assert.equal(st.items, 3, "去重后 3 条（itm-2 跨期只算一条）");
  assert.equal(st.repeated, 1, "itm-2 跨 2 期 → 1 条重复");
  assert.match(st.span, /2026-10-18 ~ 2026-10-19/);
});
