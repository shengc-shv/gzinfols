/**
 * 全站样式 · 段落：面板与 tab：主 tab / 摘要 / L2 子标签 / 时间拆分 / 文章卡 / 官方-媒体 band（2026-09-14 自 theme.ts 拆分）。
 *
 * 纯静态 CSS 片段、无插值。⚠️ 模板串内的 CSS 注释不得出现反引号（会截断模板）；
 * CSS 注释会进渲染产物，但注入点 stripCssComments 会剥离，源码注释是安全的。
 */
export const THEME_PANELS_CSS = `  /* ===== sticky primary tabs ===== */
  .tabs {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    gap: 0.15rem;
    margin: 0 0 1rem;
    padding: 0.7rem 0 0;
    border-bottom: 1px solid var(--rule);
    flex-wrap: wrap;
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    backdrop-filter: saturate(180%) blur(10px);
    -webkit-backdrop-filter: saturate(180%) blur(10px);
  }
  .tab {
    background: none;
    border: none;
    padding: 0.65rem 1.05rem 0.85rem;
    font-size: 0.95rem;
    font-weight: 500;
    color: var(--muted);
    cursor: pointer;
    border-bottom: 2.5px solid transparent;
    margin-bottom: -1px;
    font-family: inherit;
    transition: color 0.15s;
    border-radius: var(--r-sm) var(--r-sm) 0 0;
  }
  .tab:hover { color: var(--fg); }
  .tab.active {
    color: var(--cat, var(--accent));
    border-bottom-color: var(--cat, var(--accent));
    font-weight: 600;
  }
  .tab .count {
    font-size: 0.72rem;
    color: var(--muted);
    margin-left: 0.4rem;
    font-weight: 400;
  }
  /* 科创动态（T3 降权）：tab 弱化折叠——小号、浅色、末尾竖线分隔 */
  .tab.tab-fold {
    font-size: 0.82rem;
    color: var(--muted);
    opacity: 0.72;
    margin-left: 0.25rem;
    border-left: 1px solid var(--rule);
    padding-left: 1.1rem;
    border-radius: 0;
  }
  .tab.tab-fold.active { opacity: 1; }
  .panel { display: none; }
  .panel.active { display: block; animation: fade 0.25s ease; }
  @keyframes fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

  /* ===== digest (AI 简报) — compact ===== */
  .digest-category { margin-bottom: 1.2rem; }
  .category-header {
    display: flex;
    align-items: baseline;
    gap: 0.55rem;
    margin: 0 0 0.6rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--rule);
  }
  .category-title {
    font-size: 0.92rem;
    font-weight: 600;
    color: var(--fg);
    margin: 0;
    letter-spacing: 0.05em;
  }
  .category-count {
    font-size: 0.7rem;
    color: var(--muted);
    background: var(--card-alt);
    padding: 0.12rem 0.45rem;
    border-radius: 999px;
  }
  .brief-list {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.6rem;
  }
  @media (min-width: 720px) {
    .brief-list { grid-template-columns: 1fr 1fr; }
  }
  .brief {
    background: var(--card);
    border: 1px solid var(--rule);
    border-radius: var(--r-md);
    padding: 0.8rem 1rem;
    box-shadow: var(--shadow-sm);
    transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s;
  }
  .brief:hover {
    border-color: var(--muted);
    transform: translateY(-2px);
    box-shadow: var(--shadow-md);
  }
  .brief-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    margin-bottom: 0.35rem;
  }
  .brief-source {
    font-size: 0.72rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 500;
  }
  .brief-rank {
    font-size: 0.7rem;
    padding: 0.12rem 0.5rem;
    border-radius: 999px;
    font-weight: 600;
    flex-shrink: 0;
  }
  .brief-rank.high { background: var(--rank-high-bg); color: var(--rank-high-fg); }
  .brief-rank.mid  { background: var(--rank-mid-bg);  color: var(--rank-mid-fg); }
  .brief-rank.low  { background: var(--rank-low-bg);  color: var(--rank-low-fg); }
  .brief-title {
    font-size: 0.98rem;
    font-weight: 600;
    margin: 0 0 0.3rem;
    line-height: 1.4;
  }
  .brief-title a { color: var(--fg); text-decoration: none; }
  .brief-title a:hover { color: var(--link); text-decoration: underline; }
  .brief-summary {
    margin: 0;
    color: var(--fg-soft);
    font-size: 0.86rem;
    line-height: 1.6;
  }

  .editor-card {
    background: var(--card-alt);
    border-left: 3px solid var(--muted);
    border-radius: var(--r-md);
    padding: 1.1rem 1.4rem;
    margin: 1.6rem 0 1.3rem;
    box-shadow: var(--shadow-sm);
  }
  .editor-card .eyebrow { display: block; margin-bottom: 0.45rem; }
  .editor-text {
    margin: 0;
    font-size: 0.95rem;
    line-height: 1.75;
    color: var(--fg);
  }
  .keywords { display: flex; flex-wrap: wrap; gap: 0.45rem; margin: 0 0 1.6rem; }
  .keyword {
    background: var(--card);
    border: 1px solid var(--rule);
    color: var(--fg-soft);
    padding: 0.28rem 0.75rem;
    border-radius: 999px;
    font-size: 0.8rem;
    transition: border-color 0.15s, color 0.15s;
  }
  .keyword:hover { border-color: var(--muted); color: var(--fg); }

  /* ===== L2 sub-tabs ===== */
  .sub-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    margin: 1.1rem 0;
  }
  .sub-tab {
    background: var(--card);
    border: 1px solid var(--rule);
    padding: 0.5rem 1.05rem;
    border-radius: var(--r-sm);
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--fg-soft);
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s;
  }
  .sub-tab:hover { border-color: var(--muted); color: var(--fg); transform: translateY(-1px); }
  .sub-tab.active {
    background: var(--cat, var(--accent));
    color: #fff;
    border-color: transparent;
    box-shadow: var(--shadow-sm);
  }
  .sub-tab .count {
    font-size: 0.7rem;
    opacity: 0.75;
    margin-left: 0.4rem;
    font-weight: 400;
  }
  .sub-content { display: none; }
  .sub-content.active { display: block; animation: fade 0.2s ease; }
  .biz-tip {
    margin: 0 0 0.7rem;
    padding: 0.5rem 0.7rem;
    border-left: 3px solid var(--accent-brand);
    border-radius: 6px;
    background: var(--bg-elevated);
    font-size: 0.78rem;
    color: var(--fg-soft);
    line-height: 1.5;
  }

  /* ===== time split (当天 / 过去7天) ===== */
  .time-tabs {
    display: flex;
    gap: 0.4rem;
    margin: 0 0 1rem;
  }
  .time-tab {
    background: var(--card);
    border: 1px solid var(--rule);
    padding: 0.34rem 0.9rem;
    border-radius: 999px;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--fg-soft);
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s;
  }
  .time-tab:hover { border-color: var(--muted); color: var(--fg); }
  .time-tab.active {
    background: var(--cat, var(--fg));
    color: #fff;
    border-color: transparent;
  }
  .time-tab .count {
    font-size: 0.68rem;
    opacity: 0.8;
    margin-left: 0.35rem;
  }
  .time-content { display: none; }
  .time-content.active { display: block; }

  /* L3 source-tabs 已移除（2026-08-21：渲染只到子标签，子标签内为单一合并流） */

  /* ===== article cards in raw panels ===== */
  .article {
    background: var(--card);
    border: 1px solid var(--rule);
    border-radius: var(--r-md);
    padding: 1rem 1.15rem;
    margin-bottom: 0.7rem;
    box-shadow: var(--shadow-sm);
    transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
  }
  .article:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow-md);
    border-color: var(--muted);
  }
  .article:first-child { padding-top: 1rem; }
  .article:last-child { border-bottom: 1px solid var(--rule); }
  .article-title {
    font-size: 1.02rem;
    margin: 0 0 0.35rem;
    font-weight: 600;
    line-height: 1.45;
  }
  .article-title a { color: var(--fg); text-decoration: none; }
  .article-title a:hover { color: var(--link); text-decoration: underline; }
  .article-meta { color: var(--muted); font-size: 0.76rem; margin: 0 0 0.4rem; }
  .article-stats {
    color: var(--muted);
    font-size: 0.8rem;
    margin: 0 0 0.45rem;
    font-feature-settings: "tnum";
  }
  .article-excerpt {
    margin: 0;
    color: var(--fg-soft);
    font-size: 0.9rem;
    line-height: 1.62;
  }
  .article-summary {
    margin: 0.6rem 0 0;
    padding: 0.65rem 0.9rem;
    background: var(--card-alt);
    border-left: 3px solid var(--cat, var(--link));
    border-radius: 0 var(--r-sm) var(--r-sm) 0;
    font-size: 0.9rem;
    line-height: 1.62;
    color: var(--fg);
  }
  .summary-label {
    display: inline-block;
    font-size: 0.68rem;
    color: var(--link);
    margin-right: 0.4rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .empty {
    color: var(--muted);
    text-align: center;
    padding: 2.2rem 0;
    font-size: 0.9rem;
    background: var(--card);
    border: 1px dashed var(--rule);
    border-radius: var(--r-md);
  }

  /* ===== 合并流：官方 / 媒体 子标签 tab（任务三 #43 改版，长条带 → tab 页）===== */
  .band-tabs {
    display: flex; flex-wrap: wrap; gap: 0.4rem;
    margin: 0.2rem 0 0.55rem; padding-bottom: 0.3rem;
    border-bottom: 1px solid var(--rule);
  }
  .band-tab {
    display: inline-flex; align-items: center; gap: 0.35rem;
    border: 1px solid var(--rule); background: var(--bg);
    color: var(--fg-soft); font-size: 0.78rem; font-weight: 600;
    border-radius: 999px; padding: 0.28rem 0.75rem; cursor: pointer;
    font-family: inherit; transition: all 0.15s ease;
  }
  .band-tab:hover { border-color: var(--muted); color: var(--fg); transform: translateY(-1px); }
  .band-tab.active { background: var(--accent-brand); border-color: var(--accent-brand); color: #fff; }
  .band-tab .count { font-size: 0.7rem; opacity: 0.85; }
  .band-panel { display: none; }
  .band-panel.active { display: block; }

`;
