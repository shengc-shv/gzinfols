/**
 * 全站样式 · 段落：基础版式：报头 / masthead / 分类强调色接线（2026-09-14 自 theme.ts 拆分）。
 *
 * 纯静态 CSS 片段、无插值。⚠️ 模板串内的 CSS 注释不得出现反引号（会截断模板）；
 * CSS 注释会进渲染产物，但注入点 stripCssComments 会剥离，源码注释是安全的。
 */
export const THEME_BASE_CSS = `  /* ===== header / masthead ===== */
  header.report-header {
    margin-bottom: 0.5rem;
    padding-bottom: 1.4rem;
    border-bottom: 1px solid var(--rule);
  }
  .eyebrow {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.22em;
    color: var(--muted);
    font-weight: 500;
  }
  h1.report-title {
    font-family: Georgia, "Times New Roman", "Songti SC", "Noto Serif CJK SC", serif;
    font-size: 2.6rem;
    font-weight: 700;
    margin: 0.5rem 0 0.2rem;
    letter-spacing: -0.01em;
    line-height: 1.08;
  }
  .archive-link {
    display: inline-block;
    margin-top: 0.9rem;
    font-size: 0.85rem;
    color: var(--muted);
    text-decoration: none;
    border-bottom: 1px dashed var(--rule);
    padding-bottom: 1px;
    transition: color 0.15s, border-color 0.15s;
  }
  .archive-link:hover { color: var(--accent); border-bottom-style: solid; }

  /* per-category accent wiring */
  .panel[data-panel="tech"] { --cat: var(--c-tech); }
  .panel[data-panel="trading"] { --cat: var(--c-trading); }
  .panel[data-panel="finance"] { --cat: var(--c-finance); }
  .panel[data-panel="gd-ipo"] { --cat: var(--c-gdipo); }
  .panel[data-panel="ipo"] { --cat: var(--c-ipo); }
  .panel[data-panel="gz"] { --cat: var(--c-gz); }
  .tab[data-tab="tech"] { --cat: var(--c-tech); }
  .tab[data-tab="trading"] { --cat: var(--c-trading); }
  .tab[data-tab="finance"] { --cat: var(--c-finance); }
  .tab[data-tab="gd-ipo"] { --cat: var(--c-gdipo); }
  .tab[data-tab="ipo"] { --cat: var(--c-ipo); }
  .tab[data-tab="gz"] { --cat: var(--c-gz); }

  .hero-card {
    margin-top: 1.4rem;
    background: linear-gradient(135deg, var(--hero-grad-from) 0%, var(--hero-grad-to) 100%);
    border: 1px solid var(--rule);
    border-left: 4px solid var(--c-tech);
    padding: 1.1rem 1.5rem;
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-sm);
  }
  .hero-eyebrow {
    font-size: 0.7rem;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--muted);
    font-weight: 500;
  }
  .hero-headline {
    font-size: 1.3rem;
    font-weight: 600;
    margin: 0.4rem 0 0;
    line-height: 1.5;
    color: var(--fg);
  }
  .overview-card {
    margin: 0.8rem 0 0;
    padding: 0.8rem 1.2rem;
    background: var(--card-alt);
    border-radius: var(--r-md);
    border-left: 3px solid var(--muted);
  }
  .overview-card .eyebrow { display: block; margin-bottom: 0.3rem; }
  .overview-text {
    margin: 0;
    font-size: 0.9rem;
    line-height: 1.7;
    color: var(--fg-soft);
  }

`;
