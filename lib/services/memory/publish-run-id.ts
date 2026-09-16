/**
 * 从 gh-pages 发布 commit message 提取「发布 run id」。
 *
 * 支持的提交信息格式（两种，按顺序尝试）：
 *   ① 旧式（gzinfo / peaceiris 时代）：`daily: report for <run_id> <源 commit sha>`
 *   ② 现行（2026-09-14 改分支式发布后，daily.yml 的 commit_message）：
 *      `publish: 站点快照 <run_id>`
 *
 * 演进史（两次都是「commit message 变了、正则没跟上」）：
 *  - 2026-09-05 修复（gzinfo）：原用 /run (\d+)/ 匹配，而当时格式是 "report for <id>"
 *    （无 "run " 字样）→ 恒匹配失败 → reportRunId 恒缺失 →
 *    次日结算指纹对账（deliverySettlementGate）从未生效，一直静默走「信任交付」。
 *  - 2026-09-16 修复（gzinfols）：2026-09-14 发布改为推送 gh-pages 分支后，commit message
 *    变为 `publish: 站点快照 <runId>`，而本函数只认 `report for <id>` → **再次恒缺失**。
 *    后果实证：同日早间已交付、晚间又跑了一次验证 run（未推送微信）写满暂存区；
 *    因指纹对账失效，次日 beginDay 退化为「信任交付」→ 未推送的内容被结算进长期记忆
 *    → 次日报告对它们去重/强制换角度（误冷却）。
 *
 * 两种格式都保留支持；新增格式时**必须同步本文件并补测试**（tests/publish-run-id.test.ts）。
 */

const REPORT_RUN_ID_RES: RegExp[] = [
  /report for (\d+)/, // ① 旧式
  /站点快照[（(\s]*(\d+)/, // ② 现行：`publish: 站点快照 <run_id>`（兼容全角括号写法）
];

export function extractReportRunId(commitMessage: string | undefined | null): string | undefined {
  const msg = commitMessage ?? "";
  for (const re of REPORT_RUN_ID_RES) {
    const m = re.exec(msg);
    if (m) return m[1];
  }
  return undefined;
}
