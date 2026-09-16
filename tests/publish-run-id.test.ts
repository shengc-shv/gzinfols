import { test } from "node:test";
import assert from "node:assert/strict";
import { extractReportRunId } from "../lib/services/memory/publish-run-id";

/**
 * 发布 run id 提取（gh-pages commit message → run id）。
 *
 * 该函数是「次日结算版本指纹对账」（deliverySettlementGate）的唯一数据来源：
 * 提取失败 → deliveries.reportRunId 缺失 → 闸门退化为「信任交付」→
 * **未推送微信的内容也会被结算进长期记忆**（2026-09-16 实证事故）。
 * 历史上两次故障同因：commit message 变了、正则没跟上。
 */

test("extractReportRunId：旧式 'report for <id>'（gzinfo / peaceiris 时代）", () => {
  assert.equal(
    extractReportRunId("daily: report for 35037024758 9d8c02c1f2e3a4b5c6d7e8f9012345678901234"),
    "35037024758",
  );
});

test("extractReportRunId：现行 'publish: 站点快照 <id>'（2026-09-14 改分支式发布后的格式）", () => {
  assert.equal(extractReportRunId("publish: 站点快照 35092615952"), "35092615952");
});

test("extractReportRunId：全角括号写法（本地/人工发布的容错）", () => {
  assert.equal(extractReportRunId("publish: 站点快照（35092615952）"), "35092615952");
});

test("extractReportRunId：无 run id / 空输入 → undefined（不得编造）", () => {
  assert.equal(extractReportRunId("publish: 站点快照（本地 replay 真实报告 2026-09-15）"), undefined);
  assert.equal(extractReportRunId("chore: 更新历史缓存并归档报告 (2026-09-16)"), undefined);
  assert.equal(extractReportRunId(""), undefined);
  assert.equal(extractReportRunId(undefined), undefined);
  assert.equal(extractReportRunId(null), undefined);
});
