/**
 * 全站样式 · 段落：横滑卡片：今日必读 / 商机洞察 / 风险预警 / 广东IPO / 昨日股市（2026-09-14 自 theme.ts 拆分）。
 *
 * 纯静态 CSS 片段、无插值。⚠️ 模板串内的 CSS 注释不得出现反引号（会截断模板）；
 * CSS 注释会进渲染产物，但注入点 stripCssComments 会剥离，源码注释是安全的。
 */
export const THEME_CARDS_CSS = `  /* ===== 执行摘要板块（今日必读 + 商机提示，移动端优先折叠）===== */
  .exec-summary {
    margin: 1rem 0 0.4rem;
    border: 1px solid color-mix(in srgb, var(--accent-brand) 22%, transparent);
    border-left: 4px solid var(--accent-brand);
    border-radius: 14px;
    padding: 0.85rem 1rem;
    background: color-mix(in srgb, var(--accent-brand) 5%, var(--bg));
    box-shadow: var(--shadow-md);
  }
  .exec-head { display: flex; align-items: baseline; gap: 0.6rem; margin-bottom: 0.55rem; }
  .exec-title { margin: 0; font-size: 1.02rem; color: var(--fg); letter-spacing: 0.02em; }
  .exec-sub { font-size: 0.72rem; color: var(--muted); }
  .exec-col-title { margin: 0 0 0.45rem; font-size: 0.8rem; color: var(--muted); font-weight: 600; }

  /* 今日必读：横向滑动卡片（Apple News 风），桌面转为 5 列网格 */
  .exec-must { position: relative; margin-bottom: 0.5rem; }
  .must-scroller {
    list-style: none; margin: 0; padding: 0 0.75rem 0.5rem 0;
    display: flex; flex-direction: row; gap: 0.5rem;
    overflow-x: auto; -webkit-overflow-scrolling: touch;
    scroll-snap-type: x mandatory;
    scrollbar-width: thin; scrollbar-color: var(--rule) transparent;
  }
  .must-scroller::-webkit-scrollbar { height: 5px; }
  .must-scroller::-webkit-scrollbar-thumb { background: var(--rule); border-radius: 4px; }
  .must-card {
    flex: 0 0 auto; width: 80vw; max-width: 300px;
    display: flex; gap: 0.55rem; align-items: flex-start;
  }
  /* N 层：top 3 必读卡片 — "今日三件事" 视觉强调（行长音频重点） */
  .must-card.must-top {
    background: color-mix(in srgb, var(--accent-brand) 6%, var(--card));
    border-left: 3px solid var(--accent-brand);
  }
  .must-top-badge {
    display: inline-block; margin-left: 0.4rem; padding: 1px 6px;
    font-size: 0.66rem; font-weight: 700; color: white;
    background: var(--accent-brand); border-radius: 3px;
    vertical-align: middle;
  }
    border: 1px solid var(--rule); border-radius: 12px;
    padding: 0.6rem 0.75rem; background: var(--bg-elevated);
    box-shadow: var(--shadow-sm);
  }
  /* 移动端横向滑动提示：右侧渐隐遮罩，暗示右侧还有更多必读卡片 */
  .exec-must::after {
    content: ""; position: absolute; top: 1.7rem; right: 0; bottom: 0.5rem;
    width: 3.25rem; pointer-events: none; z-index: 3;
    background: linear-gradient(to left, color-mix(in srgb, var(--accent-brand) 16%, var(--bg)) 0%, color-mix(in srgb, var(--accent-brand) 4%, transparent) 55%, transparent 100%);
  }
  /* 今日必读标题旁的滑动提示（移动端横向滑动时可见；桌面网格下隐藏） */
  .must-hint-inline {
    display: inline-block; margin-left: 0.45rem; vertical-align: middle;
    font-size: 0.68rem; font-weight: 500; color: var(--accent-brand);
    white-space: nowrap;
  }
  .must-hint-inline .hint-arrow { display: inline-block; animation: nudge 1.1s ease-in-out infinite; }
  @keyframes nudge { 0%, 100% { transform: translateX(0); } 50% { transform: translateX(4px); } }
  .must-link { text-decoration: none; color: inherit; border-radius: 8px; transition: border-color 0.15s ease; }
  .must-link:hover strong { color: var(--accent-brand); }
  .must-card:hover { border-color: color-mix(in srgb, var(--accent-brand) 40%, var(--rule)); }
  .must-index {
    flex: none; width: 1.2rem; height: 1.2rem; border-radius: 50%;
    background: var(--accent-brand); color: #fff; font-size: 0.72rem; font-weight: 700;
    display: inline-flex; align-items: center; justify-content: center; margin-top: 0.05rem;
  }
  .must-body { display: flex; flex-direction: column; min-width: 0; }
  .must-body strong { font-size: 0.85rem; color: var(--fg); font-weight: 600; line-height: 1.35; }
  .must-why {
    font-size: 0.74rem; color: var(--fg-soft); line-height: 1.45; margin-top: 0.2rem;
  }
  @media (min-width: 720px) {
    /* 必读卡片自适应列数：不足 5 条时不再留白撑开（auto-fit 按条数收窄），
       最多 5 列；避免「执行摘要条数少 → 版面被商机洞察撑大」的失衡。 */
    .must-scroller { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); overflow: visible; padding-bottom: 0; padding-right: 0; scroll-snap-type: none; }
    .must-card { width: auto; max-width: none; }
    /* 桌面转为网格后无横向滑动，渐隐遮罩与滑动提示均隐藏 */
    .exec-must::after { display: none; }
    .must-hint-inline { display: none; }
  }

  /* 商机洞察：横向滑动卡片（与「今日必读」「昨日股市」同款），桌面转网格 */
  .exec-insights { position: relative; margin-top: 0.2rem; }
  .insight-hint-inline {
    display: inline-block; margin-left: 0.45rem; vertical-align: middle;
    font-size: 0.68rem; font-weight: 500; color: var(--accent-brand);
    white-space: nowrap;
  }
  .insight-hint-inline .hint-arrow { display: inline-block; animation: nudge 1.1s ease-in-out infinite; }
  .insight-scroller {
    display: flex; flex-direction: row; gap: 0.5rem;
    overflow-x: auto; -webkit-overflow-scrolling: touch;
    scroll-snap-type: x mandatory;
    scrollbar-width: thin; scrollbar-color: var(--rule) transparent;
    padding: 0 0.75rem 0.5rem 0;
  }
  .insight-scroller::-webkit-scrollbar { height: 5px; }
  .insight-scroller::-webkit-scrollbar-thumb { background: var(--rule); border-radius: 4px; }
  .insight-scroller .insight {
    flex: 0 0 auto; width: 82vw; max-width: 320px;
    box-sizing: border-box;
  }
  /* 移动端横向滑动提示：右侧渐隐遮罩，暗示右侧还有更多商机卡片 */
  .exec-insights::after {
    content: ""; position: absolute; top: 1.7rem; right: 0; bottom: 0.5rem;
    width: 3.25rem; pointer-events: none; z-index: 3;
    background: linear-gradient(to left, color-mix(in srgb, var(--accent-brand) 16%, var(--bg)) 0%, color-mix(in srgb, var(--accent-brand) 4%, transparent) 55%, transparent 100%);
  }
  .insight-topic { margin: 0 0 0.3rem; font-size: 0.85rem; color: var(--c-finance); font-weight: 700; }
  .insight-impact, .insight-action { margin: 0.2rem 0 0; font-size: 0.78rem; color: var(--fg-soft); line-height: 1.55; }
  @media (min-width: 720px) {
    .insight-scroller { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); overflow: visible; padding-bottom: 0; padding-right: 0; scroll-snap-type: none; }
    .insight-scroller .insight { width: auto; max-width: none; }
    .exec-insights::after { display: none; }
    .insight-hint-inline { display: none; }
  }

  /* —— M 层：风险预警卡片（与 insight 同结构，红/警示色调）—— */
  .exec-risk { position: relative; margin-top: 0.5rem; }
  .risk-hint-inline { display: inline; color: var(--muted); font-size: 0.78rem; margin-left: 0.4rem; }
  .risk-scroller {
    list-style: none; margin: 0; padding: 0 0.75rem 0.5rem 0;
    display: flex; flex-direction: row; gap: 0.5rem;
    overflow-x: auto; -webkit-overflow-scrolling: touch;
    scroll-snap-type: x mandatory;
    scrollbar-width: thin; scrollbar-color: var(--rule) transparent;
  }
  .risk-scroller::-webkit-scrollbar { height: 5px; }
  .risk-scroller::-webkit-scrollbar-thumb { background: var(--rule); border-radius: 4px; }
  .risk-scroller .risk-card {
    flex: 0 0 auto; width: 82vw; max-width: 320px;
    box-sizing: border-box;
    background: color-mix(in srgb, #d9534f 4%, var(--card));
    border-left: 3px solid #d9534f;
    padding: 0.75rem 0.85rem;
    border-radius: 6px;
  }
  .risk-card .risk-header { font-size: 0.72rem; color: #a94442; font-weight: 700; margin-bottom: 0.3rem; display: flex; align-items: center; gap: 0.4rem; }
  .risk-card h3 { font-size: 0.92rem; margin: 0 0 0.35rem; color: #a94442; }
  .risk-card p { margin: 0.2rem 0; font-size: 0.78rem; color: var(--fg-soft); line-height: 1.55; }
  .risk-card p b { color: #d9534f; }
  .risk-source-badge { display: inline-block; padding: 1px 6px; font-size: 0.65rem; border-radius: 3px; font-weight: 600; }
  .risk-source-t1 { background: #d9534f; color: white; }
  .risk-source-t1\.5 { background: #f0ad4e; color: white; }
  .risk-source-t2 { background: #ddd; color: #666; }
  .risk-srcs { display: inline-flex; gap: 4px; margin-left: auto; }
  .risk-src { color: var(--muted); font-size: 0.72rem; padding: 0 4px; border-radius: 3px; border: 1px solid var(--rule); text-decoration: none; }
  .exec-risk::after {
    content: ""; position: absolute; top: 1.7rem; right: 0; bottom: 0.5rem;
    width: 3.25rem; pointer-events: none; z-index: 3;
    background: linear-gradient(to left, color-mix(in srgb, #d9534f 8%, var(--bg)) 0%, color-mix(in srgb, #d9534f 2%, transparent) 55%, transparent 100%);
  }
  @media (min-width: 720px) {
    .risk-scroller { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); overflow: visible; padding-bottom: 0; padding-right: 0; scroll-snap-type: none; }
    .risk-scroller .risk-card { width: auto; max-width: none; }
    .exec-risk::after { display: none; }
    .risk-hint-inline { display: none; }
  }

  /* —— 广东 IPO 横滑卡（任务六）：与「今日必读/商机洞察/风险预警」同款 —— */
  .exec-ipo { position: relative; margin-top: 0.5rem; }
  .ipo-hint-inline {
    display: inline-block; margin-left: 0.45rem; vertical-align: middle;
    font-size: 0.68rem; font-weight: 500; color: var(--c-gdipo);
    white-space: nowrap;
  }
  .ipo-hint-inline .hint-arrow { display: inline-block; animation: nudge 1.1s ease-in-out infinite; }
  .ipo-scroller {
    list-style: none; margin: 0; padding: 0 0.75rem 0.5rem 0;
    display: flex; flex-direction: row; gap: 0.5rem;
    overflow-x: auto; -webkit-overflow-scrolling: touch;
    scroll-snap-type: x mandatory;
    scrollbar-width: thin; scrollbar-color: var(--rule) transparent;
  }
  .ipo-scroller::-webkit-scrollbar { height: 5px; }
  .ipo-scroller::-webkit-scrollbar-thumb { background: var(--rule); border-radius: 4px; }
  .ipo-card {
    flex: 0 0 auto; width: 82vw; max-width: 320px;
    box-sizing: border-box;
    border: 1px solid color-mix(in srgb, var(--c-gdipo) 30%, var(--rule));
    border-left: 3px solid var(--c-gdipo);
    border-radius: 12px; padding: 0.6rem 0.75rem;
    background: color-mix(in srgb, var(--c-gdipo) 4%, var(--card));
    box-shadow: var(--shadow-sm);
  }
  .ipo-card-head { display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.3rem; }
  .ipo-name { font-size: 0.86rem; font-weight: 700; color: var(--fg); line-height: 1.3; }
  .ipo-stage {
    flex: none; font-size: 0.64rem; font-weight: 600; padding: 1px 6px; border-radius: 3px;
    color: #fff; background: var(--c-gdipo);
  }
  .ipo-stage--stage-listed { background: #0ea5e9; }
  .ipo-stage--stage-registered { background: #16a34a; }
  .ipo-stage--stage-reviewing { background: #d97706; }
  .ipo-stage--stage-tutoring { background: var(--c-gdipo); }
  .ipo-biz { margin: 0.2rem 0 0.35rem; font-size: 0.74rem; color: var(--fg-soft); line-height: 1.5; }
  .ipo-foot { display: flex; align-items: center; justify-content: space-between; gap: 0.4rem; font-size: 0.68rem; color: var(--muted); }
  .ipo-src { color: var(--c-gdipo); text-decoration: none; }
  .ipo-src:hover { text-decoration: underline; }
  /* 红筹线索标识（2026-09-15）：徽章 + 「新」角标 + 变更小字 + 报告入口。
     红线「线索 ≠ 结论」：文案恒为「…线索」，不得显示为已确认结论。 */
  .ipo-card--redchip { border-color: color-mix(in srgb, var(--c-redchip) 34%, var(--rule)); border-left-color: var(--c-redchip); background: color-mix(in srgb, var(--c-redchip) 5%, var(--card)); }
  .ipo-redchip {
    flex: none; font-size: 0.64rem; font-weight: 600; padding: 1px 6px; border-radius: 3px;
    color: #fff; background: var(--c-redchip);
  }
  .ipo-redchip--unverified { color: var(--c-redchip); background: transparent; border: 1px solid color-mix(in srgb, var(--c-redchip) 55%, transparent); }
  .ipo-new { flex: none; font-size: 0.6rem; font-weight: 700; line-height: 1; padding: 2px 4px; border-radius: 3px; color: #fff; background: var(--c-redchip-new); }
  .ipo-rc-changed { flex: none; font-size: 0.62rem; color: var(--c-redchip); }
  .ipo-report { display: inline-block; margin-top: 0.3rem; font-size: 0.7rem; color: var(--c-redchip); text-decoration: none; }
  .ipo-report:hover { text-decoration: underline; }
  /* 红筹线索面板（2026-09-15 §5.1）：常驻区块，独立于五板块 tab */
  .redchip-panel { margin: 1.25rem 0 0; padding: 0.9rem 1rem; border: 1px solid color-mix(in srgb, var(--c-redchip) 26%, var(--rule)); border-radius: 12px; background: color-mix(in srgb, var(--c-redchip) 4%, var(--card)); }
  .redchip-title { display: flex; align-items: center; gap: 0.4rem; font-size: 0.95rem; font-weight: 700; color: var(--fg); margin: 0 0 0.6rem; }
  .redchip-count { font-size: 0.7rem; font-weight: 600; padding: 1px 6px; border-radius: 10px; color: #fff; background: var(--c-redchip); }
  .redchip-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.6rem; }
  @media (min-width: 720px) { .redchip-list { grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); } }
  .redchip-item { border: 1px solid color-mix(in srgb, var(--c-redchip) 22%, var(--rule)); border-left: 3px solid var(--c-redchip); border-radius: 10px; padding: 0.55rem 0.7rem; background: var(--card); }
  .redchip-item--unverified { border-left-style: dashed; }
  .redchip-head { display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; margin-bottom: 0.3rem; }
  .redchip-name { font-size: 0.84rem; font-weight: 700; color: var(--fg); }
  .redchip-unmatched { font-size: 0.62rem; color: var(--muted); border: 1px dashed var(--rule); border-radius: 3px; padding: 0 4px; }
  .redchip-facts { margin: 0 0 0.25rem; font-size: 0.72rem; color: var(--fg-soft); }
  .redchip-evid { margin: 0; font-size: 0.7rem; color: var(--muted); }
  .redchip-changed { margin: 0.25rem 0 0; font-size: 0.7rem; color: var(--c-redchip); }
  .redchip-foot { display: flex; gap: 0.8rem; margin-top: 0.35rem; }
  .redchip-foot .ipo-report { margin-top: 0; }
  .redchip-note { margin: 0.6rem 0 0; font-size: 0.68rem; color: var(--muted); line-height: 1.5; }
  .exec-ipo::after {
    content: ""; position: absolute; top: 1.7rem; right: 0; bottom: 0.5rem;
    width: 3.25rem; pointer-events: none; z-index: 3;
    background: linear-gradient(to left, color-mix(in srgb, var(--c-gdipo) 16%, var(--bg)) 0%, color-mix(in srgb, var(--c-gdipo) 4%, transparent) 55%, transparent 100%);
  }
  @media (min-width: 720px) {
    .ipo-scroller { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); overflow: visible; padding-bottom: 0; padding-right: 0; scroll-snap-type: none; }
    .ipo-card { width: auto; max-width: none; }
    .exec-ipo::after { display: none; }
    .ipo-hint-inline { display: none; }
  }

  /* —— 昨日股市复盘三卡（参考区）：横向滑动卡片，与「今日必读」同款 —— */
  .stock-recap { margin-top: 0.5rem; }
  .stock-must { position: relative; margin-bottom: 0.3rem; }
  .stock-note { margin: 0 0 0.45rem; font-size: 0.72rem; color: var(--muted); }
  .stock-scroller {
    list-style: none; margin: 0; padding: 0 0.75rem 0.5rem 0;
    display: flex; flex-direction: row; gap: 0.5rem;
    overflow-x: auto; -webkit-overflow-scrolling: touch;
    scroll-snap-type: x mandatory;
    scrollbar-width: thin; scrollbar-color: var(--rule) transparent;
  }
  .stock-scroller::-webkit-scrollbar { height: 5px; }
  .stock-scroller::-webkit-scrollbar-thumb { background: var(--rule); border-radius: 4px; }
  .stock-card {
    flex: 0 0 auto; width: 82vw; max-width: 320px;
    border: 1px solid var(--rule); border-radius: 12px;
    padding: 0.6rem 0.75rem; background: var(--bg-elevated);
    box-shadow: var(--shadow-sm); border-top: 3px solid var(--c-trading);
    display: flex; flex-direction: column; gap: 0.4rem; min-width: 0;
  }
  .stock-card--us { border-top-color: var(--c-pol); }
  .stock-card--a { border-top-color: var(--c-gz); }
  .stock-card--hk { border-top-color: var(--c-ipo); }
  .stock-card-head {
    font-size: 0.9rem; font-weight: 700; color: var(--fg);
    letter-spacing: 0.04em; display: flex; align-items: center; gap: 0.35rem;
  }
  .stock-card-head::before {
    content: ""; width: 0.5rem; height: 0.5rem; border-radius: 50%;
    background: var(--c-trading); flex: none;
  }
  .stock-card--us .stock-card-head::before { background: var(--c-pol); }
  .stock-card--a .stock-card-head::before { background: var(--c-gz); }
  .stock-card--hk .stock-card-head::before { background: var(--c-ipo); }
  .stock-overview { margin: 0; font-size: 0.8rem; color: var(--fg-soft); line-height: 1.6; }
  .stock-source-report {
    display: inline-block; margin: 0.35rem 0 0.1rem; font-size: 0.74rem; line-height: 1.4;
    color: var(--accent); text-decoration: none; border: 1px solid var(--accent-soft, var(--accent));
    border-radius: 6px; padding: 0.22rem 0.5rem; background: var(--accent-bg, transparent);
    max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .stock-source-report:hover { text-decoration: underline; opacity: 0.85; }
  .stock-sectors { margin-top: 0.1rem; }
  .stock-sec-label {
    display: block; font-size: 0.68rem; color: var(--muted); font-weight: 600;
    margin-bottom: 0.25rem; letter-spacing: 0.03em;
  }
  .stock-sectors ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.28rem; }
  .stock-sectors li {
    font-size: 0.76rem; color: var(--fg-soft); line-height: 1.5;
    padding-left: 0.7rem; position: relative;
  }
  .stock-sectors li::before {
    content: ""; position: absolute; left: 0; top: 0.5em; width: 0.32rem; height: 0.32rem;
    border-radius: 2px; background: color-mix(in srgb, var(--c-trading) 55%, var(--muted));
  }
  .stock-empty { margin: 0; font-size: 0.76rem; color: var(--muted); }
  /* 行情指数块（新浪行情 API，2026-08-25 用户拍板补指数 + 精准发布时间/渠道） */
  .stock-indices {
    margin: 0; padding: 0.4rem 0.5rem; background: color-mix(in srgb, var(--c-trading) 8%, var(--bg));
    border-radius: 8px; border: 1px solid var(--rule);
  }
  .stock-idx-cap {
    display: block; font-size: 0.64rem; color: var(--muted); font-weight: 600;
    letter-spacing: 0.04em; margin-bottom: 0.25rem;
  }
  .stock-idx-list { display: flex; flex-wrap: wrap; gap: 0.35rem 0.7rem; }
  .stock-idx {
    font-size: 0.74rem; color: var(--fg-soft); white-space: nowrap;
  }
  .stock-idx b { color: var(--fg); font-weight: 700; font-variant-numeric: tabular-nums; margin-left: 0.1rem; }
  /* 涨红跌绿（中国股市惯例） */
  .stock-idx-pct { font-style: normal; font-weight: 700; font-variant-numeric: tabular-nums; margin-left: 0.15rem; }
  .stock-idx-pct.up { color: #e23b3b; }
  .stock-idx-pct.down { color: #1a9e5a; }
  .stock-idx-src {
    display: block; margin-top: 0.3rem; font-size: 0.62rem; color: var(--muted);
    letter-spacing: 0.01em;
  }
  /* 卡脚小字备注：来源网站 + 数据时间 + 交叉验证网站（2026-08-25 替代来源链接按钮） */
  .stock-meta {
    margin: 0.2rem 0 0; font-size: 0.66rem; color: var(--muted);
    line-height: 1.5; letter-spacing: 0.01em;
    border-top: 1px dashed var(--rule); padding-top: 0.35rem;
  }
  /* 右侧渐隐遮罩：暗示右侧还有更多卡片（移动端横滑时可见） */
  .stock-must::after {
    content: ""; position: absolute; top: 1.7rem; right: 0; bottom: 0.5rem;
    width: 3.25rem; pointer-events: none; z-index: 3;
    background: linear-gradient(to left, color-mix(in srgb, var(--accent-brand) 16%, var(--bg)) 0%, color-mix(in srgb, var(--accent-brand) 4%, transparent) 55%, transparent 100%);
  }
  .stock-hint-inline {
    display: inline-block; margin-left: 0.45rem; vertical-align: middle;
    font-size: 0.68rem; font-weight: 500; color: var(--accent-brand);
    white-space: nowrap;
  }
  .stock-hint-inline .hint-arrow { display: inline-block; animation: nudge 1.1s ease-in-out infinite; }
  @media (min-width: 720px) {
    /* 桌面转网格：自适应列数（最多 3 列），无横向滑动，隐藏遮罩与提示 */
    .stock-scroller { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); overflow: visible; padding-bottom: 0; padding-right: 0; scroll-snap-type: none; }
    .stock-card { width: auto; max-width: none; }
    .stock-must::after { display: none; }
    .stock-hint-inline { display: none; }
  }
  /* 商机洞察来源标记 ①/②/③：标题后内联，移动端点击区域加大（≥26px），便于手机点开溯源 */
  .insight-srcs { display: inline-flex; gap: 0.22rem; margin-left: 0.35rem; vertical-align: middle; }
  .insight-src {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 1.65rem; min-height: 1.65rem; padding: 0 0.22rem;
    font-size: 0.92rem; font-weight: 700; line-height: 1; text-decoration: none;
    color: var(--accent-brand);
    border: 1px solid color-mix(in srgb, var(--accent-brand) 40%, transparent);
    border-radius: 7px; background: color-mix(in srgb, var(--accent-brand) 8%, transparent);
    -webkit-tap-highlight-color: transparent; transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
  }
  .insight-src:active { background: color-mix(in srgb, var(--accent-brand) 26%, transparent); transform: scale(0.94); }
  .insight-src:hover { background: color-mix(in srgb, var(--accent-brand) 16%, transparent); border-color: color-mix(in srgb, var(--accent-brand) 60%, transparent); }
  .tag {
    display: inline-block; font-size: 0.66rem; font-weight: 700; color: var(--accent-brand);
    background: color-mix(in srgb, var(--accent-brand) 11%, transparent);
    border-radius: 5px; padding: 0.08rem 0.4rem; margin-right: 0.35rem; vertical-align: 0.08em; letter-spacing: 0.02em;
  }
  .tag-action { color: var(--c-gdipo); background: color-mix(in srgb, var(--c-gdipo) 12%, transparent); }

`;
