/**
 * 移动端优化层（2026-09-18）。
 *
 * 定位：**只放「新增的移动端能力」**——触摸热区与粘性播放器紧凑态。
 *   · 触摸热区：把交互控件的可点区域铺到 ≥44px（视觉尺寸不变，不拉长页面）；
 *   · 粘性播放器紧凑态：滚过原位后收起标题行，把视口还给正文。
 *
 * 为什么单独成模块、而不是就地改既有样式：
 *   这里是**新增行为**，不是对既有样式的修正。既有规则的缺陷一律就地最小修复
 *   （见 theme-cards.ts 的 .must-card、theme-panels.ts 的 .brief h3 a），
 *   若在本层再叠加覆盖，同一属性会出现两处定义、日后必然漂移。
 *   本层整体删除即可回退全部移动端增强，基础版式不受影响。
 *
 * ⚠️ 注入位置有硬要求：MOBILE_OPT_CSS 必须排在产物 <style> 的**最末**（见 full.ts）。
 *    本层靠「同优先级 + 源码靠后」生效；媒体查询不提升优先级，因此若排在后面还有
 *    同选择器的规则（例如 full.ts 内联的 .seg-chip），本层会被静默压掉。
 *    tests/mobile-opt.test.ts 有顺序断言兜底。
 *
 * ⚠️ 断点用 719.98px 而非 719px：桌面增强的门槛是 `min-width: 720px`，
 *    两者互补才能覆盖所有视口宽度（用 719px 会留下一条窄缝两边都不生效）。
 *
 * ⚠️ 模板串内不得出现反引号（会截断模板）；CSS 注释会进产物，但注入点
 *    stripCssComments 会剥离，源码注释是安全的。
 */

/** 移动端增强样式。**必须置于产物 <style> 最末**。 */
export const MOBILE_OPT_CSS = `
  @media (max-width: 719.98px) {
    /* ── 触摸热区 ≥44px ──────────────────────────────────────────────
       做法：透明伪元素向外铺开可点区域。
       反面做法（勿用）：给控件加 padding / min-height 撑高盒子 —— 实测会把整页
       拉长约 279px，且打乱排版节奏。 */

    .card-actions button,
    .filter-chip, .filter-reset,
    .role-chip, .seg-chip,
    .archive, .coverage > summary,
    .expand-btn, .brief .official-src a,
    .insight-src, .risk-src, .ipo-src,
    .stock-source-report, .fav-bar button,
    .redchip-ledger a, .must-inbody { position: relative; }

    .card-actions button::after { content: ""; position: absolute; inset: -11px -8px; z-index: 1; }
    .filter-chip::after, .filter-reset::after { content: ""; position: absolute; inset: -8px -4px; z-index: 1; }
    .role-chip::after { content: ""; position: absolute; inset: -9px -2px; z-index: 1; }
    .seg-chip::after { content: ""; position: absolute; inset: -11px -4px; z-index: 1; }
    .archive::after { content: ""; position: absolute; inset: -14px 0; z-index: 1; }
    .coverage > summary::after { content: ""; position: absolute; inset: -14px 0; z-index: 1; }
    .insight-src::after, .risk-src::after { content: ""; position: absolute; inset: -11px -8px; z-index: 1; }
    .ipo-src::after, .stock-source-report::after, .fav-bar button::after,
    .redchip-ledger a::after, .must-inbody::after { content: ""; position: absolute; inset: -14px 0; z-index: 1; }

    /* 少数控件被祖先裁剪、或与相邻行盒重叠，伪元素铺不开 → 只能给一点真实尺寸。
       ① ② 来源序号位于文本流内，横向热区会被相邻文字挤占，实测有效热区
       约 35–41 × 49px（高度达标、宽度略窄）：再强行加宽会盖住正文文字、
       反而提高误触率，故保留此取舍。 */
    .insight-srcs, .risk-srcs { gap: 0.55rem; }
    .seg-chip { padding: 3px 10px; border-radius: 10px; }
    .stock-source-report { display: inline-flex; align-items: center; min-height: 44px; padding: 0 0.5rem; }
    .expand-btn { min-height: 44px; }

    /* ── 粘性播放器紧凑态 ────────────────────────────────────────────
       .player-card 是 position: sticky，滚动时钉在视口顶部常驻 132px
       （844px 屏的 15.6%），有效阅读高度只剩 712px。
       滚动后收起标题行，只留播放控件，压到约 79px。
       仅移动端生效：桌面视口高、且播放器不挡阅读。
       ⚠️ 收窄会让下方内容上移 —— 脚本会把省下的高度**补回下边距**（内联），
       使文档流总高不变。这里保留一个静态兜底值（脚本未运行时也不至于贴太紧）。 */
    .player-card.compact { padding: 0.45rem 0.8rem; margin-bottom: 0.8rem; }
    .player-card.compact .player-title { display: none; }
    .player-card.compact audio { margin-top: 0; }
  }
`.trim();

/**
 * 播放器紧凑态脚本。
 *
 * 只在页面存在播放器时注入（无音频的期次不注入空脚本）。
 * 判据用「元素在文档中的原始位置」而不是滚动量：播放器一旦钉住，
 * 其 rect.top 恒为 0，无法再作为判据，故在未钉住时先取一次基准。
 * 不读墙钟（服务层禁 Date.now / 裸 new Date）。
 *
 * ⚠️ 播放器在**文档流内**，收窄会让它下面的内容整体上移。若不管，用户往下滑时
 *    整页会「窜」一下（实测滚动 5px 时正文位移 67px，其中 62px 来自布局跳变）。
 *
 * 🔴 **不要用「补偿滚动位置」来消这个跳变**（2026-09-18 真机实锤）：
 *    第一版是 `scrollBy(0, after - before)` + 滞回带，桌面模拟通过，但**手机上直接
 *    死循环抖动** —— 程序化滚动会改变滚动量，而滚动量又是切换判据，两者构成反馈环；
 *    真机上再有惯性滚动、尺寸测量偏差（字体/原生播放器控件渲染晚于测量）就会来回翻转。
 *
 * ✅ 正确做法：**把省下的高度原样补回下边距**，让「播放器 + 其下边距」的总高不变 →
 *    文档流不发生变化 → 内容一动不动（无跳变）、**完全不碰滚动位置**（无反馈环，
 *    想抖也抖不起来），而收益照常：钉在视口顶部的播放器只有 79px 而非 132px。
 *    补偿量在切换瞬间现测（before - after），因此不依赖初始化时的陈旧测量。
 */
export function generateCompactPlayerScript(): string {
  return `
(function () {
  var pc = document.querySelector('.player-card');
  if (!pc) return;
  // 紧凑态样式只在小屏生效（见 MOBILE_OPT_CSS 的媒体查询）；宽屏套类无意义，直接不介入
  if (!window.matchMedia || !window.matchMedia('(max-width: 719.98px)').matches) return;

  var baseMargin = getComputedStyle(pc).marginBottom;   // 展开态的原始下边距
  var origin = pc.getBoundingClientRect().top + window.scrollY;
  var onAt = origin + 6;    // 滚过这里 → 收窄
  var offAt = origin - 6;   // 退回这里 → 展开（小滞回带，只防阈值边界反复切换）
  var on = false;

  function sync() {
    var y = window.scrollY;
    var want = on ? y > offAt : y > onAt;
    if (want === on) return;
    var before = pc.getBoundingClientRect().height;
    on = want;
    if (want) pc.classList.add('compact'); else pc.classList.remove('compact');
    var after = pc.getBoundingClientRect().height;
    // 把省下的高度补回下边距：文档流总高不变 → 内容不位移，且不碰滚动位置
    pc.style.marginBottom = want ? 'calc(' + baseMargin + ' + ' + (before - after) + 'px)' : '';
  }
  window.addEventListener('scroll', sync, { passive: true });
  sync();
})();
`.trim();
}
