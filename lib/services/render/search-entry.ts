/**
 * 「搜索」入口卡片（2026-09-17 用户需求：移到「今日语音播报」正下方，醒目、可点、有反馈）。
 *
 * 为什么是独立小组件而不是塞进 full.ts：redchip-panel 同款考量——新面板独立成文件，
 * 避免 god file 再膨胀；CSS 以常量导出，由 full.ts 拼进补丁样式区（不动 THEME_CSS 巨型串）。
 *
 * 链接路径（**站点相对**）：报告页位于 `site/<date>/<date>.html`，检索页在 `site/search.html`，
 * 故写 `../search.html`。⚠️ 发布根副本（`site/index.html`）里 `..` 会越界——
 * `build-site` 必须同步改写为 `./search.html`（与 `../archive.html`、`../redchip/` 同源事故，
 * 链接自检会兜底）。整树拷贝到任何子目录（如灰度 gray/）时天然自洽。
 */

/** 入口卡片 HTML。无音频的日子它出现在页面最顶部（报头上方），依然是第一眼可见的入口。 */
export function renderSearchEntry(): string {
  return `<a class="search-entry" href="../search.html" aria-label="打开全期检索与两期对比">
    <span class="se-ic" aria-hidden="true">🔍</span>
    <span class="se-main">
      <span class="se-title">搜索全期简报</span>
      <span class="se-sub">关键词 · 板块 · 主题标签 · 两期对比</span>
    </span>
    <span class="se-arrow" aria-hidden="true">→</span>
  </a>`;
}

/**
 * 入口样式。视觉与播放器卡片同族（--accent-brand 色），但更轻：
 * hover = 底色加深 + 边框变实色 + 箭头右移；active = 轻微下压（触摸反馈）。
 */
export const SEARCH_ENTRY_CSS = `
  /* 搜索入口（2026-09-17）：今日语音播报正下方，收听时可快速点开检索 */
  .search-entry { display: flex; align-items: center; gap: 0.6rem; margin: 0 0 1.4rem;
    padding: 0.6rem 0.9rem; border-radius: var(--r-lg);
    border: 1px dashed color-mix(in srgb, var(--accent-brand) 45%, var(--rule));
    background: color-mix(in srgb, var(--accent-brand) 5%, var(--bg));
    color: var(--fg); text-decoration: none;
    transition: background-color .15s ease, border-color .15s ease; }
  .search-entry:hover, .search-entry:focus-visible { background: color-mix(in srgb, var(--accent-brand) 11%, var(--bg));
    border-color: var(--accent-brand); border-style: solid; }
  .search-entry:active { transform: translateY(1px); }
  .search-entry .se-ic { font-size: 1rem; }
  .search-entry .se-main { display: flex; flex-direction: column; min-width: 0; }
  .search-entry .se-title { font-weight: 600; font-size: 0.9rem; }
  .search-entry .se-sub { font-size: 0.72rem; color: var(--muted); }
  .search-entry .se-arrow { margin-left: auto; color: var(--accent-brand);
    transition: transform .15s ease; }
  .search-entry:hover .se-arrow { transform: translateX(3px); }
`;
