/**
 * 日期工具加锁（`lib/utils/time.ts`）。
 *
 * 为什么补：抓取窗口口径全靠这几个纯函数（`dayGap` 定「日差 ≤ N」、`prevDateKey` 造多日窗口），
 * 而它们此前**零测试覆盖** —— 2026-09-15 红筹窗口从「1 天」改为「今天+昨天」时，
 * 正是这类日期算术最容易被写错（跨月 / 跨年 / 时区回落）。
 * 红线：日期键一律为**报告时区（北京时间）日历日**，纯日期运算不得引入时区换算。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { dayGap, prevDateKey } from "../lib/utils/time";

test("prevDateKey：前 N 个自然日（含跨月 / 跨年 / 闰年）", () => {
  assert.equal(prevDateKey("2026-09-15"), "2026-09-14", "默认前 1 天");
  assert.equal(prevDateKey("2026-09-15", 2), "2026-09-13");
  assert.equal(prevDateKey("2026-09-01"), "2026-08-31", "跨月");
  assert.equal(prevDateKey("2026-01-01"), "2025-12-31", "跨年");
  assert.equal(prevDateKey("2028-03-01"), "2028-02-29", "闰年 2 月");
  assert.equal(prevDateKey("2026-09-15", 0), "2026-09-15", "n=0 原样返回");
  // 非法输入不改写（宁可不改，也不编造日期）
  assert.equal(prevDateKey("2026/09/15"), "2026/09/15");
  assert.equal(prevDateKey(""), "");
});

test("dayGap：日差口径 = 今天-N ~ 今天（不是「含今天共 N 日」）", () => {
  assert.equal(dayGap("2026-09-13", "2026-09-15"), 2);
  assert.equal(dayGap("2026-09-15", "2026-09-15"), 0);
  assert.equal(dayGap("2026-09-20", "2026-09-15"), -5, "未来日期为负（调用方需自行判 ≥0）");
  // 实锤口径：IPO 2026-09-10 用户裁决 —— 日差恰为 7 必须在 7 天窗内
  assert.equal(dayGap("2026-09-03", "2026-09-10"), 7);
  // 跨月
  assert.equal(dayGap("2026-08-31", "2026-09-02"), 2);
});

test("抓取窗口构造：今天 + 昨天 两天（红筹 2026-09-15 用户口径）", () => {
  const today = "2026-09-15";
  const window = [today, prevDateKey(today)];
  assert.deepEqual(window, ["2026-09-15", "2026-09-14"], "默认窗口必须恰为两天");
});
