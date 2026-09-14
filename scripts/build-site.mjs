#!/usr/bin/env node
/**
 * 站点聚合：把已生成的报告聚成可发布的静态站点（gh-pages / 任意静态托管）。
 * 应在 `npm run daily` 产出当日报告之后运行。
 *
 * 布局（2026-09-14 B-3 起，子目录模型）：
 *   发布根 = `site/`，每期位于 `site/<date>/<date>.html`（+ `site/<date>/audio/`），
 *   站点根文件 `index.html`（最新一期）/ `archive.html`（全部期）/ `.nojekyll` /
 *   `og-image.png` 均由本脚本生成 —— **本脚本是 `site/` 的唯一写者**。
 *
 * 汇集来源（按优先级，先命中先用）：
 *   - `daily_reports/<date>/`：当日产物（daily.ts 写的唯一存储）
 *   - `history/<date>/`：CI 每期归档回 main 的历史各期（7 天窗口）
 * 两者都只是**读取源**；已存在的 `site/<date>/` 视为可重建，不去重历史。
 *
 * 为什么改成子目录布局（用户 2026-09-14 拍板选 b）：
 *   原实现产出**扁平**的 `site/<date>.html`，而归档链接 `../archive.html` 与本脚本
 *   假设的 `<date>/<date>.html` 子目录结构**互不兼容** —— 脚本从未在 CI 执行
 *   （workflow 直接上传 site/），归档页与 og-image 长期缺失。
 *   现统一到子目录模型：报告页里的相对链接（audio / archive）自然成立。
 *
 * 幂等 —— 可重复运行。
 *
 * Usage: node scripts/build-site.mjs
 */
import fs from "node:fs";
import path from "node:path";

/** 汇集来源（按优先级：前一个命中即不再看后面的）。 */
const SRC_DIRS = ["daily_reports", "history"];
/** 发布根（本脚本唯一写入目标）。 */
const OUT = "site";
/** 分享缩略图源（拷贝到发布根，供 og:image 的绝对地址 `${REPORT_BASE_URL}/og-image.png` 使用）。 */
const OG_SRC = "assets/og-image.png";
/** 音频滚动清理窗口（只作用于 daily_reports，不作用于发布根）。 */
const AUDIO_KEEP_DAYS = 3;
/** 报告时区（与 lib/utils/time.ts 的 REPORT_TZ 同口径；本脚本为 plain node，故内联常量）。 */
const REPORT_TZ = "Asia/Shanghai";

/** 报告时区下的 YYYY-MM-DD（用于 archive 页脚「生成于」标签，避免 CI(UTC) 显示前一天）。 */
function todayInReportTz() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** 某目录下形如 `<date>/<date>.html` 的期号列表（降序）。 */
function datesIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .filter((d) => fs.existsSync(path.join(dir, d, `${d}.html`)))
    .sort((a, b) => b.localeCompare(a));
}

// ---------- 1) 汇集各期到发布根 ----------
fs.mkdirSync(OUT, { recursive: true });
const picked = new Map(); // date -> 来源目录
for (const src of SRC_DIRS) {
  for (const d of datesIn(src)) {
    if (!picked.has(d)) picked.set(d, src);
  }
}
if (picked.size === 0) {
  console.error(
    `[build-site] 找不到任何报告目录（已尝试 ${SRC_DIRS.join(" / ")}）— 先跑 \`npm run daily\`。`,
  );
  process.exit(1);
}

let copied = 0;
for (const [d, src] of [...picked.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
  const destDir = path.join(OUT, d);
  fs.mkdirSync(destDir, { recursive: true });
  // 只发布「报告页 + 音频」：json / store.json / *-articles.json 属内部数据，不入公开站点。
  fs.copyFileSync(path.join(src, d, `${d}.html`), path.join(destDir, `${d}.html`));
  const audioSrc = path.join(src, d, "audio");
  if (fs.existsSync(audioSrc)) {
    fs.cpSync(audioSrc, path.join(destDir, "audio"), { recursive: true });
  }
  copied++;
}
const dates = datesIn(OUT); // 以发布根为准（汇集后）
console.log(
  `[build-site] 汇集 ${copied} 期 → ${OUT}/（来源 ${SRC_DIRS.join(" / ")}；发布根现有 ${dates.length} 期）`,
);

// ---------- 2) 音频滚动清理（只作用于 daily_reports，发布根每次重建无需清理）----------
const audioCutoff = new Date(Date.now() - AUDIO_KEEP_DAYS * 86_400_000);
let audioCleaned = 0;
for (const src of SRC_DIRS) {
  for (const d of datesIn(src)) {
    const ad = path.join(src, d, "audio");
    if (!fs.existsSync(ad)) continue;
    // 纯日期比较：以 UTC 零点为锚，避免 DST/时区偏移（报告日期键为北京时间日历日）
    if (new Date(`${d}T00:00:00Z`) < audioCutoff) {
      fs.rmSync(ad, { recursive: true, force: true });
      audioCleaned++;
      console.log(`[build-site] 🗑 清理过期音频目录：${src}/${d}/audio`);
    }
  }
}
if (audioCleaned === 0) {
  console.log(`[build-site] 音频滚动清理：无过期（保留最近 ${AUDIO_KEEP_DAYS} 天）`);
}

// ---------- 3) og-image.png → 发布根 ----------
if (fs.existsSync(OG_SRC)) {
  fs.copyFileSync(OG_SRC, path.join(OUT, "og-image.png"));
  console.log(`[build-site] og-image.png → ${OUT}/`);
} else {
  console.log(`[build-site] ⚠️ 未找到 ${OG_SRC}，分享卡片缩略图将缺失（og:image 失效）`);
}

// ---------- 4) index.html = 最新一期 ----------
const latest = dates[0];
const latestHtml = fs
  .readFileSync(path.join(OUT, latest, `${latest}.html`), "utf8")
  .replace(/href="\.\.\/archive\.html"/g, 'href="./archive.html"')
  .replace(/src="audio\//g, `src="${latest}/audio/`);
fs.writeFileSync(path.join(OUT, "index.html"), latestHtml, "utf8");
console.log(`[build-site] index.html  ← ${latest}/${latest}.html`);

// ---------- 5) archive.html = 全部期 ----------
const rows = dates
  .map((d) => {
    const size = (fs.statSync(path.join(OUT, d, `${d}.html`)).size / 1024).toFixed(0);
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
  <p class="meta">共 ${dates.length} 期 · 最新在前 · 生成于 ${todayInReportTz()}</p>
  <div class="top">
    <a href="./index.html">→ 最新一期（${latest}）</a>
  </div>
  <ul>
${rows}
  </ul>
</body>
</html>
`;
fs.writeFileSync(path.join(OUT, "archive.html"), archiveHtml, "utf8");
console.log(`[build-site] archive.html (${dates.length} 期)`);

// ---------- 6) .nojekyll：阻止 GitHub Pages 跑 Jekyll（否则下划线开头的目录会被吞）----------
fs.writeFileSync(path.join(OUT, ".nojekyll"), "", "utf8");
console.log(`[build-site] .nojekyll`);
