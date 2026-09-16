/**
 * 日期键必须按**报告时区（北京 Asia/Shanghai）**——项目硬性规定，
 * 不接受 env 覆盖、**不回落系统时区**（CI runner 默认 UTC）。
 *
 * 2026-09-17 修复的四类写法都栽在同一处：用 `toISOString()`（UTC）或
 * `getFullYear()/getMonth()/getDate()`（运行环境本地时区）取日历日，
 * 在北京 00:00~08:00 会算成**前一天**：
 *   - `staleness.reportDay`（原 localDay；6 个 IPO 源新鲜度哨兵的基准日）
 *   - `listed-check.parseListedDate`（毫秒时间戳 → 日期）
 *   - `bse-audit.parseBseDate`（北交所 {time} / 毫秒 → 日期）
 *   - `side-stock-recap`（Date → 日期键）
 *
 * 本测试用「北京 00:30」这一**最危险时刻**做锚点：此刻 UTC 仍是前一天，
 * 任何 UTC/系统时区实现都会算出前一天，从而立刻暴露。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reportDay, dayGap } from "../lib/adapters/crawlers/sources/staleness";
import { parseListedDate } from "../lib/adapters/crawlers/sources/listed-check";
import { parseBseDate } from "../lib/adapters/crawlers/sources/bse-audit";
import { todayKeyOf } from "../lib/utils/time";

/** 北京时间 2026-09-17 00:30（= UTC 2026-09-16 16:30，UTC 视角仍是 09-16）。 */
const BJ_EARLY_MORNING = new Date("2026-09-16T16:30:00Z");
const EXPECT = "2026-09-17";

test("todayKeyOf：北京时间 00:30 应算作当天（UTC 视角是前一天）", () => {
  assert.equal(todayKeyOf(BJ_EARLY_MORNING), EXPECT);
});

test("reportDay（原 localDay）：哨兵基准日必须是北京日，而非 CI(Ubuntu) 的 UTC 日", () => {
  assert.equal(
    reportDay(BJ_EARLY_MORNING),
    EXPECT,
    "原实现用 getFullYear/getMonth/getDate（系统时区）→ CI 上会退一天",
  );
});

test("parseListedDate：毫秒时间戳按北京日取键", () => {
  assert.equal(parseListedDate(BJ_EARLY_MORNING.getTime()), EXPECT);
  // 字符串形态不受影响（本就是字面日期）
  assert.equal(parseListedDate("2019-07-22"), "2019-07-22");
  assert.equal(parseListedDate("20020409"), "2002-04-09");
  assert.equal(parseListedDate(undefined), "");
});

test("parseBseDate：{time} 与裸毫秒都按北京日取键", () => {
  assert.equal(parseBseDate({ time: BJ_EARLY_MORNING.getTime() }), EXPECT);
  assert.equal(parseBseDate(BJ_EARLY_MORNING.getTime()), EXPECT);
  assert.equal(parseBseDate("20260917"), "2026-09-17");
});

test("回归守恒：北京 08:00 之后（UTC 已跨日）仍取当天，两侧不漂移", () => {
  // 北京 09-17 09:00 = UTC 09-17 01:00，两种实现都得 09-17
  const midday = new Date("2026-09-17T01:00:00Z");
  assert.equal(todayKeyOf(midday), EXPECT);
  assert.equal(reportDay(midday), EXPECT);
  assert.equal(parseBseDate(midday.getTime()), EXPECT);
});

test("dayGap 与 reportDay 口径一致（哨兵差值不因时区错位）", () => {
  assert.equal(dayGap("2026-09-14", reportDay(BJ_EARLY_MORNING)), 3);
});
