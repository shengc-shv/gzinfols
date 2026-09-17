/**
 * 音频段落 → HTML 卡片联动（P0-A v2 起；自 gzinfo lib/feedback/inline-script.ts 移植——
 * 该文件本就只含播放器联动，不含点赞点踩 UI，feedback 域其余部分按裁决不移植）。
 *
 * 监听 `<audio>` 的 timeupdate，按当前时间找到 segment，给所有
 * `data-audio-section="<segmentId>"` 的卡片加 `.audio-highlight`。
 *
 * 调用方需在 HTML 中放置：
 *   - `<audio id="audio-player">`
 *   - `<script type="application/json" id="audio-segments">[{...segments}]</script>`
 *   - 提示条容器（`renderAudioNowHint()`）与章节列表（`renderAudioChapters()`）
 */

/**
 * 口播段落 id → 读者可见名称（章节列表 / 提示条的显示文案）。
 * 未登记的段落回落到 id 本身，宁可朴素也不臆造中文名。
 */
export const AUDIO_SEGMENT_LABELS: Record<string, string> = {
  intro: "开场",
  hero: "今日定调",
  must: "今日必读",
  insight: "业务启示",
  risk: "风险提示",
  stock: "股市动态",
  ipo: "广东IPO",
};

/** 秒 → mm:ss（章节列表时间戳；纯函数，无时钟依赖）。 */
export function mmssOf(sec: number): string {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * 音频联动高亮 + 章节列表 + 播放提示条（CSS）。
 *
 * ## 为什么是「三重可见」（2026-09-17 读者实测「依然看不到」后的重做）
 *
 * 演进史即排查史：
 *  - v1：静态 3px 淡蓝光晕 + 6% 背景 → 小屏几乎不可见；
 *  - v3：整卡描边 + 进入时闪 3 次 → 仍「看不见」，实测四个叠加原因：
 *    ① **闪 3 次只有 1.65 秒**（0.55×3），而段长 36~98 秒 —— 读者抬眼时早就闪完了；
 *    ② **前 18 秒（intro/hero）没有任何卡片**，刚点播放「毫无反应」，直接判为坏了；
 *    ③ 高亮背景被卡片自身规则盖回去：`.must-card.must-top` / `.risk-scroller .risk-card`
 *       特异性 (0,2,0) > `.audio-highlight` (0,1,0)；
 *    ④ 横滑容器 `overflow-x:auto`（overflow-y 随之变 auto）把向外的描边/外发光裁掉。
 *  - v5（本版）四招齐下，且**都不依赖「恰好看到那 1.65 秒」**：
 *    ① 进入段闪 3 次（读者特别要求）**之后转为低频呼吸脉冲**，任何时刻抬眼都在动；
 *    ② 卡片**内部**插入「正在播」徽章（DOM 元素 → 容器裁不掉、特异性覆盖不了）；
 *    ③ 内向 `outline`（`outline-offset` 为负，画在卡片内部）；
 *    ④ 播放器下方**常驻提示条**（段名 + 卡片数 + 必要时「定位」按钮）。
 *
 * ⚠️ 仍然**不用 border**：加 border 会改变卡片宽高（+4px），横滑容器里会错位跳动。
 * ⚠️ `prefers-reduced-motion` 下只留静态强对比 + 徽章（无障碍优先）。
 */
export const AUDIO_HIGHLIGHT_CSS = `
/* v5 音频联动高亮（2026-09-17）：进入闪 3 次 → 呼吸脉冲；卡片内徽章；播放提示条 */
@keyframes gz-audio-flash {
  0%, 100% { box-shadow: 0 0 0 4px rgba(64,158,255,0.95), 0 0 16px 3px rgba(64,158,255,0.55); background: rgba(64,158,255,0.20); }
  50% { box-shadow: 0 0 0 13px rgba(64,158,255,0.10), 0 0 4px 0 rgba(64,158,255,0.10); background: rgba(64,158,255,0.03); }
}
/* 呼吸脉冲：闪完之后接管，幅度小、周期长，不刺眼但「一直在动」 */
@keyframes gz-audio-pulse {
  0%, 100% { box-shadow: 0 0 0 4px rgba(64,158,255,0.85), 0 0 16px 3px rgba(64,158,255,0.45); }
  50% { box-shadow: 0 0 0 7px rgba(64,158,255,0.40), 0 0 24px 7px rgba(64,158,255,0.28); }
}
.audio-highlight {
  position: relative;
  border-radius: 8px;
  box-shadow: 0 0 0 4px rgba(64,158,255,0.85), 0 0 16px 3px rgba(64,158,255,0.45);
  background: rgba(64,158,255,0.16);
  animation: gz-audio-flash 0.55s ease-in-out 3, gz-audio-pulse 2.6s ease-in-out 1.7s infinite;
  transition: background 0.25s, box-shadow 0.25s;
}
/* ① 卡片级选择器：特异性(0,2,0) ≥ 卡片自身规则，避免背景被 .must-card.must-top /
   .risk-scroller .risk-card 之类盖回去 */
.must-card.audio-highlight, .insight.audio-highlight, .insight-card.audio-highlight,
.risk-card.audio-highlight, .stock-card.audio-highlight, .brief.audio-highlight {
  background: rgba(64,158,255,0.16);
}
/* ② 内向 outline：横滑容器会裁掉向外的阴影；outline-offset 为负时描边画在卡片内部，
   任何 overflow 容器都裁不掉 */
.must-card.audio-highlight, .insight.audio-highlight, .insight-card.audio-highlight,
.risk-card.audio-highlight, .stock-card.audio-highlight, .brief.audio-highlight {
  outline: 3px solid rgba(37,99,235,0.95);
  outline-offset: -3px;
}
.must-card.audio-highlight, .insight.audio-highlight, .stock-card.audio-highlight { transform: translateZ(0); }
/* ③ 卡片内徽章：DOM 元素，容器裁不掉、特异性覆盖不了 —— 最后一道保底可见性 */
.audio-now-badge {
  position: absolute; top: 4px; right: 6px; z-index: 3;
  font-size: 0.66rem; font-weight: 700; line-height: 1.6;
  padding: 0 0.32rem; border-radius: 6px;
  background: #2563eb; color: #fff; white-space: nowrap;
  box-shadow: none; animation: none;
}
/* ④ 播放提示条（读者 2026-09-17 要求：音频跟随只做提示，不自动切页面） */
.audio-now-hint {
  display: flex; align-items: center; flex-wrap: wrap; gap: 0.4rem;
  margin: 0.5rem 0 0; font-size: 0.8rem; line-height: 1.7;
}
.audio-now-hint[hidden] { display: none; }
.audio-now-hint .an-dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: #2563eb; flex: none; }
.audio-now-hint .an-txt { font-weight: 600; }
.audio-now-hint .an-note { color: var(--muted, #888); }
.audio-now-hint .an-go {
  font: inherit; font-size: 0.78rem; line-height: 1.9; padding: 0 0.6rem;
  border: 1px solid rgba(37,99,235,0.9); border-radius: 999px;
  background: #2563eb; color: #fff; cursor: pointer;
}
.audio-now-hint .an-go[hidden] { display: none; }
/* A4 章节列表：即使卡片在视口外 / 未激活 tab 里，读者也能看到「正在播哪一段」 */
.audio-chapters { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0.5rem 0 0; }
.audio-chapter {
  font: inherit; font-size: 0.78rem; line-height: 1.9;
  padding: 0 0.5rem; border: 1px solid var(--rule, #ddd); border-radius: 999px;
  background: var(--bg-elevated, #fff); color: var(--fg, #1a1a1a); cursor: pointer;
}
.audio-chapter .ch-t { color: var(--muted, #888); margin-right: 0.25rem; font-variant-numeric: tabular-nums; }
.audio-chapter.is-current { border-color: rgba(37,99,235,0.95); color: #fff; background: rgba(37,99,235,0.92); }
.audio-chapter.is-current .ch-t { color: rgba(255,255,255,0.85); }
/* 尊重「减少动态效果」偏好：不闪不脉冲，改用更强的静态对比补偿（描边加粗 + 底色加深 + 徽章） */
@media (prefers-reduced-motion: reduce) {
  .audio-highlight { animation: none; }
  .must-card.audio-highlight, .insight.audio-highlight, .insight-card.audio-highlight,
  .risk-card.audio-highlight, .stock-card.audio-highlight, .brief.audio-highlight {
    outline-width: 4px; background: rgba(64,158,255,0.26);
  }
}
`.trim();

/** 属性值转义。 */
function escapeAttr(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 「正在播」提示条容器（常驻，脚本按段落更新文案）。
 *
 * 为什么需要：卡片闪烁是**瞬时的、且可能在视口外/其它 tab 内**，读者无法据此判断
 * 「系统到底有没有在跟随」。提示条始终在播放器旁，写明「正在播哪段 / 几张卡被高亮 /
 * 卡片在哪里」，把不可见的状态变成可见 —— 这是「只提示不切页」的落点。
 */
export function renderAudioNowHint(): string {
  return (
    `<div class="audio-now-hint" id="audio-now-hint" hidden>` +
    `<span class="an-dot" aria-hidden="true"></span>` +
    `<span class="an-txt" id="audio-now-text"></span>` +
    `<span class="an-note" id="audio-now-note"></span>` +
    `<button type="button" class="an-go" id="audio-now-go" hidden>定位到卡片</button>` +
    `</div>`
  );
}

/**
 * 渲染「口播章节列表」（A4）。
 * 段落级跳转入口 + 当前段指示；当卡片不在当前视图时，它是最可靠的「正在讲哪段」线索。
 */
export function renderAudioChapters(
  segments: { id: string; startSec: number; durationSec: number }[],
): string {
  if (!segments || segments.length < 2) return "";
  const items = segments
    .map((s, i) => {
      const label = AUDIO_SEGMENT_LABELS[s.id] ?? s.id;
      return (
        `<button type="button" class="audio-chapter" data-seg="${escapeAttr(s.id)}" ` +
        `data-start="${escapeAttr(String(Math.max(0, Math.round(s.startSec || 0))))}" ` +
        `data-idx="${i}"><span class="ch-t">${escapeHtml(mmssOf(s.startSec))}</span>${escapeHtml(label)}</button>`
      );
    })
    .join("");
  return `<div class="audio-chapters" id="audio-chapters">${items}</div>`;
}

function escapeHtml(s: string): string {
  return escapeAttr(s);
}

/**
 * 音频 → 卡片联动脚本。
 *
 * 读者 2026-09-17 的要求：**音频跟随只做提示、不要自动切标签页**（会打断阅读）。
 * 故本脚本**不做任何自动切面板 / 自动滚动**：把「卡片在别处」写成提示条 + 一个
 * 「定位到卡片」按钮，**由读者点击才跳**；章节列表点击跳段同理（读者主动）。
 *
 * 时间基准一律用 `audio.currentTime`（**不用 Date.now()**：服务层禁隐式时钟，
 * 且页面里「播到第几秒」比墙钟更贴合语义）。
 */
export function generateAudioHighlightScript(): string {
  const labels = JSON.stringify(AUDIO_SEGMENT_LABELS);
  return `
(function(){
  var audio = document.getElementById("audio-player");
  var dataEl = document.getElementById("audio-segments");
  if (!audio || !dataEl) return;
  var segments;
  try { segments = JSON.parse(dataEl.textContent || "[]"); } catch(e) { return; }
  if (!Array.isArray(segments) || segments.length === 0) return;

  var LABELS = ${labels};
  var hint = document.getElementById("audio-now-hint");
  var hintTxt = document.getElementById("audio-now-text");
  var hintNote = document.getElementById("audio-now-note");
  var hintGo = document.getElementById("audio-now-go");
  var lastId = null;

  function cardsOf(id) { return document.querySelectorAll('[data-audio-section="' + id + '"]'); }
  function clearHighlights() {
    var els = document.querySelectorAll(".audio-highlight");
    for (var i = 0; i < els.length; i++) els[i].classList.remove("audio-highlight");
    var badges = document.querySelectorAll(".audio-now-badge");
    for (var j = badges.length - 1; j >= 0; j--) {
      if (badges[j].parentNode) badges[j].parentNode.removeChild(badges[j]);
    }
  }
  function addBadges(cards) {
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (c.querySelector && c.querySelector(".audio-now-badge")) continue;
      var b = document.createElement("span");
      b.className = "audio-now-badge";
      b.textContent = "🔊 正在播";
      c.appendChild(b);
    }
  }
  function syncChapters(id) {
    var btns = document.querySelectorAll(".audio-chapter");
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("is-current", btns[i].getAttribute("data-seg") === id);
    }
  }
  // 卡片是否落在「未激活标签面板」或「折叠区」里（此时高亮本身看不见）
  function hiddenReason(el) {
    if (!el || !el.closest) return null;
    var panel = el.closest(".panel");
    if (panel && !panel.classList.contains("active")) {
      var tab = document.querySelector('.tabs > .tab[data-target="' + panel.id + '"]');
      return tab ? tab.textContent.replace(/\\s+/g, "") : "下方标签页";
    }
    if (el.classList.contains("more")) {
      var host = el.closest(".panel, .exec-must");
      if (host && !host.classList.contains("expanded")) return "本页折叠区";
    }
    return null;
  }
  // 仅在**读者主动点击**时执行：切面板 + 展开折叠 + 滚动定位（绝不自动触发）
  function gotoCards(cards) {
    if (!cards || !cards.length) return;
    var el = cards[0];
    var panel = el.closest ? el.closest(".panel") : null;
    if (panel && !panel.classList.contains("active")) {
      var pid = panel.id;
      var tabs = document.querySelectorAll(".tabs > .tab");
      for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle("active", tabs[i].getAttribute("data-target") === pid);
      var panels = document.querySelectorAll(".panel");
      for (var j = 0; j < panels.length; j++) panels[j].classList.toggle("active", panels[j].id === pid);
    }
    if (el.classList && el.classList.contains("more")) {
      var host = el.closest(".panel, .exec-must");
      if (host) host.classList.add("expanded");
    }
    try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) { el.scrollIntoView(); }
    for (var k = 0; k < cards.length; k++) {
      (function (node) {
        node.classList.add("flash");
        setTimeout(function () { node.classList.remove("flash"); }, 1800);
      })(cards[k]);
    }
  }
  function updateHint(seg, cards) {
    if (!hint) return;
    if (!seg) { hint.hidden = true; return; }
    var name = LABELS[seg.id] || seg.id;
    var n = cards.length;
    hintTxt.textContent = "正在播：" + name + (n ? "（已高亮 " + n + " 张卡）" : "");
    var reason = n ? hiddenReason(cards[0]) : null;
    if (!n) hintNote.textContent = "· 本段没有对应卡片";
    else if (reason) hintNote.textContent = "· 卡片在「" + reason + "」中";
    else hintNote.textContent = "";
    if (hintGo) hintGo.hidden = !(n && reason);
    hint.hidden = false;
  }
  function apply(seg) {
    if (!seg) { clearHighlights(); syncChapters(null); updateHint(null, []); lastId = null; return; }
    syncChapters(seg.id);
    var cards = cardsOf(seg.id);
    if (seg.id === lastId) { updateHint(seg, cards); return; }
    lastId = seg.id;
    clearHighlights();
    for (var i = 0; i < cards.length; i++) cards[i].classList.add("audio-highlight");
    addBadges(cards);
    updateHint(seg, cards);
    if (hintGo) {
      hintGo.onclick = function () { gotoCards(cardsOf(seg.id)); };
    }
  }
  function currentSegment(t) {
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      if (t >= s.startSec && t < s.startSec + s.durationSec) return s;
    }
    return null;
  }
  function tick() { apply(currentSegment(audio.currentTime || 0)); }
  audio.addEventListener("timeupdate", tick);
  audio.addEventListener("seeked", function () { lastId = null; tick(); });
  audio.addEventListener("play", tick);
  audio.addEventListener("pause", tick);
  audio.addEventListener("ended", function () {
    clearHighlights(); syncChapters(null); updateHint(null, []); lastId = null;
  });
  // A4 章节列表：点击跳段（读者主动；跳完刷新提示）
  var chapters = document.querySelectorAll(".audio-chapter");
  for (var k = 0; k < chapters.length; k++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        var t = parseFloat(btn.getAttribute("data-start")) || 0;
        try { audio.currentTime = t; } catch (e) {}
        lastId = null;
        tick();
        var p = audio.play();
        if (p && p.catch) p.catch(function () {});
      });
    })(chapters[k]);
  }
})();
`;
}
