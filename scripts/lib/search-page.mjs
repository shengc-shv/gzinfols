/**
 * 静态检索页（B1，2026-09-17）。
 *
 * 纯前端、零后端、零依赖：构建期把「每期 slim 索引」内联进页面（JSON in <script>），
 * 检索/主题归档全部在浏览器里做子串匹配。数据内联而非 fetch，是为了
 * ① 微信公众号/企微内置浏览器与 file:// 下都能用（fetch 相对路径在部分环境被拦）；
 * ② 不引入 CORS 与加载态复杂度。
 *
 * 安全：全部用 textContent / createTextNode 渲染（绝不用 innerHTML 拼数据），
 * 标题/摘要来自外部新闻源，**不做转义就拼串即 XSS**。
 *
 * 红线：索引由 `scripts/build-search-index.ts` 产出，已走渲染同源的加密资产过滤
 * （`stripCryptoNews`），检索页不再二次过滤——单一真源，避免口径漂移。
 */
const SECTION_LABEL = {
  gz_local: "广州本地",
  biz_insight: "业务启示",
  policy_market: "政策与市场",
  tech: "科技前沿",
  ipo: "广东IPO",
  must: "今日必读",
  insight: "商机洞察",
  risk: "风险提示",
  stock: "股市动态",
};

/** 检索页最多内联的期数（防止多年后单页过大；更早的期次走归档页）。 */
const MAX_DAYS = 120;

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderSearchPage({ days, generatedAt, latest }) {
  const kept = (days || []).slice(0, MAX_DAYS);
  const total = kept.reduce((n, d) => n + (d.items?.length || 0), 0);
  // 主题（标签）按出现次数降序，取前 24 个（再多就成噪声，且挤爆窄屏）
  const tagCount = new Map();
  for (const d of kept) for (const it of d.items || []) for (const g of it.g || []) tagCount.set(g, (tagCount.get(g) || 0) + 1);
  const tags = [...tagCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 24);

  const data = JSON.stringify({ days: kept, sections: SECTION_LABEL }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>检索 · 每日资信简报</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; --bg:#f6f5f3; --card:#fff; --fg:#1a1a1a; --muted:#888; --rule:#e6e4e0; --brand:#2563eb; }
  body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    max-width:760px; margin:0 auto; padding:1.2rem 1rem 4rem; line-height:1.6; background:var(--bg); color:var(--fg); }
  h1 { font-size:1.3rem; margin:0 0 .2rem; }
  .meta { color:var(--muted); font-size:.82rem; margin-bottom:1rem; }
  .meta a { color:var(--brand); }
  input[type=search] { width:100%; box-sizing:border-box; font-size:1rem; padding:.6rem .7rem;
    border:1px solid var(--rule); border-radius:10px; background:var(--card); color:var(--fg); }
  .chips { display:flex; flex-wrap:wrap; gap:.35rem; margin:.6rem 0 .2rem; }
  .chip { font-size:.78rem; line-height:1.9; padding:0 .55rem; border:1px solid var(--rule); border-radius:999px;
    background:var(--card); color:var(--fg); cursor:pointer; }
  .chip.on { background:var(--brand); border-color:var(--brand); color:#fff; }
  .rowlabel { font-size:.76rem; color:var(--muted); margin:.7rem 0 .2rem; }
  .count { font-size:.82rem; color:var(--muted); margin:.8rem 0 .4rem; }
  ul { list-style:none; padding:0; margin:0; }
  li { background:var(--card); border:1px solid var(--rule); border-radius:10px; padding:.6rem .75rem; margin-bottom:.5rem; }
  .t { font-size:.98rem; font-weight:600; }
  .t a { color:inherit; text-decoration:none; }
  .t a:hover { color:var(--brand); text-decoration:underline; }
  .sub { font-size:.76rem; color:var(--muted); margin-top:.15rem; }
  .x { font-size:.85rem; margin-top:.3rem; }
  mark { background:rgba(250,204,21,.55); color:inherit; border-radius:2px; }
  .empty { color:var(--muted); font-size:.9rem; padding:1rem 0; }
  /* B1 两期对比（2026-09-17） */
  .modes { display:flex; gap:.35rem; margin:.9rem 0 .2rem; }
  .mode { font:inherit; font-size:.85rem; line-height:2; padding:0 .8rem; border:1px solid var(--rule);
    border-radius:999px; background:var(--card); color:var(--fg); cursor:pointer; }
  .mode.on { background:var(--brand); border-color:var(--brand); color:#fff; font-weight:600; }
  .cmp-controls { display:flex; flex-wrap:wrap; gap:.6rem; align-items:center; margin:.7rem 0 .2rem; font-size:.85rem; }
  .cmp-controls select { font:inherit; font-size:.85rem; padding:.25rem .4rem; border:1px solid var(--rule);
    border-radius:8px; background:var(--card); color:var(--fg); }
  .cmp-sum { font-size:.82rem; color:var(--muted); margin:.5rem 0 .2rem; }
  .cmp-group { margin:.7rem 0 0; }
  .cmp-group h3 { font-size:.9rem; margin:0 0 .35rem; }
  .cmp-badge { display:inline-block; margin-left:.35rem; padding:0 .4rem; border-radius:8px;
    font-size:.68rem; font-weight:700; line-height:1.7; }
  .cmp-new { background:#1e7e34; color:#fff; }
  .cmp-gone { background:#b02a37; color:#fff; }
  .cmp-both { background:#eceef1; color:#5b6472; }
  .cmp-col { font-size:.78rem; color:var(--muted); }
  @media (prefers-color-scheme: dark) { :root { --bg:#141414; --card:#1e1e1e; --fg:#e8e8e8; --rule:#2e2e2e; } }
</style>
</head>
<body>
  <h1>🔍 检索与主题归档</h1>
  <p class="meta">共 ${kept.length} 期 / ${total} 条${generatedAt ? ` · 索引生成于 ${esc(generatedAt)}` : ""} · <a href="./index.html">最新一期（${esc(latest)}）</a> · <a href="./archive.html">归档</a></p>
  <div class="modes">
    <button type="button" class="mode on" data-mode="search">🔍 检索</button>
    <button type="button" class="mode" data-mode="compare">⇄ 两期对比</button>
  </div>

  <div id="search-pane">
    <input type="search" id="q" placeholder="输入关键词（标题 / 摘要 / 来源 / 标签）" autocomplete="off">
    <div class="rowlabel">板块</div>
    <div class="chips" id="sec-chips"></div>
    <div class="rowlabel">主题（客群 · 业务线 · 标签）</div>
    <div class="chips" id="tag-chips"></div>
    <div class="count" id="count"></div>
    <ul id="list"></ul>
    <div class="empty" id="empty" hidden>没有匹配结果。试试更短的关键词，或点「全部」清空筛选。</div>
  </div>

  <div id="compare-pane" hidden>
    <div class="cmp-controls">
      <label>对照 A（较早）<select id="cmp-a"></select></label>
      <label>对照 B（较新）<select id="cmp-b"></select></label>
    </div>
    <div class="cmp-sum" id="cmp-sum"></div>
    <div id="cmp-result"></div>
  </div>

<script type="application/json" id="search-data">${data}</script>
<script>
(function(){
  var el = document.getElementById('search-data');
  var DATA;
  try { DATA = JSON.parse(el.textContent || '{}'); } catch(e) { DATA = {}; }
  var days = DATA.days || [], SECTIONS = DATA.sections || {};
  var q = document.getElementById('q');
  var list = document.getElementById('list');
  var emptyBox = document.getElementById('empty');
  var countBox = document.getElementById('count');
  var secBox = document.getElementById('sec-chips');
  var tagBox = document.getElementById('tag-chips');
  var state = { sec: '', tag: '' };

  function makeChip(box, label, value, group, extra) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = extra ? label + ' ' + extra : label;
    b.addEventListener('click', function () {
      state[group] = (state[group] === value) ? '' : value;
      syncChips(); render();
    });
    b.dataset.group = group; b.dataset.value = value;
    box.appendChild(b);
  }
  function syncChips() {
    [secBox, tagBox].forEach(function (box) {
      box.querySelectorAll('.chip').forEach(function (c) {
        c.classList.toggle('on', state[c.dataset.group] === c.dataset.value);
      });
    });
  }
  makeChip(secBox, '全部', '', 'sec');
  Object.keys(SECTIONS).forEach(function (k) {
    makeChip(secBox, SECTIONS[k], k, 'sec');
  });
  makeChip(tagBox, '全部', '', 'tag');
  ${JSON.stringify(tags.map(([t, n]) => [t, n]))}.forEach(function (p) {
    makeChip(tagBox, p[0], p[0], 'tag', '(' + p[1] + ')');
  });

  function hit(it, kw) {
    if (!kw) return true;
    var hay = (it.t || '') + ' ' + (it.x || '') + ' ' + (it.s || '') + ' ' + (it.g || []).join(' ');
    return hay.toLowerCase().indexOf(kw) >= 0;
  }
  // 用 textContent 渲染（绝不拼 innerHTML——标题摘要来自外部源，拼串即 XSS）
  function markInto(node, text, kw) {
    if (!kw) { node.appendChild(document.createTextNode(text)); return; }
    var lower = text.toLowerCase(), i = 0, idx;
    while ((idx = lower.indexOf(kw, i)) >= 0) {
      if (idx > i) node.appendChild(document.createTextNode(text.slice(i, idx)));
      var m = document.createElement('mark');
      m.textContent = text.slice(idx, idx + kw.length);
      node.appendChild(m);
      i = idx + kw.length;
    }
    if (i < text.length) node.appendChild(document.createTextNode(text.slice(i)));
  }
  function render() {
    var kw = (q.value || '').trim().toLowerCase();
    var out = 0;
    list.innerHTML = '';
    for (var di = 0; di < days.length; di++) {
      var day = days[di];
      var items = day.items || [];
      for (var ii = 0; ii < items.length; ii++) {
        var it = items[ii];
        if (state.sec && it.k !== state.sec) continue;
        if (state.tag && (it.g || []).indexOf(state.tag) < 0) continue;
        if (!hit(it, kw)) continue;
        out++;
        var li = document.createElement('li');
        var t = document.createElement('div'); t.className = 't';
        var a = document.createElement('a');
        // 深链到当天页面的卡片锚点（页面加载时会切面板 + 展开折叠并定位）；
        // 老页面（A2 前生成）没有锚点 → 只链到当期页，避免死链
        a.href = './' + day.date + '/' + day.date + '.html' +
          (day.anchored === false ? '' : '#itm-' + String(it.i || '').replace(/^itm-/, ''));
        markInto(a, it.t || '(无标题)', kw);
        t.appendChild(a);
        var sub = document.createElement('div'); sub.className = 'sub';
        sub.textContent = day.date + ' · ' + (SECTIONS[it.k] || it.k) + (it.s ? ' · ' + it.s : '') + (it.d ? ' · ' + it.d : '');
        var x = document.createElement('div'); x.className = 'x';
        markInto(x, it.x || '', kw);
        li.appendChild(t); li.appendChild(sub); if (it.x) li.appendChild(x);
        list.appendChild(li);
      }
    }
    countBox.textContent = out ? ('命中 ' + out + ' 条' + (kw ? '（关键词：' + kw + '）' : '') + ' · 点标题直达当期卡片') : '';
    emptyBox.hidden = out > 0;
  }
  q.addEventListener('input', render);

  // ---------- 两期对比（B1，2026-09-17）----------
  // 目的：把「这一期和上一期到底差在哪」变成两次点击。判定「同一主题」用
  // 条目 ID（同 URL 跨期稳定）→ 主题标签交集 ≥2 → 标题前 12 字相同，逐级放宽。
  // 全部 DOM 渲染（textContent），不拼 innerHTML。
  var modeBtns = document.querySelectorAll('.mode');
  var searchPane = document.getElementById('search-pane');
  var comparePane = document.getElementById('compare-pane');
  var selA = document.getElementById('cmp-a');
  var selB = document.getElementById('cmp-b');
  var cmpSum = document.getElementById('cmp-sum');
  var cmpResult = document.getElementById('cmp-result');

  function fillSelect(sel, defIdx) {
    days.forEach(function (d) {
      var o = document.createElement('option');
      o.value = d.date;
      o.textContent = d.date + '（' + (d.items || []).length + ' 条）';
      sel.appendChild(o);
    });
    if (days[defIdx]) sel.value = days[defIdx].date;
  }
  if (selA && selB && days.length) {
    fillSelect(selA, Math.min(1, days.length - 1)); // A 默认「上一期」
    fillSelect(selB, 0); // B 默认「最新一期」
    if (days.length === 1) {
      cmpSum.textContent = '当前索引只有 1 期，暂无可对比对象（等下一期发布后即可对比）。';
    }
  }
  function normTitle(t) { return String(t || '').replace(/\\s+/g, '').slice(0, 12); }
  function sameTopic(a, b) {
    if (a.i && b.i && a.i === b.i) return true;
    var ga = a.g || [], gb = b.g || [];
    var inter = 0;
    for (var i = 0; i < ga.length; i++) if (gb.indexOf(ga[i]) >= 0) inter++;
    if (inter >= 2) return true;
    return normTitle(a.t) !== '' && normTitle(a.t) === normTitle(b.t);
  }
  function dayByDate(date) {
    for (var i = 0; i < days.length; i++) if (days[i].date === date) return days[i];
    return null;
  }
  function itemLink(it, date) {
    var a = document.createElement('a');
    a.href = './' + date + '/' + date + '.html' +
      (dayByDate(date) && dayByDate(date).anchored === false ? '' : '#itm-' + String(it.i || '').replace(/^itm-/, ''));
    a.textContent = it.t || '(无标题)';
    return a;
  }
  function groupsHtml(title, cls, rows) {
    var box = document.createElement('div');
    box.className = 'cmp-group';
    var h = document.createElement('h3');
    h.appendChild(document.createTextNode(title));
    var badge = document.createElement('span');
    badge.className = 'cmp-badge ' + cls;
    badge.textContent = String(rows.length);
    h.appendChild(badge);
    box.appendChild(h);
    if (!rows.length) {
      var p = document.createElement('div');
      p.className = 'empty';
      p.textContent = '（无）';
      box.appendChild(p);
      return box;
    }
    var ul = document.createElement('ul');
    rows.forEach(function (r) {
      var li = document.createElement('li');
      var t = document.createElement('div');
      t.className = 't';
      t.appendChild(itemLink(r.it, r.date));
      li.appendChild(t);
      var sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = r.date + ' · ' + (SECTIONS[r.it.k] || r.it.k) + (r.it.s ? ' · ' + r.it.s : '');
      li.appendChild(sub);
      ul.appendChild(li);
    });
    box.appendChild(ul);
    return box;
  }
  function renderCompare() {
    if (!cmpResult || !selA || !selB) return;
    var A = dayByDate(selA.value), B = dayByDate(selB.value);
    while (cmpResult.firstChild) cmpResult.removeChild(cmpResult.firstChild);
    if (!A || !B) return;
    // 让 A 永远是「较早」的那期（用户选反了就自动换位，避免「新增/消失」语义倒挂）
    if (A.date > B.date) { var tmp = A; A = B; B = tmp; }
    var matchedB = {};
    var both = [];
    (A.items || []).forEach(function (ia) {
      var hit = null;
      (B.items || []).forEach(function (ib, j) {
        if (matchedB[j]) return;
        if (!hit && sameTopic(ia, ib)) { hit = { j: j, it: ib }; }
      });
      if (hit) { matchedB[hit.j] = true; both.push({ date: A.date, it: ia, newer: hit.it }); }
    });
    var gone = (A.items || []).filter(function (ia) {
      return !(B.items || []).some(function (ib) { return sameTopic(ia, ib); });
    }).map(function (ia) { return { date: A.date, it: ia }; });
    var added = (B.items || []).filter(function (ib, j) { return !matchedB[j]; })
      .map(function (ib) { return { date: B.date, it: ib }; });

    cmpSum.textContent = 'A（较早）= ' + A.date + ' · ' + (A.items || []).length + ' 条 ／ B（较新）= ' +
      B.date + ' · ' + (B.items || []).length + ' 条 ／ 同主题 ' + both.length + ' 条';
    cmpResult.appendChild(groupsHtml('B 相对 A 新增', 'cmp-new', added));
    cmpResult.appendChild(groupsHtml('A 有、B 没有', 'cmp-gone', gone));
    cmpResult.appendChild(groupsHtml('两期延续的同一主题', 'cmp-both', both.map(function (r) {
      return { date: r.date + ' → ' + B.date, it: r.newer || r.it };
    })));
  }
  if (selA && selB) {
    selA.addEventListener('change', renderCompare);
    selB.addEventListener('change', renderCompare);
  }
  for (var mi = 0; mi < modeBtns.length; mi++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        var mode = btn.getAttribute('data-mode');
        for (var k = 0; k < modeBtns.length; k++) modeBtns[k].classList.toggle('on', modeBtns[k] === btn);
        searchPane.hidden = mode !== 'search';
        comparePane.hidden = mode !== 'compare';
        if (mode === 'compare') renderCompare();
      });
    })(modeBtns[mi]);
  }

  syncChips(); render();
})();
</script>
</body>
</html>
`;
}
