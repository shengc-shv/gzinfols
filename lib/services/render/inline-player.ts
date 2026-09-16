/**
 * 音频段落 → HTML 卡片联动脚本（P0-A v2；自 gzinfo lib/feedback/inline-script.ts 移植——
 * 该文件本就只含播放器联动，不含点赞点踩 UI，feedback 域其余部分按裁决不移植）。
 *
 * 监听 <audio> timeupdate 事件，根据当前时间查找匹配 segment，
 * 给所有 data-audio-section="<segmentId>" 的卡片加 .audio-highlight class。
 *
 * 调用方需在 HTML 中放置：
 *   - <audio id="audio-player">
 *   - <script type="application/json" id="audio-segments">[{...segments}]</script>
 */

/**
 * 嵌入到 HTML 的 CSS（音频联动高亮）。
 *
 * 2026-09-17 用户反馈：手机上**完全注意不到**高亮。原因是最初实现只有
 * `box-shadow: 0 0 0 3px rgba(...,0.45)` + `background: rgba(...,0.06)` —— 静态淡蓝光晕、
 * 背景几乎透明，小屏上辨识度极低（机制本身是好的：段 id 与卡片 data-audio-section 完全匹配）。
 *
 * 现改为：
 *   - 静止态：整卡**明显描边 + 外发光 + 浅蓝底**（远远就能看到"正在讲这张"）；
 *   - 进入该段的瞬间：描边**闪 3 次**（用户要求），之后停在静止态。
 * ⚠️ 全部用 `box-shadow` 模拟边框，**不用 border** —— 加 border 会改变卡片宽高（+4px），
 *    在横滑容器里会引起卡片错位/跳动。
 */
export const AUDIO_HIGHLIGHT_CSS = `
/* v3 音频联动高亮（2026-09-17）：整卡描边 + 进入时闪 3 次 */
@keyframes gz-audio-flash {
  0%, 100% { box-shadow: 0 0 0 4px rgba(64,158,255,0.95), 0 0 16px 3px rgba(64,158,255,0.55); background: rgba(64,158,255,0.20); }
  50% { box-shadow: 0 0 0 13px rgba(64,158,255,0.10), 0 0 4px 0 rgba(64,158,255,0.10); background: rgba(64,158,255,0.03); }
}
.audio-highlight {
  border-radius: 8px;
  box-shadow: 0 0 0 4px rgba(64,158,255,0.85), 0 0 16px 3px rgba(64,158,255,0.45);
  background: rgba(64,158,255,0.16);
  animation: gz-audio-flash 0.55s ease-in-out 3;
  transition: background 0.25s, box-shadow 0.25s;
}
.must-card.audio-highlight, .insight.audio-highlight, .stock-card.audio-highlight { transform: translateZ(0); }
/* 尊重「减少动态效果」偏好：只留静止态描边，不闪 */
@media (prefers-reduced-motion: reduce) {
  .audio-highlight { animation: none; }
}
`.trim();

export function generateAudioHighlightScript(): string {
  return `
(function(){
  var audio = document.getElementById("audio-player");
  var dataEl = document.getElementById("audio-segments");
  if (!audio || !dataEl) return;
  var segments;
  try { segments = JSON.parse(dataEl.textContent || "[]"); } catch(e) { return; }
  if (!Array.isArray(segments) || segments.length === 0) return;

  var lastId = null;
  function currentSegment(t) {
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      if (t >= s.startSec && t < s.startSec + s.durationSec) return s;
    }
    return null;
  }
  function clearAll() {
    var els = document.querySelectorAll(".audio-highlight");
    for (var i = 0; i < els.length; i++) els[i].classList.remove("audio-highlight");
  }
  function applyHighlight(seg) {
    if (!seg) { lastId = null; return; }
    if (seg.id === lastId) return;
    clearAll();
    var cards = document.querySelectorAll('[data-audio-section="' + seg.id + '"]');
    for (var i = 0; i < cards.length; i++) cards[i].classList.add("audio-highlight");
    lastId = seg.id;
  }
  audio.addEventListener("timeupdate", function() {
    var seg = currentSegment(audio.currentTime || 0);
    applyHighlight(seg);
  });
  audio.addEventListener("ended", function() { clearAll(); lastId = null; });
  audio.addEventListener("seeked", function() {
    var seg = currentSegment(audio.currentTime || 0);
    applyHighlight(seg);
  });
})();
`;
}
