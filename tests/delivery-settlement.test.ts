/**
 * 交付结算语义测试（2026-09-15，随 notify / mark-delivered 写入端移植新增）。
 *
 * 锁住核心口径：**只有发送成功的才算入记忆**（代表客户已经看过这些数据）。
 *   渲染（daily）只写当日**暂存区 today**；
 *   推送真正送达 → mark-delivered 写 deliveries 并结算进长期 events；
 *   未送达 → 不结算，宁漏勿误（次日同源新闻允许重播）。
 *
 * 覆盖：闸门三态（delivered / no-delivery / fingerprint-mismatch）· beginDay 跨天结算 ·
 *       appendDelivery 同日覆盖 · 当日即时结算（mark-delivered 组合语义）·
 *       deliveries 落盘往返（adapters/persistence，临时目录隔离）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendDelivery,
  beginDay,
  deliverySettlementGate,
  settleTodayIntoEvents,
  type BroadcastSample,
  type EventMemoryStore,
} from "../lib/services/memory/event-memory";
import { loadEventMemory, saveEventMemory } from "../lib/adapters/persistence";

const D1 = "2026-09-14";
const D2 = "2026-09-15";

function sample(title: string, date = D1): BroadcastSample {
  return { date, section: "hero", title };
}

/** 昨天的暂存区（3 条播报） + 空长期记忆 */
function stagedStore(runId = "run-1"): EventMemoryStore {
  return {
    version: 1,
    updatedAt: D1,
    events: {},
    today: { date: D1, entries: [sample("粤企赴港上市活跃"), sample("养老信托首单落地"), sample("液冷板块获看好")], runId },
  };
}

test("闸门：无交付记录 → 不结算（no-delivery，宁漏勿误）", () => {
  const gate = deliverySettlementGate(stagedStore(), D1);
  assert.deepEqual(gate, { settle: false, reason: "no-delivery" });
});

test("闸门：有当日交付记录 → 结算（delivered）", () => {
  const s = appendDelivery(stagedStore(), { date: D1, pushedAt: `${D1}T08:30:00+08:00` });
  assert.deepEqual(deliverySettlementGate(s, D1), { settle: true, reason: "delivered" });
});

test("闸门：交付指纹与暂存区指纹不一致 → 不结算（fingerprint-mismatch）", () => {
  const s = appendDelivery(stagedStore("run-2"), {
    date: D1,
    pushedAt: `${D1}T08:30:00+08:00`,
    reportRunId: "run-999", // 推送的版本 ≠ 落盘的暂存版本
  });
  assert.deepEqual(deliverySettlementGate(s, D1), { settle: false, reason: "fingerprint-mismatch" });
  // 任一侧缺指纹 → 无法证伪，按信任交付结算
  const s2 = appendDelivery(stagedStore(), { date: D1, pushedAt: `${D1}T08:30:00+08:00`, reportRunId: "run-1" });
  assert.equal(deliverySettlementGate(s2, D1).settle, true);
  const s3 = appendDelivery({ ...stagedStore(), today: { date: D1, entries: [sample("x")] } }, {
    date: D1,
    pushedAt: `${D1}T08:30:00+08:00`,
    reportRunId: "run-999",
  });
  assert.equal(deliverySettlementGate(s3, D1).settle, true);
});

test("beginDay 跨天：有交付 → 昨天暂存结算进 events；无交付 → 丢弃不结算", () => {
  const delivered = beginDay(appendDelivery(stagedStore(), { date: D1, pushedAt: `${D1}T08:30:00+08:00` }), D2);
  assert.ok(Object.keys(delivered.events).length > 0, "有交付应结算出事件");
  assert.equal(delivered.today?.date, D2);
  assert.equal(delivered.today?.entries.length, 0);

  const notDelivered = beginDay(stagedStore(), D2);
  assert.equal(Object.keys(notDelivered.events).length, 0, "未交付不得进长期记忆");
  assert.equal(notDelivered.today?.date, D2, "暂存区仍随新一天重置（昨日播报不结算）");
});

test("appendDelivery：同日重复推送覆盖 pushedAt，不追加重复记录", () => {
  let s = appendDelivery(stagedStore(), { date: D1, pushedAt: `${D1}T08:30:00+08:00` });
  s = appendDelivery(s, { date: D1, pushedAt: `${D1}T09:10:00+08:00`, reportSha: "abc1234" });
  assert.equal(s.deliveries?.length, 1, "同一天只有一条交付记录");
  assert.equal(s.deliveries?.[0].pushedAt, `${D1}T09:10:00+08:00`);
  assert.equal(s.deliveries?.[0].reportSha, "abc1234");
  // 不同日期各自独立
  s = appendDelivery(s, { date: D2, pushedAt: `${D2}T08:30:00+08:00` });
  assert.equal(s.deliveries?.length, 2);
});

test("mark-delivered 组合语义：写交付 + 当日即时结算（暂存清空、events 填充）", () => {
  const before = stagedStore();
  assert.equal(before.today?.entries.length, 3);
  let next = appendDelivery(before, { date: D1, pushedAt: `${D1}T08:30:00+08:00`, runId: "notify-run-1" });
  next = settleTodayIntoEvents(next, D1);
  assert.equal(next.today?.entries.length, 0, "结算后当日暂存区清空（防重复结算）");
  assert.ok(Object.keys(next.events).length > 0, "当日播报已进长期记忆");
  assert.equal(next.deliveries?.[0].runId, "notify-run-1");
  // 同日再跑一次（无新内容）→ 不再产生新事件（幂等）
  const again = settleTodayIntoEvents(appendDelivery(next, { date: D1, pushedAt: `${D1}T09:00:00+08:00` }), D1);
  assert.deepEqual(Object.keys(again.events), Object.keys(next.events));
});

test("落盘往返：deliveries 与结算结果持久化（临时目录隔离，不碰生产记忆库）", () => {
  const dir = mkdtempSync(join(tmpdir(), "mem-deliver-"));
  try {
    const s = settleTodayIntoEvents(
      appendDelivery(stagedStore(), { date: D1, pushedAt: `${D1}T08:30:00+08:00`, reportRunId: "run-1" }),
      D1,
    );
    saveEventMemory(s, { baseDir: dir, today: D1 });
    const back = loadEventMemory({ baseDir: dir });
    assert.equal(back.deliveries?.length, 1);
    assert.equal(back.deliveries?.[0].date, D1);
    assert.equal(back.today?.entries.length, 0);
    assert.ok(Object.keys(back.events).length > 0, "结算后的事件应随文件读回（冷却期跨运行生效）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
