// 根 history/ 的 7 天（可配）保留（2026-08-20）。
//
// 移植自 gzinfo `lib/history/retention.mjs`（逐字）。归 scripts/ —— 本模块是纯 IO
// （fs.rmSync），只被 scripts/cleanup-history.mjs（plain node）import，不进入
// services/contracts 分层，符合「IO 归 adapters 或 scripts/**」的架构约束。
//
// 背景：报告与执行摘要归档都落在 history/<YYYY-MM-DD>/ 目录，原 cleanup-history.mjs
// 只裁 data/article-history.json，根 history/<date>/ 会无限累积。本纯函数按目录名
// 日期删除早于 retentionDays 的整日目录（含 store.json + 报告 html/json/md）。
//
// 纯 ESM、无类型依赖：cleanup-history.mjs（plain node）与 tests/*.test.ts（tsx）均可 import。
import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} root history 根目录（绝对或相对 cwd）
 * @param {number} retentionDays 保留天数（默认 7）
 * @param {number} [now] 当前时间戳（注入便于测试固定时间）
 * @returns {string[]} 被删除的日期目录名列表
 */
export function pruneHistoryDirs(root, retentionDays, now = Date.now()) {
  if (!fs.existsSync(root)) return [];
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const removed = [];
  for (const name of fs.readdirSync(root)) {
    // 仅处理 YYYY-MM-DD 格式的日期目录，避免误删非日期目录
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
    const t = Date.parse(name);
    if (Number.isNaN(t)) continue;
    if (t < cutoff) {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}
