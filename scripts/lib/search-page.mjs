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
  @media (prefers-color-scheme: dark) { :root { --bg:#141414; --card:#1e1e1e; --fg:#e8e8e8; --rule:#2e2e2e; } }
</style>
</head>
<body>
  <h1>🔍 检索与主题归档</h1>
  <p class="meta">共 ${kept.length} 期 / ${total} 条${generatedAt ? ` · 索引生成于 ${esc(generatedAt)}` : ""} · <a href="./index.html">最新一期（${esc(latest)}）</a> · <a href="./archive.html">归档</a></p>
  <input type="search" id="q" placeholder="输入关键词（标题 / 摘要 / 来源 / 标签）" autocomplete="off">
  <div class="rowlabel">板块</div>
  <div class="chips" id="sec-chips"></div>
  <div class="rowlabel">主题（客群 · 业务线 · 标签）</div>
  <div class="chips" id="tag-chips"></div>
  <div class="count" id="count"></div>
  <ul id="list"></ul>
  <div class="empty" id="empty" hidden>没有匹配结果。试试更短的关键词，或点「全部」清空筛选。</div>

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
  syncChips(); render();
})();
</script>
</body>
</html>
`;
}
