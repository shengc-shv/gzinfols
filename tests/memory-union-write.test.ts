import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEventMemory, saveEventMemory } from "../lib/adapters/persistence";
import { emptyMemory } from "../lib/services/memory/event-memory";

/**
 * 记忆落盘「并集写」防丢更新（2026-09-16）。
 *
 * 背景：`ipoVoicing`（企业 → 已口播日期）是只增日志，但写盘是「读旧文件 → 内存追加 →
 * 整体覆盖」。同一天多个 run 写同一份文件时，后写的会抹掉先写的
 * （实证：09-15 20:32 记录的优邦科技 09-15，37 秒后被另一条线覆盖成缺失，
 *  仅靠 git 合并侥幸救回；该企业窗口计数因此从 2 掉到 1 → 本该跳过却重复口播）。
 * 修法：落盘前与磁盘上的日期做并集 → 任何写者都不可能抹掉别人记录的日期。
 */

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "gzinfols-mem-union-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("saveEventMemory：ipoVoicing 并集写——后写者不抹掉先写者已记录的日期", () => {
  withTempDir((dir) => {
    // 写者 A：记录 企业X 在 09-15 被口播
    saveEventMemory(
      { ...emptyMemory(), ipoVoicing: { 企业X: ["2026-09-15"] } },
      { baseDir: dir, today: "2026-09-15" },
    );
    // 写者 B：从「没读到 A」的旧状态出发（模拟并发/丢更新），只记录 企业Y
    saveEventMemory(
      { ...emptyMemory(), ipoVoicing: { 企业Y: ["2026-09-16"] } },
      { baseDir: dir, today: "2026-09-16" },
    );
    const after = loadEventMemory({ baseDir: dir });
    assert.deepEqual(after.ipoVoicing?.["企业X"], ["2026-09-15"], "先写者的日期不得被抹掉");
    assert.deepEqual(after.ipoVoicing?.["企业Y"], ["2026-09-16"]);
  });
});

test("saveEventMemory：同企业多日期并集去重且有序", () => {
  withTempDir((dir) => {
    saveEventMemory(
      { ...emptyMemory(), ipoVoicing: { 企业X: ["2026-09-16"] } },
      { baseDir: dir, today: "2026-09-16" },
    );
    saveEventMemory(
      { ...emptyMemory(), ipoVoicing: { 企业X: ["2026-09-15", "2026-09-16"] } },
      { baseDir: dir, today: "2026-09-16" },
    );
    const after = loadEventMemory({ baseDir: dir });
    assert.deepEqual(after.ipoVoicing?.["企业X"], ["2026-09-15", "2026-09-16"]);
  });
});

test("saveEventMemory：events 不并集（保持「最新状态」语义，避免复活已淘汰事件）", () => {
  withTempDir((dir) => {
    saveEventMemory(
      {
        ...emptyMemory(),
        events: {
          e1: {
            id: "e1",
            topicTags: ["房贷"],
            anchors: ["房贷"],
            kind: "policy",
            firstBroadcastAt: "2026-09-15",
            lastBroadcastAt: "2026-09-15",
            broadcastCount: 1,
            sections: ["must_read"],
            anglesUsed: [],
            samples: [{ date: "2026-09-15", section: "must_read", title: "40年房贷落地", text: "40年房贷落地" }],
            broadcastedTexts: [],
            broadcastedFacts: [],
            peakScore: 70,
          },
        },
      },
      { baseDir: dir, today: "2026-09-15" },
    );
    // 写者 B 用「空 events」覆盖（模拟清理/淘汰）→ 应保持空，不被并集复活
    saveEventMemory({ ...emptyMemory() }, { baseDir: dir, today: "2026-09-16" });
    const after = loadEventMemory({ baseDir: dir });
    assert.equal(Object.keys(after.events ?? {}).length, 0, "events 不应被并集复活");
  });
});
