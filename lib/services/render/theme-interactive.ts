/**
 * 全站样式 · 段落：交互增强：2026-08-21 重构 / 语音播放器 / 各类补丁（2026-09-14 自 theme.ts 拆分）。
 *
 * 纯静态 CSS 片段、无插值。⚠️ 模板串内的 CSS 注释不得出现反引号（会截断模板）；
 * CSS 注释会进渲染产物，但注入点 stripCssComments 会剥离，源码注释是安全的。
 */
export const THEME_INTERACTIVE_CSS = `  /* ===== 2026-08-21 交互重构（demo 对齐）：报头 / 单层 tab / 卡片徽章 / 商机默认展开 / 字号体系 ===== */
  html { font-size: 17px; }
  body { line-height: 1.65; }
  main { max-width: 980px; margin: 0 auto; padding: 2rem 1.25rem 3.5rem; }

  .masthead { border-bottom: 1px solid var(--rule); padding-bottom: 1.1rem; }
  .masthead .eyebrow { font-size: 0.72rem; letter-spacing: 0.2em; color: var(--muted); text-transform: uppercase; font-weight: 600; }
  .masthead h1 { font-family: Georgia, "Songti SC", "Noto Serif CJK SC", serif; font-size: 2rem; margin: 0.35rem 0 0.1rem; letter-spacing: -0.01em; }
  .hero-line { margin: 0.7rem 0 0; font-size: 1.02rem; line-height: 1.7; border-left: 3px solid var(--brand, #e60012); padding-left: 0.8rem; }
  .meta-line { margin: 0.6rem 0 0; font-size: 0.82rem; color: var(--muted); }
  .meta-line .archive { color: var(--muted); }

  /* ===== 语音播报 sticky 播放器（2026-08-24 新增）===== */
  .player-card {
    position: sticky; top: 0; z-index: 30;
    margin: 0 0 1.4rem; padding: 0.85rem 1.05rem;
    background: color-mix(in srgb, var(--accent-brand) 7%, var(--bg));
    border: 1px solid color-mix(in srgb, var(--accent-brand) 30%, var(--rule));
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-sm);
    backdrop-filter: saturate(180%) blur(8px);
    -webkit-backdrop-filter: saturate(180%) blur(8px);
  }
  .player-title {
    display: flex; align-items: baseline; gap: 0.5rem;
    font-weight: 600; font-size: 0.98rem; color: var(--fg);
  }
  .player-title .ic { font-size: 1.05rem; }
  .player-dur { font-weight: 400; font-size: 0.82rem; color: var(--muted); }
  /* 合成后端徽标（2026-08-24）：腾讯云=蓝（云），开源 Piper=灰 */
  .player-badge {
    margin-left: 0.35rem; padding: 0.06rem 0.5rem;
    font-size: 0.7rem; font-weight: 500; line-height: 1.4;
    border-radius: 999px; border: 1px solid transparent; white-space: nowrap;
  }
  .player-badge-tencent {
    color: #1565c0;
    background: color-mix(in srgb, #1565c0 12%, var(--bg));
    border-color: color-mix(in srgb, #1565c0 38%, var(--rule));
  }
  .player-badge-piper {
    color: var(--muted);
    background: color-mix(in srgb, var(--muted) 12%, var(--bg));
    border-color: color-mix(in srgb, var(--muted) 38%, var(--rule));
  }
  .player-card audio { width: 100%; margin-top: 0.55rem; }

  /* 今日必读字号加大（#7） */
  .must-card strong { font-size: 0.92rem; }
  .must-card .must-why { font-size: 0.85rem; }

  /* 商机洞察卡片（横向滑动，桌面转网格；tag 中文见下方） */
  .insight-card, .insight { background: var(--card); border: 1px solid var(--rule); border-radius: 10px; padding: 0.7rem 0.85rem; }
  .insight h3 { margin: 0.3rem 0 0.35rem; font-size: 0.98rem; line-height: 1.45; }
  .insight p { margin: 0.25rem 0 0; font-size: 0.9rem; color: var(--fg-soft); line-height: 1.6; }
  .insight p b { color: var(--fg); }
  .insight-tags { margin-bottom: 0.1rem; }
  .tag { display: inline-block; font-size: 0.7rem; font-weight: 700; border-radius: 4px; padding: 0.08rem 0.42rem; margin-right: 0.35rem; color: var(--brand, #e60012); background: rgba(230, 0, 18, 0.1); }
  .tag.t-wealth { color: #7c3aed; background: rgba(124, 58, 237, 0.12); }
  .tag.t-mass { color: #059669; background: rgba(5, 150, 105, 0.12); }
  .tag.t-policy { color: #b45309; background: rgba(180, 83, 9, 0.12); }
  /* 粤标签（2026-08-23）：广东企业/事件地域标记，品牌红描边胶囊，区别于业务线彩底 */
  .tag.t-gd { color: var(--accent-brand, #e60012); background: color-mix(in srgb, var(--accent-brand, #e60012) 8%, transparent); border: 1px solid color-mix(in srgb, var(--accent-brand, #e60012) 45%, transparent); font-weight: 800; }

  /* 单层 tab：横滑不折行（#11） */
  .tabs { position: sticky; top: 0; z-index: 20; display: flex; flex-wrap: nowrap; overflow-x: auto; gap: 0.1rem; margin: 1.4rem 0 0; padding: 0.6rem 0 0; border-bottom: 1px solid var(--rule); background: color-mix(in srgb, var(--bg) 90%, transparent); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
  .tabs .tab { flex: none; background: none; border: none; font-family: inherit; cursor: pointer; padding: 0.6rem 0.9rem 0.75rem; font-size: 0.95rem; font-weight: 500; color: var(--muted); border-bottom: 2.5px solid transparent; margin-bottom: -1px; white-space: nowrap; }
  .tabs .tab .n { font-size: 0.72rem; color: var(--muted); margin-left: 0.2rem; }
  .tabs .tab.active { color: var(--cat, var(--fg)); border-bottom-color: var(--cat, var(--fg)); font-weight: 600; }
  .panel { display: none; padding-top: 1rem; }
  .panel.active { display: block; }

  /* 卡片：来源徽章 + 摘要平铺（#12/#15） */
  /* 2026-09-14 修正：box-shadow 原写 var(--shadow) → 改 var(--shadow-sm)。
     --shadow 【从未定义】（主题只定义 --shadow-sm/md/lg）→ 该声明整体失效（卡片无阴影）。
     改用 --shadow-sm，与本文件其余 20 余处卡片规则一致。
     由 tests/render-invariants.test.ts 的「CSS 变量自洽」断言发现并锁死。
     注：本文件是模板字符串，注释内**不可使用反引号**（会截断模板）。 */
  .brief { background: var(--card); border: 1px solid var(--rule); border-radius: 12px; padding: 0.8rem 0.95rem; margin-bottom: 0.55rem; box-shadow: var(--shadow-sm); }
  .brief .bm { display: flex; align-items: center; gap: 0.45rem; font-size: 0.78rem; color: var(--muted); margin-bottom: 0.25rem; flex-wrap: wrap; }
  .src-badge { font-size: 0.66rem; font-weight: 700; border-radius: 4px; padding: 0.06rem 0.35rem; }
  .src-official { color: #b45309; background: rgba(217, 119, 6, 0.14); }
  .src-media { color: #4f46e5; background: rgba(79, 70, 229, 0.12); }
  /* 股市动态面板：市场徽标（A股/港股/美股，2026-08-25 用户：卡片打标市场） */
  .mkt-badge { font-size: 0.66rem; font-weight: 700; border-radius: 4px; padding: 0.06rem 0.35rem; }
  .mkt-a { color: #dc2626; background: rgba(220, 38, 38, 0.12); }
  .mkt-hk { color: #0d9488; background: rgba(13, 148, 136, 0.12); }
  .mkt-us { color: #7c3aed; background: rgba(124, 58, 237, 0.12); }
  .brief h3 { margin: 0; font-size: 0.98rem; line-height: 1.5; }
  .brief .sum { margin: 0.35rem 0 0; font-size: 0.92rem; color: var(--fg-soft); line-height: 1.65; }
  .brief .sum b { color: var(--fg); }
  /* 2026-09-07 IPO 双链接：主链接（东财列表）+ 交易所官方源入口（人工核查） */
  .brief .official-src { margin: 0.3rem 0 0; font-size: 0.78rem; color: var(--muted); line-height: 1.5; }
  .brief .official-src a { color: var(--accent-brand, #b45309); text-decoration: none; border-bottom: 1px dashed currentColor; }
  .brief .official-src a:hover { color: var(--fg); }
  .brief.more { display: none; }
  .panel.expanded .brief.more { display: block; }
  .expand-btn { width: 100%; margin: 0.2rem 0 0.4rem; padding: 0.6rem; border: 1px dashed var(--rule); border-radius: 10px; background: var(--bg-elevated, var(--card)); color: var(--muted); font-size: 0.88rem; font-family: inherit; cursor: pointer; }
  .expand-btn:hover { color: var(--fg); border-style: solid; }
  /* 板块内标签筛选条（2026-08-22 用户） */
  .filter-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; margin: 0.4rem 0 0.9rem; padding: 0.5rem 0.65rem; background: var(--bg-elevated, var(--card)); border: 1px solid var(--rule); border-radius: 12px; }
  .filter-label { font-size: 0.82rem; color: var(--fg-soft, var(--muted)); margin-right: 0.15rem; }
  .filter-group { display: inline-flex; align-items: center; gap: 0.4rem; }
  .filter-group + .filter-group { padding-left: 0.7rem; margin-left: 0.35rem; border-left: 1px solid var(--rule); }
  .filter-gtitle { font-size: 0.8rem; color: var(--fg-soft, var(--muted)); }
  .filter-chip { border: 1px solid var(--rule); background: var(--bg, var(--card)); color: var(--fg-soft, var(--muted)); border-radius: 999px; padding: 0.28rem 0.8rem; font-size: 0.84rem; cursor: pointer; user-select: none; transition: all 0.15s; font-family: inherit; }
  .filter-chip:hover { border-color: var(--accent-brand); color: var(--accent-brand); }
  .filter-chip.active { background: var(--accent-brand); border-color: var(--accent-brand); color: #fff; font-weight: 600; box-shadow: 0 2px 8px color-mix(in srgb, var(--accent-brand) 38%, transparent); }
  .filter-reset { margin-left: auto; border: 1px solid var(--rule); background: transparent; color: var(--fg-soft, var(--muted)); border-radius: 999px; padding: 0.28rem 0.8rem; font-size: 0.84rem; cursor: pointer; font-family: inherit; }
  .filter-reset:hover { border-color: var(--accent-brand); color: var(--accent-brand); }
  .brief.filtered-out { display: none !important; }
  /* 广东IPO 四阶段分栏（2026-09-10 用户决策③）：组头带阶段色点 + 家数，空组整组隐藏 */
  .ipo-group { margin: 0 0 0.9rem; }
  .ipo-group.filtered-out { display: none !important; }
  .ipo-group-head {
    display: flex; align-items: center; gap: 0.4rem;
    margin: 0 0 0.45rem; padding-bottom: 0.25rem;
    font-size: 0.86rem; font-weight: 700; color: var(--fg);
    border-bottom: 1px dashed var(--rule);
  }
  .ipo-group-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; }
  .ipo-group-dot.ipo-stage--none { background: var(--muted); }
  .ipo-group-n {
    font-size: 0.72rem; font-weight: 600; color: var(--muted);
    background: var(--bg-elevated, var(--card)); border: 1px solid var(--rule);
    border-radius: 999px; padding: 0 0.4rem; line-height: 1.5;
  }
  /* 同企业阶段进展条（P2-6）：09/03 在审 → 09/07 注册发行 */
  .ipo-progress {
    display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem;
    margin: 0.4rem 0 0; font-size: 0.76rem; color: var(--fg-soft);
  }
  .ipo-progress-label {
    flex: none; font-weight: 700; color: var(--muted);
    border: 1px solid var(--rule); border-radius: 999px; padding: 0 0.4rem; line-height: 1.5;
  }
  .ipo-progress-step { white-space: nowrap; }
  .ipo-progress-step--cur { font-weight: 700; color: var(--fg); }
  .ipo-progress-arrow { color: var(--muted); }

  /* 市场总览 bullet（#17/#18/#19） */
  .market-card .bm { margin-bottom: 0.35rem; }
  .market-bullets { margin: 0.35rem 0 0; padding-left: 1.1rem; font-size: 0.92rem; color: var(--fg-soft); line-height: 1.7; }
  .market-bullets b { color: var(--fg); }

  footer p { margin: 0.25rem 0; line-height: 1.7; }
`;
