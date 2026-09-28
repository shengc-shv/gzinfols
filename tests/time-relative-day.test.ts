/**
 * 时间表述准确性（2026-09-28 sc 立项）：相对日换算 + 精度分级 + 时间表述自检。
 *
 * 背景：报告每天早上 7 点多生成、抓「今天 + 昨天」两天，但此前**全文统称「今日」** ——
 * 反映的是报告发布时间而非新闻实际报道时间；卡片徽章已会算「09/27 · 昨天」，两套口径并存
 * 造成听众认知割裂（sc 实证：粤芯半导体）。
 *
 * 口径（sc 拍板）= **报道时间**（媒体刊发 / 官方发布时刻，数据里只有这个）；
 * 官方源的结构化事件日由各自分支单独精确化（如 IPO 的 ipoMeta）。
 *
 * 本文件锁四件事：
 *   ① `spokenRelativeDay`：相对日 + 时段（`今天凌晨` / `昨天上午` / `昨晚` / `前天`）；
 *   ② **精度分级**：`00:00:00` 兜底值（无真实时分）只给到「日」，**绝不编造时段**
 *      （00:00Z 换算到北京恰是 08:00，照常换算就会产出「今天上午 8 点」这种假时间）；
 *   ③ 边界：超窗 / 未来 / 无法解析 → 空串（调用方不硬造）；MM/DD 形态亦支持；
 *   ④ `auditTimeWording`：正文写「今天」而条目实际为「昨天」→ 记违规（只告警，不改写）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { spokenDayParts, spokenRelativeDay } from "../lib/utils/time";
import { auditTimeWording } from "../lib/services/enrich/executive-summary";

const R = "2026-09-28"; // 报告日

// ---------------------------------------------------------------------------
// ① 相对日 + 时段
// ---------------------------------------------------------------------------

test("spokenRelativeDay：当天/昨天的各时段（报告时区口径）", () => {
  assert.equal(spokenRelativeDay("2026-09-28T01:30:00+08:00", R), "今天凌晨");
  assert.equal(spokenRelativeDay("2026-09-28T07:10:00+08:00", R), "今天一早");
  assert.equal(spokenRelativeDay("2026-09-28T10:00:00+08:00", R), "今天上午");
  assert.equal(spokenRelativeDay("2026-09-27T15:00:00+08:00", R), "昨天下午");
  assert.equal(spokenRelativeDay("2026-09-27T22:30:00+08:00", R), "昨晚");
  assert.equal(spokenRelativeDay("2026-09-27T09:30:00+08:00", R), "昨天上午");
});

test("spokenRelativeDay：UTC 形态按报告时区换算（CI=UTC 不回落）", () => {
  // 2026-09-26T22:36:27Z → 北京 2026-09-27 06:36 → 昨天一早
  assert.equal(spokenRelativeDay("2026-09-26T22:36:27.000Z", R), "昨天一早");
  // 2026-09-27T18:00:00Z → 北京 2026-09-28 02:00 → 今天凌晨
  assert.equal(spokenRelativeDay("2026-09-27T18:00:00.000Z", R), "今天凌晨");
});

// ---------------------------------------------------------------------------
// ② 精度分级：无真实时分 → 只给到「日」
// ---------------------------------------------------------------------------

test("🔴 精度分级：00:00:00 兜底值只给「日」，绝不编造时段", () => {
  // 源站把时分秒归零（静态列表页）；00:00Z 换算到北京是 08:00 —— 若照常换算会产出
  // 「今天上午」这种假的具体时间，违反时间真实性红线。
  assert.equal(spokenRelativeDay("2026-09-27T00:00:00.000Z", R), "昨天");
  assert.equal(spokenRelativeDay("2026-09-28T00:00:00.000Z", R), "今天");
  assert.equal(spokenRelativeDay("2026-09-27T00:00:00+08:00", R), "昨天", "带时区偏移的归零值同样识别");
  const parts = spokenDayParts("2026-09-27T00:00:00.000Z", R);
  assert.equal(parts.dateOnly, true, "必须标记为「仅日期」");
});

test("真实时分（非归零）→ 允许给时段", () => {
  const parts = spokenDayParts("2026-09-27T22:30:00+08:00", R);
  assert.equal(parts.dateOnly, false);
  assert.equal(parts.hour, 22);
  assert.equal(parts.gap, 1);
});

// ---------------------------------------------------------------------------
// ③ 边界
// ---------------------------------------------------------------------------

test("边界：超两日窗 / 未来 / 无法解析 → 空串（不硬造）", () => {
  assert.equal(spokenRelativeDay("2026-09-26T10:00:00+08:00", R), "前天", "前天（gap=2）仍属窗内");
  assert.equal(spokenRelativeDay("2026-09-20T10:00:00+08:00", R), "", "超窗 → 空串");
  assert.equal(spokenRelativeDay(undefined, R), "", "无发布时间 → 空串（时间红线：不兜底）");
  assert.equal(spokenRelativeDay("not-a-date", R), "", "非法值 → 空串");
  assert.equal(spokenRelativeDay("2026-09-29T10:00:00+08:00", R), "", "未来 → 空串");
});

test("MM/DD 形态（ReportItem.date / IPO 池）：只给到「日」", () => {
  assert.equal(spokenRelativeDay("09/28", R), "今天");
  assert.equal(spokenRelativeDay("09/27", R), "昨天");
  assert.equal(spokenRelativeDay("09/26", R), "前天");
  assert.equal(spokenDayParts("09/27", R).dateOnly, true, "MM/DD 无时分 → 恒为仅日期");
});

// ---------------------------------------------------------------------------
// ④ 时间表述自检（A3）
// ---------------------------------------------------------------------------

test("auditTimeWording：条目实际是「昨天」而正文写「今天」→ 记违规", () => {
  const hits = auditTimeWording([
    { text: "今日公布的理财费率下调", when: "昨天" },
    { text: "今天凌晨发布的政策", when: "今天凌晨" },
    { text: "央行例会删去跨周期加码稳汇率", when: "昨天" },
    { text: "昨天公告的粤芯半导体中签率出炉", when: "昨天" },
    { text: "今天新增的消费补贴", when: undefined },
  ]);
  assert.equal(hits.length, 1, `只应命中 1 处（实际 ${JSON.stringify(hits)}）`);
  assert.equal(hits[0]!.when, "昨天");
  assert.ok(hits[0]!.text.includes("今日公布"));
});

test("auditTimeWording：when 以「今天」开头一律合规；缺 when 不判（无从判定）", () => {
  assert.equal(auditTimeWording([{ text: "今天有 1 件事", when: "今天" }]).length, 0);
  assert.equal(auditTimeWording([{ text: "今天凌晨的事", when: "今天凌晨" }]).length, 0);
  assert.equal(
    auditTimeWording([{ text: "今天值得关注", when: undefined }]).length,
    0,
    "时间未标明 → 不告警（prompt 已要求此时不得安相对日）",
  );
  assert.equal(auditTimeWording([{ text: "普通陈述，无时间词", when: "昨天" }]).length, 0);
});
