/**
 * 页面级操作（E2 复制/导出/收藏 + A4 反向「听这段」，2026-09-17）。
 *
 * 为什么做成「注入式工具条」而不是改每张卡片的模板：
 *  - 五类卡片（brief / must-card / insight / risk-card / ipo-card·stock-card）模板分散在
 *    四个模块里，逐个改要动模板 + 快照测试；注入让**所有卡片一次覆盖**、且老报告重渲染
 *    即生效；
 *  - 数据只从 DOM 读（标题 / 摘要 / 链接）与 `#audio-segments` 读，**不新增数据通道**，
 *    渲染层保持「只输出、不采集」。
 *
 * 三条能力都是**纯前端**：复制走剪贴板、收藏走 localStorage、导出走 Blob 下载 ——
 * 静态站零后端，不引入任何存储或账号。
 *
 * ⚠️ 不使用 `Date.now()`（服务层禁隐式时钟）：日期取自渲染期写入的
 * `<meta name="report-date">`，本身就是「报告日期」语义，比墙钟更正确。
 */
import { escapeHtml } from "./cards";

/** 工具条样式（工具条挂在卡片底部，不遮挡正文、不改卡片尺寸）。 */
export const PAGE_ACTIONS_CSS = `
/* E2/A4 卡片工具条（2026-09-17）：复制 · 收藏 · 听这段 */
.card-actions { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.45rem; }
.card-actions button {
  /* 2026-09-18：字号 0.68rem(10.9px) → 0.75rem(12px)；触摸热区另由
     mobile-opt.ts 的伪元素铺到 ≥44px（视觉尺寸不变，不拉长页面）。 */
  font: inherit; font-size: 0.75rem; line-height: 1.8; padding: 0 0.45rem;
  border: 1px solid var(--rule); border-radius: 999px;
  background: var(--bg-elevated); color: var(--muted); cursor: pointer;
}
.card-actions button:hover { color: var(--fg); border-color: var(--muted); }
.card-actions button.is-fav { color: #b8860b; border-color: #d4a017; font-weight: 700; }
.fav-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; margin: 0.6rem 0 0; font-size: 0.78rem; }
.fav-bar .fav-label { color: var(--muted); }
.fav-bar button {
  font: inherit; font-size: 0.78rem; line-height: 1.9; padding: 0 0.55rem;
  border: 1px solid var(--rule); border-radius: 999px;
  background: var(--bg-elevated); color: var(--fg); cursor: pointer;
}
.fav-bar button:hover { border-color: var(--muted); }
.fav-empty { color: var(--muted); font-size: 0.75rem; }
.fav-list { margin: 0.4rem 0 0; padding-left: 1.1rem; font-size: 0.8rem; line-height: 1.8; }
.fav-list a { color: var(--c-link, #2f4cdd); }
`.trim();

/** 收藏栏容器（脚本填充；无收藏时不显示列表）。 */
export function renderFavBar(): string {
  return `<div class="fav-bar" id="fav-bar" hidden>
  <span class="fav-label">⭐ 我的收藏</span>
  <button type="button" id="fav-export">导出本期（Markdown）</button>
  <button type="button" id="fav-clear">清空收藏</button>
  <span class="fav-empty" id="fav-empty"></span>
  <ol class="fav-list" id="fav-list"></ol>
</div>`;
}

/** 报告日期 meta（导出文件名 / 收藏归属；避免脚本读墙钟）。 */
export function renderReportDateMeta(date: string): string {
  return `<meta name="report-date" content="${escapeHtml(date)}">`;
}

/**
 * 工具条脚本。
 *
 * 注入的按钮：
 *  - 「复制」：把「标题 / 摘要 / 来源·日期 / 链接」写入剪贴板（备会材料最常用）；
 *  - 「收藏」：localStorage 存 { 日期, id, 标题, 链接 }，跨期可取回（同一浏览器）；
 *  - 「听这段」：仅当页面有音频与段落数据时出现（A4 反向）—— 点一下把播放器跳到该段。
 *
 * 全部按钮为 `type=button`，不触发卡片标题的详情页跳转；不修改卡片结构，只 append 一个工具栏。
 */
export function generatePageActionsScript(): string {
  return `
(function(){
  var meta = document.querySelector('meta[name="report-date"]');
  var PAGE_DATE = meta ? (meta.getAttribute('content') || '') : '';
  // 2026-09-18：不再包含 .must-card —— 它是 display:flex 的**横向单行**卡（80vw 宽），
  // 追加第三个 flex 子项后正文列被压到 142px（卡宽 300px 的 47%），「三件事」徽章与
  // 复制/收藏按钮逐字竖排。工具条是为整宽纵向卡设计的，横滑卡不适合承载；
  // 必读卡本身已是「点标题进正文」的入口，复制/收藏在正文卡上完成即可。
  var CARD_SEL = '.brief, .insight, .risk-card, .ipo-card, .stock-card';
  var audio = document.getElementById('audio-player');
  var segEl = document.getElementById('audio-segments');
  var SEGS = [];
  if (segEl) { try { SEGS = JSON.parse(segEl.textContent || '[]'); } catch (e) { SEGS = []; } }
  function segOf(id) { for (var i = 0; i < SEGS.length; i++) if (SEGS[i].id === id) return SEGS[i]; return null; }

  function textOf(el) { return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : ''; }
  function cardInfo(card) {
    var titleEl = card.querySelector('h3 a, h3, .must-body strong, .stock-card-head');
    var sumEl = card.querySelector('.sum, .must-why, .stock-overview');
    var linkEl = card.querySelector('a[href^="http"]');
    return {
      title: textOf(titleEl),
      sum: textOf(sumEl),
      url: linkEl ? linkEl.getAttribute('href') : '',
      id: card.id || ''
    };
  }
  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { legacyCopy(text); });
      return;
    }
    legacyCopy(text);
  }
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) {}
  }
  function copyForm(item) {
    var lines = [item.title];
    if (item.sum) lines.push(item.sum);
    var meta = [];
    if (item.src) meta.push(item.src);
    if (PAGE_DATE) meta.push(PAGE_DATE);
    if (meta.length) lines.push(meta.join(' · '));
    if (item.url) lines.push(item.url);
    return lines.join('\\n');
  }
  function flash(btn, txt) {
    var old = btn.textContent;
    btn.textContent = txt;
    setTimeout(function () { btn.textContent = old; }, 1200);
  }

  // —— 收藏（localStorage）——
  function favRead() {
    try { var v = JSON.parse(localStorage.getItem('gz_fav') || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function favWrite(list) {
    try { localStorage.setItem('gz_fav', JSON.stringify(list.slice(0, 300))); } catch (e) {}
    favRender();
  }
  function favKeyOf(card, info) { return PAGE_DATE + '|' + (info.id || info.title); }
  function favRender() {
    var bar = document.getElementById('fav-bar');
    var listEl = document.getElementById('fav-list');
    var emptyEl = document.getElementById('fav-empty');
    if (!bar || !listEl) return;
    var list = favRead();
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    if (!list.length) {
      if (emptyEl) emptyEl.textContent = '（尚未收藏任何条目）';
      bar.hidden = false;
      return;
    }
    if (emptyEl) emptyEl.textContent = '共 ' + list.length + ' 条';
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      var li = document.createElement('li');
      var y = document.createElement('span');
      y.textContent = (it.d || '') + ' ';
      li.appendChild(y);
      var href = it.h || it.u || '';
      if (href) {
        var a = document.createElement('a');
        a.href = href;
        a.textContent = it.t || '(无标题)';
        li.appendChild(a);
      } else {
        li.appendChild(document.createTextNode(it.t || '(无标题)'));
      }
      listEl.appendChild(li);
    }
    bar.hidden = false;
  }
  function markFavButtons() {
    var list = favRead();
    var keys = {};
    for (var i = 0; i < list.length; i++) keys[list[i].k] = true;
    document.querySelectorAll('.card-actions .act-fav').forEach(function (b) {
      var k = b.getAttribute('data-fav-key');
      b.classList.toggle('is-fav', !!keys[k]);
      b.textContent = keys[k] ? '★ 已收藏' : '☆ 收藏';
    });
  }

  // —— 批量导出（Markdown；纯前端 Blob 下载）——
  function exportMarkdown() {
    var lines = ['# 每日资信简报 ' + (PAGE_DATE || ''), ''];
    function block(title, cards) {
      if (!cards.length) return;
      lines.push('## ' + title, '');
      cards.forEach(function (c, i) {
        var info = cardInfo(c);
        lines.push((i + 1) + '. **' + (info.title || '(无标题)') + '**');
        if (info.sum) lines.push('   - ' + info.sum);
        if (info.url) lines.push('   - 原文：' + info.url);
      });
      lines.push('');
    }
    block('执行摘要 · 今日必读', Array.prototype.slice.call(document.querySelectorAll('.must-card')));
    block('执行摘要 · 商机洞察', Array.prototype.slice.call(document.querySelectorAll('.insight')));
    var riskCards = Array.prototype.slice.call(document.querySelectorAll('.risk-card'));
    if (riskCards.length) {
      var r = cardInfo(riskCards[0]);
      lines.push('## 执行摘要 · 风险预警', '');
      lines.push('1. **' + (r.title || '风险提示') + '**');
      if (r.sum) lines.push('   - ' + r.sum);
      lines.push('');
    }
    document.querySelectorAll('.panel').forEach(function (panel) {
      var tab = document.querySelector('.tabs > .tab[data-target="' + panel.id + '"]');
      var label = tab ? textOf(tab).replace(/\\d+$/, '') : panel.id;
      block(label, Array.prototype.slice.call(panel.querySelectorAll('.brief, .ipo-card')));
    });
    var text = lines.join('\\n');
    try {
      var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'briefing-' + (PAGE_DATE || 'report') + '.md';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    } catch (e) {
      copyToClipboard(text);
    }
  }

  // —— 工具栏注入（每张卡片一次）——
  document.querySelectorAll(CARD_SEL).forEach(function (card) {
    if (card.querySelector('.card-actions')) return; // 防重复注入（脚本重跑/浏览器恢复）
    var info = cardInfo(card);
    if (!info.title) return;
    var src = textOf(card.querySelector('.bm, .src-badge')) ;
    var bar = document.createElement('div');
    bar.className = 'card-actions';

    var btnCopy = document.createElement('button');
    btnCopy.type = 'button';
    btnCopy.className = 'act-copy';
    btnCopy.textContent = '⧉ 复制';
    btnCopy.addEventListener('click', function () {
      copyToClipboard(copyForm({ title: info.title, sum: info.sum, url: info.url, src: src }));
      flash(btnCopy, '✓ 已复制');
    });
    bar.appendChild(btnCopy);

    var btnFav = document.createElement('button');
    btnFav.type = 'button';
    btnFav.className = 'act-fav';
    var key = favKeyOf(card, info);
    btnFav.setAttribute('data-fav-key', key);
    btnFav.textContent = '☆ 收藏';
    btnFav.addEventListener('click', function () {
      var list = favRead();
      var idx = -1;
      for (var i = 0; i < list.length; i++) if (list[i].k === key) { idx = i; break; }
      if (idx >= 0) list.splice(idx, 1);
      else list.push({ k: key, d: PAGE_DATE, t: info.title, u: info.url, h: location.pathname + (card.id ? '#' + card.id : '') });
      favWrite(list);
      markFavButtons();
      flash(btnFav, idx >= 0 ? '已取消' : '✓ 已收藏');
    });
    bar.appendChild(btnFav);

    var sec = card.getAttribute('data-audio-section');
    var seg = sec ? segOf(sec) : null;
    if (audio && seg) {
      var btnPlay = document.createElement('button');
      btnPlay.type = 'button';
      btnPlay.className = 'act-listen';
      btnPlay.textContent = '▶ 听这段';
      btnPlay.addEventListener('click', function () {
        try { audio.currentTime = seg.startSec + 0.05; } catch (e) {}
        var p = audio.play();
        if (p && p.catch) p.catch(function () {});
        try { audio.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
      });
      bar.appendChild(btnPlay);
    }
    card.appendChild(bar);
  });

  var favBar = document.getElementById('fav-bar');
  var btnExport = document.getElementById('fav-export');
  if (btnExport) btnExport.addEventListener('click', exportMarkdown);
  var btnClear = document.getElementById('fav-clear');
  if (btnClear) {
    btnClear.addEventListener('click', function () {
      if (window.confirm('确定清空本机收藏？')) favWrite([]);
    });
  }
  if (favBar) favRender();
  markFavButtons();
})();
`;
}
