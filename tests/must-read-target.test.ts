/**
 * 今日必读「基础 3 / 上限 5 + 扩展质量门槛」（2026-11-28 sc 拍板）。
 *
 * 锁住四件事：
 *  ① 前 3 条只过事件判重，不过扩展门槛（低质量也不能把基本盘掏空）；
 *  ② 第 4/5 条必须由 extensionGate 放行，否则跳过并顺延看后面的候补；
 *  ③ 候补用尽按实际剩余，不为凑满 5 条降标准；
 *  ④ 不传 baseTarget / extensionGate 时行为与旧版一致（商机路径零回归）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickUntilTarget } from "../lib/services/memory/exec-guard";
import { beginDay, emptyMemory } from "../lib/services/memory/event-memory";
import {
  MUST_READ_BASE_TARGET,
  MUST_READ_PLAY_TARGET,
  mustReadTargetFor,
} from "../lib/services/memory/event-types";
import type { EventMemoryStore, MemoryCandidate } from "../lib/services/memory/event-memory";
import { syncNarration } from "../lib/pipeline/side-outputs/side-exec-summary";
import type { ExecutiveSummary } from "../lib/services/enrich/executive-summary";

const TODAY = "2026-11-28";
const TEXT: Record<string, string> = {
  A1: "广州首单净土贷落地，土壤治理类绿色信贷路径打通，本地环保与城投类客户融资需求显现。",
  A2: "上海首批跨境资金集中运营新政落地，大湾区跨境客群资金管理便利化需求上升。",
  A3: "民生银行同日获批收购两家村镇银行，区域内存量网点与客群迁移机会显现。",
  A4: "住房公积金提取场景扩容，装修与物业费均可提取，住房金融联动空间打开。",
  A5: "央行公开市场操作放量，银行间流动性总量保持合理充裕，利率中枢保持稳定。",
  A6: "证监会优化IPO现场检查流程，发行审核节奏与市场预期出现边际变化。",
};
interface Item {
  title: string;
  /** 是否通过第 4/5 条的额外质量门槛（真实路径是 must_read 档 + 宏观分 + 来源 URL）。 */
  ext: boolean;
}
const toCandidate = (it: Item): MemoryCandidate => ({ title: it.title, text: TEXT[it.title] ?? it.title });
const items = (flags: boolean[]): Item[] =>
  flags.map((ext, i) => ({ title: `A${i + 1}`, ext }));
function pick(list: Item[], store: EventMemoryStore = beginDay(emptyMemory(), TODAY), useGate = true) {
  return pickUntilTarget({
    items: list,
    toCandidate,
    section: "must_read",
    today: TODAY,
    broadcastAt: `${TODAY}T08:00:00+08:00`,
    baseTarget: MUST_READ_BASE_TARGET,
    target: MUST_READ_PLAY_TARGET,
    ...(useGate ? { extensionGate: (it: Item) => it.ext } : {}),
    store,
  });
}

test("① 基础 3 条不受扩展门槛约束，前 3 条即使标记为不合格也要入选", () => {
  const r = pick(items([false, false, false, false, false, false]));
  assert.equal(r.chosen.length, MUST_READ_BASE_TARGET);
  assert.deepEqual(r.chosen.map((c) => c.item.title), ["A1", "A2", "A3"]);
  assert.equal(r.gateRejected, 3, "后 3 条被扩展门槛拦下，与判重跳过分开记账");
  assert.equal(r.skipped.length, 3);
});

test("② 第 4/5 条只有过门槛的候补能进；不合格者跳过后继续顺延", () => {
  // A4 合格、A5 不合格、A6 合格 → 播出 A1/A2/A3/A4/A6，正好 5 条封顶
  const r = pick(items([false, false, false, true, false, true]));
  assert.deepEqual(r.chosen.map((c) => c.item.title), ["A1", "A2", "A3", "A4", "A6"]);
  assert.equal(r.gateRejected, 1, "A5 被门槛拦下");
  assert.equal(r.chosen.length, MUST_READ_PLAY_TARGET, "上限 5，不可再多");
});

test("③ 候选不足时不凑数：2 条就播 2 条；只有 1 条合格也不硬拉到 4", () => {
  assert.equal(pick(items([false, false])).chosen.length, 2);
  const r = pick(items([false, false, false, true]));
  assert.equal(r.chosen.length, 4, "3 基础 + 1 合格扩展 = 4，不为凑 5 再放宽");
  assert.equal(r.chosen[3].item.title, "A4");
});

test("④ 不传扩展门槛时行为与旧版一致（商机路径零回归）", () => {
  const r = pick(items([false, false, false, false, false, false]), beginDay(emptyMemory(), TODAY), false);
  assert.equal(r.chosen.length, MUST_READ_PLAY_TARGET, "旧版会选满 target");
  assert.equal(r.gateRejected, 0);
});

test("⑤ 工作日与周末基础条数一致（周末 4 条旧档已覆盖）", () => {
  assert.equal(mustReadTargetFor("2026-11-03"), MUST_READ_BASE_TARGET);
  assert.equal(mustReadTargetFor("2026-11-02"), MUST_READ_BASE_TARGET);
});

test("⑥ 口播跟随所见所得：syncNarration 对 3/4/5 条必读逐条派生，不截到 3", () => {
  for (const n of [3, 4, 5]) {
    const mr = Array.from({ length: n }, (_, i) => ({
      title: `必读事件${i + 1}`,
      why: `理由${i + 1}`,
      url: `https://e.com/mr-${i + 1}`,
    }));
    const e = syncNarration({
      must_read: mr,
      insights: [],
      hero_line: "",
    } as unknown as ExecutiveSummary);
    for (let i = 1; i <= n; i++) {
      assert.ok(e.spoken_must_read?.includes(`必读事件${i}`), `${n} 条卡面时口播不得漏掉第 ${i} 条`);
    }
  }
});
