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
       使文档流总高不变。这里保留一个静态兜底值（脚本未运行时也不至于贴太紧）。
       overflow-anchor: none —— 本元素尺寸会变，排除浏览器滚动锚定插手（微信内核里
       锚定会把滚动位置挪一下，反而给切换判据制造干扰）。 */
    .player-card { overflow-anchor: none; }
    .player-card.compact { padding: 0.45rem 0.8rem; margin-bottom: 0.8rem; }
    .player-card.compact .player-title { display: none; }
    .player-card.compact audio { margin-top: 0; }
  }
`.trim();

/**
 * 播放器紧凑态脚本。
 *
 * 只在页面存在播放器时注入（无音频的期次不注入空脚本）。
 * 不读墙钟（服务层禁 Date.now / 裸 new Date）。
 *
 * ⚠️ 播放器在**文档流内**，收窄会让它下面的内容整体上移。若不管，用户往下滑时
 *    整页会「窜」一下（实测滚动 5px 时正文位移 67px，其中 62px 来自布局跳变）。
 *    故切换后把省下的高度**原样补回下边距**（见下），让「播放器 + 下边距」总高不变。
 *
 * 🔴 **两条真机实锤的教训（2026-09-18，微信内置浏览器）**：
 *    ① 不要用「补偿滚动位置」（`scrollBy`）来消跳变：程序化滚动会改变滚动量，
 *       而滚动量又是切换判据 → 「切换条件 = 切换自身会改动的量」构成反馈环，一滚就抖。
 *    ② **不要用「绝对滚动位置 + 小滞回带」做判据**：微信内核（WKWebView / X5）在惯性
 *       与回弹期间会持续补发 scroll 事件，指头在阈值附近一停就有 ±10px 抖动，
 *       12px 的滞回带会被反复穿越 → 播放器高度 132↔79 反复切换 = 肉眼看到的「抖动」。
 *       症状特征：**贴着顶部时会抖，从页面下方快速滑过则不抖**。
 *
 * ✅ 现在的判据：**只看「同向净行程」**（连续同向累积 ≥ 90px 才允许切换一次），
 *    完全不用绝对位置。于是：
 *    - 阈值附近的小幅抖动（±十几 px、方向反复）永远累积不到 90px → 结构上不可能抖；
 *    - 内核补发的单次跳变（几十 px）也到不了 90px，无法连锁；
 *    - 切换仍然只改布局（补回下边距保持总高不变），**完全不碰滚动位置** → 无反馈环。
 *    另外给播放器加 `overflow-anchor: none`，排除浏览器滚动锚定插手的可能。
 */
export function generateCompactPlayerScript(): string {
  return `
(function () {
  var pc = document.querySelector('.player-card');
  if (!pc) return;
  // 紧凑态样式只在小屏生效（见 MOBILE_OPT_CSS 的媒体查询）；宽屏套类无意义，直接不介入
  if (!window.matchMedia || !window.matchMedia('(max-width: 719.98px)').matches) return;

  var baseMargin = getComputedStyle(pc).marginBottom;   // 展开态的原始下边距
  var STEP = 90;              // 连续同向净行程达到这个量，才允许切换一次
  var lastY = window.scrollY;
  var dist = 0;               // 有符号净行程：方向一变就重新计，切换后归零
  var on = false;

  function apply(next) {
    var before = pc.getBoundingClientRect().height;
    pc.classList.toggle('compact', next);
    var after = pc.getBoundingClientRect().height;
    on = next;
    // 把省下的高度补回下边距：总高不变 → 内容不动，且不碰滚动位置
    pc.style.marginBottom = next ? 'calc(' + baseMargin + ' + ' + (before - after) + 'px)' : '';
  }

  function sync() {
    var y = window.scrollY;
    var dy = y - lastY;
    lastY = y;
    if (dy) {
      dist = (dist > 0) === (dy > 0) ? dist + dy : dy;   // 反向 → 从这一小段重新计
      if (dist > STEP) dist = STEP;                      // 截断长距离累积：否则「先下滚很远
      if (dist < -STEP) dist = -STEP;                    // 再上滚」要滚很久才展开
    }
    if (!on && dist >= STEP) { apply(true); dist = 0; }
    else if (on && dist <= -STEP) { apply(false); dist = 0; }
  }

  // 页面恢复在中段（回到上次位置）时播放器已钉住，直接进紧凑态
  if (window.scrollY > 0) apply(true);
  window.addEventListener('scroll', sync, { passive: true });
})();
`.trim();
}
