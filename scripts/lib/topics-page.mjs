/**
 * 主题跟踪时间线页（B2，2026-09-17）。
 *
 * 行长要的不是「今天有哪些条」，而是「**这件事后来怎么样了**」。
 * 本页把构建期聚类出的跨期主题按时间顺序铺开：一个主题一条时间线，
 * 节点可点回当期卡片（站内锚点），「持续 N 期」标出同一条新闻的连续出现。
 *
 * 数据在构建期内联（与 search.html 同款，不依赖 fetch），
 * 渲染全部走 DOM textContent（标题来自外部新闻源，拼 innerHTML 即 XSS）。
 */
const SECTIONS = {
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

/** 单页最多内联的主题数（与构建期的 maxTopics 对齐，双保险）。 */
const MAX_TOPICS = 40;

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderTopicsPage({ topics, generatedAt, latest }) {
  const kept = (topics || []).slice(0, MAX_TOPICS);
  const totalNodes = kept.reduce((n, t) => n + (t.nodes?.length || 0), 0);
  const data = JSON.stringify({ topics: kept, sections: SECTIONS }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>主题跟踪 · 每日资信简报</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; --bg:#f6f5f3; --card:#fff; --fg:#1a1a1a; --muted:#888; --rule:#e6e4e0; --brand:#2563eb; }
  body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    max-width:760px; margin:0 auto; padding:1.2rem 1rem 4rem; line-height:1.65; background:var(--bg); color:var(--fg); }
  h1 { font-size:1.3rem; margin:0 0 .2rem; }
  .meta { color:var(--muted); font-size:.82rem; margin-bottom:1.1rem; }
  .meta a { color:var(--brand); }
  .topic { background:var(--card); border:1px solid var(--rule); border-radius:10px; padding:.7rem .85rem; margin-bottom:.7rem; }
  .topic h2 { font-size:1rem; margin:0 0 .2rem; }
  .topic .sub { font-size:.76rem; color:var(--muted); }
  .chips { display:flex; flex-wrap:wrap; gap:.3rem; margin:.35rem 0 .1rem; }
  .chip { font-size:.7rem; line-height:1.8; padding:0 .4rem; border:1px solid var(--rule); border-radius:999px; color:var(--muted); }
  ol.tl { list-style:none; margin:.5rem 0 0; padding:0; }
  ol.tl li { position:relative; padding:0 0 .55rem 1.1rem; border-left:2px solid var(--rule); }
  ol.tl li:last-child { border-left-color:transparent; padding-bottom:0; }
  ol.tl li::before { content:""; position:absolute; left:-5px; top:.45rem; width:8px; height:8px; border-radius:50%; background:var(--brand); }
  .d { font-size:.74rem; color:var(--muted); font-variant-numeric:tabular-nums; margin-right:.4rem; }
  .t a { color:inherit; text-decoration:none; }
  .t a:hover { color:var(--brand); text-decoration:underline; }
  .tag2 { font-size:.7rem; color:var(--muted); margin-left:.4rem; }
  .repeat { display:inline-block; margin-left:.35rem; font-size:.68rem; padding:0 .35rem; border-radius:8px; background:#eceef1; color:#5b6472; }
  .empty { color:var(--muted); font-size:.9rem; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141414; --card:#1e1e1e; --fg:#e8e8e8; --rule:#2e2e2e; } .repeat { background:#2a2a2a; color:#aaa; } }
</style>
</head>
<body>
  <h1>🧭 主题跟踪</h1>
  <p class="meta">${kept.length} 个跨期主题 / ${totalNodes} 个进展节点${generatedAt ? ` · 索引生成于 ${esc(generatedAt)}` : ""} · <a href="./index.html">最新一期（${esc(latest)}）</a> · <a href="./search.html">🔍 检索</a> · <a href="./archive.html">归档</a></p>
  <div id="list"></div>
  <p class="empty" id="empty" hidden>暂无可跟踪的跨期主题（主题需在 ≥2 期中出现过）。</p>

<script type="application/json" id="topics-data">${data}</script>
<script>
(function(){
  var el = document.getElementById('topics-data');
  var DATA = {};
  try { DATA = JSON.parse(el.textContent || '{}'); } catch(e) { DATA = {}; }
  var topics = DATA.topics || [], SECTIONS = DATA.sections || {};
  var list = document.getElementById('list');
  if (!topics.length) { document.getElementById('empty').hidden = false; return; }
  topics.forEach(function(t){
    var box = document.createElement('div');
    box.className = 'topic';
    var h = document.createElement('h2');
    h.textContent = t.label || '(未命名主题)';
    box.appendChild(h);
    var sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = '跨 ' + (t.dates || []).length + ' 期（' + (t.dates[0] || '') + ' ~ ' +
      (t.dates[t.dates.length-1] || '') + '，约 ' + (t.spanDays || 1) + ' 天）';
    box.appendChild(sub);
    if ((t.tags || []).length) {
      var chips = document.createElement('div');
      chips.className = 'chips';
      t.tags.forEach(function(g){
        var c = document.createElement('span');
        c.className = 'chip';
        c.textContent = g;
        chips.appendChild(c);
      });
      box.appendChild(chips);
    }
    var ol = document.createElement('ol');
    ol.className = 'tl';
    (t.nodes || []).forEach(function(n){
      var li = document.createElement('li');
      var d = document.createElement('span');
      d.className = 'd';
      d.textContent = n.date || '';
      li.appendChild(d);
      var tw = document.createElement('span');
      tw.className = 't';
      var a = document.createElement('a');
      a.href = './' + n.date + '/' + n.date + '.html#itm-' + String(n.i || '').replace(/^itm-/, '');
      a.textContent = n.t || '(无标题)';
      tw.appendChild(a);
      li.appendChild(tw);
      var meta = document.createElement('span');
      meta.className = 'tag2';
      meta.textContent = (SECTIONS[n.k] || n.k) + (n.s ? ' · ' + n.s : '');
      li.appendChild(meta);
      if (n.repeat && n.repeat > 1) {
        var r = document.createElement('span');
        r.className = 'repeat';
        r.textContent = '持续 ' + n.repeat + ' 期';
        li.appendChild(r);
      }
      ol.appendChild(li);
    });
    box.appendChild(ol);
    list.appendChild(box);
  });
})();
</script>
</body>
</html>
`;
}
