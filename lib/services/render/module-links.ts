/**
 * 模块入口双卡（2026-10-19 sc 要求）：主题追踪 / 研报解读。
 *
 * 位置：报头 meta 行之下、「覆盖度与来源分布」之上。
 * 链接：日报页位于 `site/<date>/<date>.html`，故取**站点根相对路径** `../`。
 *
 * 交互（手机端优先）：
 *  - 整卡可点（`<a>` 包住卡片），不是只有文字可点；
 *  - 触摸热区 ≥56px（高于 44px 底线）；
 *  - 手机端两列自动堆叠单列，字号不缩；
 *  - 纯 CSS 反馈（hover 描边 / active 微缩），无 JS。
 * 样式见 `theme-interactive.ts`（.module-links）。
 *
 * 2026-10-19 sc 二次口径：**入口即导航**——日报页不再内嵌研报面板（内容只在独立主页），
 * 因此 `RESEARCH_PANEL=off` 的屏蔽点也从「面板」改为「入口卡 + 主页生成」。
 */
export function renderModuleLinks(opts: { showResearch?: boolean } = {}): string {
  const items: Array<{ href: string; icon: string; title: string; desc: string }> = [
    { href: "../topics.html", icon: "🧭", title: "主题追踪", desc: "一件事后来怎么样了" },
  ];
  if (opts.showResearch !== false) {
    items.push({ href: "../research.html", icon: "📐", title: "研报解读", desc: "同业深度打法与框架" });
  }
  const cards = items
    .map(
      (i) => `<a class="module-link" href="${i.href}">
      <span class="module-link-icon" aria-hidden="true">${i.icon}</span>
      <span class="module-link-body">
        <span class="module-link-title">${i.title}</span>
        <span class="module-link-desc">${i.desc}</span>
      </span>
      <span class="module-link-arrow" aria-hidden="true">→</span>
    </a>`,
    )
    .join("");
  return `<nav class="module-links" aria-label="模块入口">${cards}</nav>`;
}
