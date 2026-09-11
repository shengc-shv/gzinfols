#!/usr/bin/env node
/**
 * 站点聚合：把已生成的报告聚成可发布的静态站点（gh-pages 或任意静态托管）。
 * 应在 `npm run daily` 产出当日报告之后运行。
 *
 * 2.0 存储模型（与 gzinfo 不同，见 docs/parity-B5-report.md D2）：
 *   `daily_reports/<date>/` 既是**唯一存储**也是**发布目录**（daily.ts 只写这里），
 *   因此本脚本不再做「唯一存储 → 发布目录」的拷贝同步，只负责：
 *   - 扫描所有日期目录（含 CI 从 gh-pages 恢复的历史）
 *   - 生成 index.html（最新报告）/ archive.html（全部日期）/ .nojekyll
 *   - 音频滚动清理（只保留最近 3 天 mp3，报告正文保留窗口不变）
 *
 * 幂等 —— 可重复运行。
 *
 * Usage:
 *   node scripts/build-site.mjs
 *
 * 移植自 gzinfo scripts/build-site.mjs（167 行），按 2.0 存储模型适配。
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = "daily_reports";

const dateDirs = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .filter((d) => fs.existsSync(path.join(dir, d, `${d}.html`)))
    : [];

const dates = dateDirs(ROOT).sort((a, b) => b.localeCompare(a));

if (dates.length === 0) {
  console.error(`[build-site] 找不到报告目录（${ROOT}/）— 先跑 \`npm run daily\`。`);
  process.exit(1);
}

fs.mkdirSync(ROOT, { recursive: true });
console.log(`[build-site] 发现 ${dates.length} 个报告（唯一存储 = ${ROOT}/，无需同步拷贝）`);

// --- 音频滚动清理：只保留最近 3 天（报告正文保留窗口不变）---
const AUDIO_KEEP_DAYS = 3;
const audioCutoff = new Date();
audioCutoff.setDate(audioCutoff.getDate() - AUDIO_KEEP_DAYS);
let audioCleaned = 0;
for (const d of dates) {
  const ad = path.join(ROOT, d, "audio");
  if (!fs.existsSync(ad)) continue;
  // 纯日期比较：以 UTC 零点为锚，避免 DST/时区偏移（报告日期键为北京时间日历日）
  const day = new Date(`${d}T00:00:00Z`);
  if (day < audioCutoff) {
    fs.rmSync(ad, { recursive: true, force: true });
    audioCleaned++;
    console.log(`[build-site] 🗑 清理过期音频目录：${ROOT}/${d}/audio`);
  }
}
if (audioCleaned === 0) {
  console.log(`[build-site] 音频滚动清理：无过期（保留最近 ${AUDIO_KEEP_DAYS} 天）`);
}

// --- 分享缩略图：拷贝到发布根（报告 <head> 的 og:image 绝对地址 ${base}/og-image.png 用）---
const OG_SRC = "assets/og-image.png";
if (fs.existsSync(OG_SRC)) {
  fs.copyFileSync(OG_SRC, path.join(ROOT, "og-image.png"));
  console.log(`[build-site] og-image.png → ${ROOT}/`);
} else {
  console.log(`[build-site] ⚠️ 未找到 ${OG_SRC}，分享卡片缩略图将缺失（og:image 失效）`);
}

// --- index.html = latest report ---
const latest = dates[0];
const latestHtml = fs
  .readFileSync(path.join(ROOT, latest, `${latest}.html`), "utf8")
  .replace(/href="\.\.\/archive\.html"/g, 'href="./archive.html"')
  .replace(/src="audio\//g, `src="${latest}/audio/`);
fs.writeFileSync(path.join(ROOT, "index.html"), latestHtml, "utf8");
console.log(`[build-site] index.html  ← ${latest}/${latest}.html`);

// --- archive.html = list of all reports ---
const rows = dates
  .map((d) => {
    const size = (fs.statSync(path.join(ROOT, d, `${d}.html`)).size / 1024).toFixed(0);
    return `      <li><a href="./${d}/${d}.html">${d}</a> <span class="size">${size} KB</span></li>`;
  })
  .join("\n");

const archiveHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>每日资信简报 — 归档</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    max-width: 720px;
    margin: 3rem auto;
    padding: 0 1.5rem;
    line-height: 1.5;
  }
  h1 { margin-bottom: 0.2rem; font-size: 1.5rem; }
  .meta { color: #888; font-size: 0.9rem; margin-bottom: 1.5rem; }
  ul { list-style: none; padding: 0; }
  li {
    padding: 0.5rem 0;
    border-bottom: 1px solid #eee;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  @media (prefers-color-scheme: dark) {
    li { border-bottom-color: #2a2a2a; }
  }
  li a { text-decoration: none; }
  li a:hover { text-decoration: underline; }
  .size { color: #999; font-size: 0.85rem; }
  .top {
    margin-bottom: 2rem;
    padding: 0.75rem 1rem;
    background: #f6f6f6;
    border-radius: 6px;
  }
  @media (prefers-color-scheme: dark) {
    .top { background: #1e1e1e; }
  }
</style>
</head>
<body>
  <h1>每日资信简报 — 归档</h1>
  <p class="meta">共 ${dates.length} 期 · 最新在前 · 生成于 ${new Date().toISOString().slice(0, 10)}</p>
  <div class="top">
    <a href="./index.html">→ 最新一期（${latest}）</a>
  </div>
  <ul>
${rows}
  </ul>
</body>
</html>
`;
fs.writeFileSync(path.join(ROOT, "archive.html"), archiveHtml, "utf8");
console.log(`[build-site] archive.html (${dates.length} 期)`);

// .nojekyll：阻止 GitHub Pages 跑 Jekyll（否则下划线开头的目录会被吞）。
fs.writeFileSync(path.join(ROOT, ".nojekyll"), "", "utf8");
console.log(`[build-site] .nojekyll`);
