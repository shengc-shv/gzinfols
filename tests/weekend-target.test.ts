/**
 * 周末版降档（2026-11-02 sc 授权）。
 *
 * 背景：周末+周一早报可用内容只有工作日一半（sina-bank 47→0 / guancha 53→0，
 * 股市源占比 31%→43%）→ 满额 5+6 会逼 LLM 拿券商研判凑数（11-02 商机 6 条全是市场评论）。
 * 处置：周末版少给目标条数，宁缺毋滥。
 * 🔴 2026-11-28：必读改为「基础 3 / 上限 5 + 额外质量门槛」，工作日/周末一致；
 *    本文件的周末降档现在只锁商机。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isWeekendEdition,
  mustReadTargetFor,
  insightTargetFor,
  MUST_READ_BASE_TARGET,
  MUST_READ_PLAY_TARGET,
  INSIGHT_PLAY_TARGET,
} from "../lib/services/memory/event-types";

test("周末版判定：周六/周日/周一为周末版，周二至周五为正常版", () => {
  // 2026-11-01 周日 / 11-02 周一 / 10-31 周六 / 10-30 周五 / 10-29 周四
  const cases: Array<[string, boolean]> = [
    ["2026-10-29", false],
    ["2026-10-30", false],
    ["2026-10-31", true],
    ["2026-11-01", true],
    ["2026-11-02", true],
    ["2026-11-03", false],
    ["2026-11-06", false],
    ["2026-11-07", true],
    ["2026-11-08", true],
  ];
  for (const [d, expected] of cases) {
    assert.equal(isWeekendEdition(d), expected, `${d} 周末版应为 ${expected}`);
  }
});

test("必读基础恒为 3；商机周末版减 1（工作日 6，周末 5）", () => {
  for (const d of ["2026-11-03", "2026-11-02", "2026-11-07", "2026-11-08"]) {
    assert.equal(mustReadTargetFor(d), MUST_READ_BASE_TARGET, `${d} 必读基础应为 3`);
  }
  assert.equal(insightTargetFor("2026-11-03"), INSIGHT_PLAY_TARGET);
  assert.equal(insightTargetFor("2026-11-02"), INSIGHT_PLAY_TARGET - 1);
  assert.ok(MUST_READ_BASE_TARGET < MUST_READ_PLAY_TARGET, "基础 3 < 上限 5，留出扩展位");
});

test("非法日期按最保守处理（降档，不得抛错）", () => {
  for (const bad of ["", "2026-13-01", "abc", "2026-02-30"]) {
    assert.doesNotThrow(() => isWeekendEdition(bad));
    assert.ok(mustReadTargetFor(bad) <= MUST_READ_PLAY_TARGET, `非法日期应降档：${bad}`);
  }
});
