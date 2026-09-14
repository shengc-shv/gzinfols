/**
 * 全站样式 · 段落：设计令牌：:root 变量与深色模式覆盖（2026-09-14 自 theme.ts 拆分）。
 *
 * 纯静态 CSS 片段、无插值。⚠️ 模板串内的 CSS 注释不得出现反引号（会截断模板）；
 * CSS 注释会进渲染产物，但注入点 stripCssComments 会剥离，源码注释是安全的。
 */
export const THEME_TOKENS_CSS = `
  :root {
    --bg: #f6f5f3;
    --bg-elevated: #ffffff;
    --fg: #1a1a1f;
    --fg-soft: #4a4a52;
    --muted: #797986;
    --rule: #e7e5e1;
    --card: #ffffff;
    --card-alt: #f1efec;
    --link: #2f4cdd;
    --accent: #1a1a1f;
    --accent-fg: #ffffff;
    --accent-brand: #e60012;
    --rank-high-bg: #fde8e8;
    --rank-high-fg: #c01c1c;
    --rank-mid-bg: #fdf0d9;
    --rank-mid-fg: #9a5b09;
    --rank-low-bg: #e6e9fd;
    --rank-low-fg: #3b36a8;
    --c-tech: #4f46e5;
    --c-trading: #0d9488;
    --c-finance: #d97706;
    --c-gdipo: #e11d48;
    --c-ipo: #7c3aed;
    --c-gz: #059669;
    --c-pol: #2f6fed;
    --hero-grad-from: #f6f5f3;
    --hero-grad-to: #efedea;
    --r-sm: 0.5rem;
    --r-md: 0.75rem;
    --r-lg: 1rem;
    --shadow-sm: 0 1px 2px rgba(20, 20, 30, 0.05), 0 1px 3px rgba(20, 20, 30, 0.06);
    --shadow-md: 0 6px 16px rgba(20, 20, 30, 0.09);
    --shadow-lg: 0 14px 32px rgba(20, 20, 30, 0.12);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0d11;
      --bg-elevated: #15191f;
      --fg: #f3f4f6;
      --fg-soft: #c2c6cf;
      --muted: #8b909c;
      --rule: #262b33;
      --card: #15191f;
      --card-alt: #1b2027;
      --link: #8aa0ff;
    --accent: #f3f4f6;
    --accent-fg: #0b0d11;
    --accent-brand: #ff5a5f;
      --rank-high-bg: rgba(239, 68, 68, 0.16);
      --rank-high-fg: #fca5a5;
      --rank-mid-bg: rgba(245, 158, 11, 0.16);
      --rank-mid-fg: #fcd34d;
      --rank-low-bg: rgba(99, 102, 241, 0.16);
      --rank-low-fg: #a5b4fc;
      --c-tech: #818cf8;
      --c-trading: #2dd4bf;
      --c-finance: #fbbf24;
      --c-gdipo: #fb7185;
      --c-ipo: #a78bfa;
      --c-gz: #34d399;
      --c-pol: #5b8def;
      --hero-grad-from: #15191f;
      --hero-grad-to: #0b0d11;
      --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.4);
      --shadow-md: 0 6px 16px rgba(0, 0, 0, 0.5);
      --shadow-lg: 0 14px 32px rgba(0, 0, 0, 0.55);
    }
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
      "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    line-height: 1.62;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  ::selection { background: rgba(79, 70, 229, 0.22); }
  main { max-width: 1040px; margin: 0 auto; padding: 2.75rem 1.5rem 4rem; }

`;
