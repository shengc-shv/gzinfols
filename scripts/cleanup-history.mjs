// 裁剪 data/article-history.json：仅保留最近 N 天的数据，避免缓存无限膨胀。
// 移植自 gzinfo `scripts/cleanup-history.mjs`（逐字；唯一适配：retention 辅助模块
// 由 `../lib/history/retention.mjs` 改为同目录 `./history-retention.mjs`，保持 plain node 可直跑）。
//
// 关键：被移除的条目不会真正丢弃，而是累积写入 data/article-history-backup.json
// （按条目去重，永不丢失），主文件只保留最近 N 天。
//
// 时间字段优先级：publishedAt → lastSeenAt → firstSeenAt（任一有效即可判定）。
// 用法：node scripts/cleanup-history.mjs  （可选 RETENTION_DAYS=7 覆盖保留天数）
import fs from 'node:fs';
import path from 'node:path';
import { pruneHistoryDirs } from './history-retention.mjs';

const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 7);
const HISTORY_PATH = path.resolve(process.cwd(), 'data/article-history.json');
const BACKUP_PATH = path.resolve(process.cwd(), 'data/article-history-backup.json');
const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

function tsOf(entry) {
  for (const key of ['publishedAt', 'lastSeenAt', 'firstSeenAt']) {
    const v = entry[key];
    if (v) {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  return null;
}

// 去重键：优先用稳定 id，否则用 sourceId+title+时间 拼接
function keyOf(e) {
  if (e && e.id) return String(e.id);
  const src = (e && (e.sourceId || e.source)) || '';
  const title = (e && (e.title || '')).slice(0, 60);
  const t = (e && (e.publishedAt || e.lastSeenAt || e.firstSeenAt)) || '';
  return `${src}|${title}|${t}`;
}

// 安全网（2026-08-21 固化）：无 publishedAt 且标题含「旧年份」（<= 今年-2）的条目视为陈旧内容，直接移除。
// 背景：这类条目 lastSeenAt 近期（过 7 天窗口）但实为往年旧闻，曾人工清理（5d4ff47）。
// 与 daily.ts 兜底（无 publishedAt 不进 AI）互补——本脚本是历史库的独立防线。
// 阈值用 <= 今年-2（而非 < 今年）以保守处理：避免误删标题写「回顾2025」的当年新文。
function hasStaleYearTitle(entry) {
  if (entry.publishedAt) return false;
  const years = String(entry.title || '').match(/\b(?:19|20)\d{2}\b/g);
  if (!years) return false;
  const floor = new Date().getFullYear() - 2;
  return years.some((y) => Number(y) <= floor);
}

// 读取已有备份（对象或数组），返回 Map<key, entry>
function loadBackup() {
  const map = new Map();
  if (fs.existsSync(BACKUP_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'));
      const arr = Array.isArray(raw) ? raw : Object.values(raw);
      for (const e of arr) map.set(keyOf(e), e);
    } catch {
      /* 损坏则忽略，重新累积 */
    }
  }
  return map;
}

if (!fs.existsSync(HISTORY_PATH)) {
  console.log(`[cleanup] 未找到 ${HISTORY_PATH}，跳过`);
  process.exit(0);
}

const raw = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
const isArray = Array.isArray(raw);

let kept;
const dropped = [];

if (isArray) {
  kept = [];
  for (const e of raw) {
    if (hasStaleYearTitle(e)) { dropped.push(e); continue; } // 旧年份陈旧内容直接移除
    const t = tsOf(e);
    if (t !== null && t >= cutoff) kept.push(e);
    else dropped.push(e);
  }
} else {
  kept = {};
  for (const [k, e] of Object.entries(raw)) {
    if (hasStaleYearTitle(e)) { dropped.push(e); continue; } // 旧年份陈旧内容直接移除
    const t = tsOf(e);
    if (t !== null && t >= cutoff) kept[k] = e;
    else dropped.push(e);
  }
}

const keptCount = isArray ? kept.length : Object.keys(kept).length;

// 写回主文件（仅最近 N 天）
fs.writeFileSync(HISTORY_PATH, JSON.stringify(kept, null, 2), 'utf8');

// 累积写入备份文件（本次移除 + 历史已移除，去重）
const backupMap = loadBackup();
let added = 0;
for (const e of dropped) {
  const k = keyOf(e);
  if (!backupMap.has(k)) {
    backupMap.set(k, e);
    added++;
  }
}
fs.writeFileSync(BACKUP_PATH, JSON.stringify([...backupMap.values()], null, 2), 'utf8');

const cutoffStr = new Date(cutoff).toISOString().slice(0, 10);
console.log(
  `[cleanup] 保留最近 ${RETENTION_DAYS} 天（>= ${cutoffStr}）：` +
    `主文件保留 ${keptCount} 条，本次移除 ${dropped.length} 条；` +
    `备份累计 ${backupMap.size} 条（新增 ${added}）-> ${BACKUP_PATH}`
);

// 根 history/<YYYY-MM-DD>/ 目录 7 天（RETENTION_DAYS）保留：删掉早于 cutoff 的整日目录
// （含 store.json + 报告 html/json/md）。与 article-history 同一保留窗口。
const HISTORY_ROOT = path.resolve(process.cwd(), 'history');
const removedDirs = pruneHistoryDirs(HISTORY_ROOT, RETENTION_DAYS);
if (removedDirs.length) {
  console.log(`[cleanup] 根 history/ 清理 ${removedDirs.length} 个过期日期目录（< ${cutoffStr}）: ${removedDirs.join(', ')}`);
} else {
  console.log(`[cleanup] 根 history/ 无过期目录（保留窗口 ${RETENTION_DAYS} 天）`);
}
