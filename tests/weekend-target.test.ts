/**
 * 周末版降档（2026-11-02 sc 授权）。
 *
 * 背景：周末+周一早报可用内容只有工作日一半（sina-bank 47→0 / guancha 53→0，
 * 股市源占比 31%→43%）→ 满额 5+6 会逼 LLM 拿券商研判凑数（11-02 商机 6 条全是市场评论）。
 * 处置：周末版少给目标条数，宁缺毋滥。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isWeekendEdition,
  mustReadTargetFor,
  insightTargetFor,
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

test("降档目标：工作日满额，周末版各减 1（工作日 5/6，周末 4/5）", () => {
  assert.equal(mustReadTargetFor("2026-11-03"), MUST_READ_PLAY_TARGET);
  assert.equal(insightTargetFor("2026-11-03"), INSIGHT_PLAY_TARGET);
  assert.equal(mustReadTargetFor("2026-11-02"), MUST_READ_PLAY_TARGET - 1);
  assert.equal(insightTargetFor("2026-11-02"), INSIGHT_PLAY_TARGET - 1);
});

test("非法日期按最保守处理（降档，不得抛错）", () => {
  for (const bad of ["", "2026-13-01", "abc", "2026-02-30"]) {
    assert.doesNotThrow(() => isWeekendEdition(bad));
    assert.ok(mustReadTargetFor(bad) <= MUST_READ_PLAY_TARGET, `非法日期应降档：${bad}`);
  }
});
