/**
 * 根 history/ 目录 7 天（可配）保留（lib/history/retention.mjs 的 pruneHistoryDirs）。
 * 验证：仅删 YYYY-MM-DD 且早于保留窗口的整日目录；非日期目录不动；返回被删列表。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pruneHistoryDirs } from "../scripts/history-retention.mjs";

function mkDateDir(root: string, name: string) {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "store.json"), "{}", "utf8");
  return d;
}

test("pruneHistoryDirs：仅删早于保留窗口的日期目录，非日期目录保留", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gzcmbdf3-ret-"));
  const now = Date.parse("2026-08-20T00:00:00Z"); // 午夜对齐，cutoff=08-13T00:00
  mkDateDir(root, "2026-08-10"); // < 7 天前 → 删
  mkDateDir(root, "2026-08-13"); // == cutoff（午夜）→ 保留
  mkDateDir(root, "2026-08-15"); // 保留
  mkDateDir(root, "2026-08-19"); // 保留
  mkDateDir(root, "2026-08-20"); // 保留
  fs.mkdirSync(path.join(root, "reports"), { recursive: true }); // 非日期目录 → 保留

  const removed = pruneHistoryDirs(root, 7, now);

  assert.deepEqual(removed.sort(), ["2026-08-10"]);
  assert.equal(fs.existsSync(path.join(root, "2026-08-13")), true);
  assert.equal(fs.existsSync(path.join(root, "2026-08-15")), true);
  assert.equal(fs.existsSync(path.join(root, "2026-08-19")), true);
  assert.equal(fs.existsSync(path.join(root, "2026-08-20")), true);
  assert.equal(fs.existsSync(path.join(root, "reports")), true, "非日期目录不应被删");
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneHistoryDirs：保留窗口可调（RETENTION_DAYS=3）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gzcmbdf3-ret-"));
  const now = Date.parse("2026-08-20T00:00:00Z"); // cutoff=08-17T00:00
  mkDateDir(root, "2026-08-17"); // 3 天前 == cutoff → 保留
  mkDateDir(root, "2026-08-16"); // < cutoff → 删

  const removed = pruneHistoryDirs(root, 3, now);

  assert.deepEqual(removed.sort(), ["2026-08-16"]);
  assert.equal(fs.existsSync(path.join(root, "2026-08-17")), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruneHistoryDirs：根目录不存在时返回空、不报错", () => {
  const removed = pruneHistoryDirs("/nonexistent/gzcmbdf3/history", 7);
  assert.deepEqual(removed, []);
});
