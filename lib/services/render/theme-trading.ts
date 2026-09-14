/**
 * 全站样式 · 段落：交易面板（加密 widget 样式已于 2026-09-14 移除）（2026-09-14 自 theme.ts 拆分）。
 *
 * 纯静态 CSS 片段、无插值。⚠️ 模板串内的 CSS 注释不得出现反引号（会截断模板）；
 * CSS 注释会进渲染产物，但注入点 stripCssComments 会剥离，源码注释是安全的。
 */
export const THEME_TRADING_CSS = `  /* ===== trading panel ===== */
  /* 2026-09-14：移除此处的加密 widget 样式与无引用副作用 ——
     原块含 .crypto-widgets / .crypto-widget / .widget-label / .widget-value / .widget-sub，
     其中 .crypto-widget.fg-fear*「恐慌贪婪」系列直接违反「加密资产零容忍」
     （2026-09-12 用户拍板，永久）；且整组样式在本仓**无任何渲染方调用**
     （gzinfo 移植残留的死 CSS）。新增静态断言见 tests/compliance-crypto.test.ts。 */

  .trading-overview-card {
    margin: 0 0 1.6rem;
    padding: 1.1rem 1.4rem;
    background: var(--card);
    border-radius: var(--r-md);
    border-left: 4px solid var(--c-trading);
    box-shadow: var(--shadow-sm);
  }
  .trading-overview-card .eyebrow { display: block; margin-bottom: 0.45rem; }
  .trading-overview-text { font-size: 0.92rem; line-height: 1.75; color: var(--fg-soft); margin: 0; }

  .trading-section-title {
    font-size: 0.98rem;
    font-weight: 600;
    margin: 1.6rem 0 0.9rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--rule);
    color: var(--fg);
    letter-spacing: 0.05em;
  }

  .trading-picks {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.65rem;
  }
  @media (min-width: 720px) {
    .trading-picks { grid-template-columns: 1fr 1fr; }
  }
  .trading-pick {
    background: var(--card);
    border: 1px solid var(--rule);
    border-left: 4px solid var(--muted);
    border-radius: var(--r-md);
    padding: 0.85rem 1.1rem;
    box-shadow: var(--shadow-sm);
    transition: transform 0.15s, box-shadow 0.15s;
  }
  .trading-pick:hover { transform: translateY(-2px); box-shadow: var(--shadow-md); }
  .trading-pick.stance-bull { border-left-color: #16a34a; }
  .trading-pick.stance-bear { border-left-color: #dc2626; }
  .trading-pick.stance-neutral { border-left-color: var(--muted); }
  .pick-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    margin-bottom: 0.5rem;
  }
  .pick-symbol-block {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .pick-symbol { font-weight: 700; font-size: 1rem; color: var(--fg); }
  .pick-name { color: var(--muted); font-size: 0.82rem; }
  .pick-stance {
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.2rem 0.65rem;
    border-radius: 999px;
    white-space: nowrap;
  }
  .pick-stance-bull { background: rgba(22,163,74,0.12); color: #16a34a; }
  .pick-stance-bear { background: rgba(220,38,38,0.12); color: #dc2626; }
  .pick-stance-neutral { background: var(--card-alt); color: var(--muted); }
  .pick-rationale { margin: 0; font-size: 0.88rem; line-height: 1.65; color: var(--fg-soft); }

  .trading-group-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    margin: 0.7rem 0 1.3rem;
  }
  .trading-group-tab {
    background: var(--card);
    border: 1px solid var(--rule);
    padding: 0.5rem 1rem;
    border-radius: var(--r-sm);
    font-size: 0.88rem;
    font-weight: 500;
    color: var(--fg-soft);
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s;
  }
  .trading-group-tab:hover { border-color: var(--muted); color: var(--fg); transform: translateY(-1px); }
  .trading-group-tab.active {
    background: var(--c-trading);
    color: #fff;
    border-color: transparent;
    box-shadow: var(--shadow-sm);
  }
  .trading-group-tab .count {
    font-size: 0.7rem;
    opacity: 0.8;
    margin-left: 0.4rem;
    font-weight: 400;
  }
  .trading-group-content { display: none; }
  .trading-group-content.active { display: block; animation: fade 0.2s ease; }

  .ticker-card {
    background: var(--card);
    border: 1px solid var(--rule);
    border-radius: var(--r-md);
    padding: 0.9rem 1.15rem;
    margin-bottom: 0.7rem;
    box-shadow: var(--shadow-sm);
    transition: transform 0.15s, box-shadow 0.15s, border-color 0.15s;
  }
  .ticker-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-md); border-color: var(--muted); }
  .ticker-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.7rem;
  }
  .ticker-id { min-width: 0; }
  .ticker-symbol { margin: 0; font-size: 1.02rem; font-weight: 700; font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; }
  .ticker-name { margin: 0.15rem 0 0; font-size: 0.82rem; color: var(--muted); }
  .ticker-price-block { text-align: right; flex-shrink: 0; }
  .ticker-price { display: block; font-size: 1.08rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .ticker-pct { display: inline-block; font-size: 0.84rem; font-weight: 500; margin-top: 0.15rem; font-variant-numeric: tabular-nums; }
  .ticker-pct.positive, .positive { color: #16a34a; }
  .ticker-pct.negative, .negative { color: #dc2626; }

  .ticker-indicators {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.4rem 0.9rem;
    margin: 0;
    font-size: 0.82rem;
    color: var(--fg-soft);
  }
  @media (min-width: 720px) {
    .ticker-indicators { grid-template-columns: repeat(3, 1fr); }
  }
  .ticker-indicators > div { display: flex; gap: 0.4rem; align-items: baseline; min-width: 0; }
  .ticker-indicators dt { color: var(--muted); font-size: 0.74rem; margin: 0; white-space: nowrap; }
  .ticker-indicators dd { margin: 0; font-variant-numeric: tabular-nums; font-weight: 500; color: var(--fg); }
  .trend-bullish { color: #16a34a; }
  .trend-bearish { color: #dc2626; }
  .trend-neutral { color: var(--muted); }
  .rsi-overbought { color: #d97706; }
  .rsi-oversold { color: #2563eb; }

  .ticker-signals {
    margin-top: 0.7rem;
    padding-top: 0.6rem;
    border-top: 1px dashed var(--rule);
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .signal-pill {
    font-size: 0.72rem;
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
    font-weight: 500;
  }
  .signal-pill.tone-bull { background: rgba(22,163,74,0.13); color: #166534; }
  .signal-pill.tone-bear { background: rgba(220,38,38,0.13); color: #991b1b; }
  .signal-pill.tone-caution { background: rgba(217,119,6,0.15); color: #92400e; }
  @media (prefers-color-scheme: dark) {
    .signal-pill.tone-bull { color: #4ade80; }
    .signal-pill.tone-bear { color: #fca5a5; }
    .signal-pill.tone-caution { color: #fcd34d; }
    .trend-bullish, .positive, .ticker-pct.positive { color: #4ade80; }
    .trend-bearish, .negative, .ticker-pct.negative { color: #fca5a5; }
    .rsi-overbought { color: #fcd34d; }
    .rsi-oversold { color: #93c5fd; }
    .trading-pick.stance-bull { border-left-color: #4ade80; }
    .trading-pick.stance-bear { border-left-color: #fca5a5; }
    .pick-stance-bull { background: rgba(74,222,128,0.15); color: #4ade80; }
    .pick-stance-bear { background: rgba(252,165,165,0.15); color: #fca5a5; }
  }
  .signal-age { opacity: 0.7; font-weight: 400; }

  .trading-risk {
    margin: 1.6rem 0 0;
    padding: 0.95rem 1.3rem;
    background: var(--card);
    border-radius: var(--r-md);
    border-left: 4px solid #d97706;
    box-shadow: var(--shadow-sm);
  }
  .trading-risk .eyebrow { display: block; margin-bottom: 0.4rem; }
  .trading-risk p { margin: 0; font-size: 0.82rem; line-height: 1.65; color: var(--fg-soft); }

  footer {
    margin-top: 2.75rem;
    border-top: 1px solid var(--rule);
    padding-top: 1.2rem;
    color: var(--muted);
    font-size: 0.82rem;
  }

`;
