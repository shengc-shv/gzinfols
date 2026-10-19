/**
 * 主题跟踪时间线页（B2 2026-09-17；2026-10-19 独立子模块改造）。
 *
 * 行长要的不是「今天有哪些条」，而是「**这件事后来怎么样了**」。
 * 本页把聚类出的跨期主题铺开：一个主题一条时间线，节点可点回当期卡片（站内锚点）。
 *
 * 2026-10-19 改造（sc 口径：用户为中心）：
 *  - **默认视图 = 本周有进展**（进页先回答「我盯的事后来怎么了」，不是节点最多的）；
 *  - **过滤只保留「主题」一个维度**（点一下唯一锚定）—— 排序固定质量分降序；
 *    板块与四种排序控件已于 10-19 按 sc 反馈移除（版本越少越不容易用错）；
 *  - **主题内时间线倒序**：最新进展在最上（打开就想看「后来怎么样了」，不该先翻历史）；
 *  - **质量分可视化**：分数 + 四因子条（连续性/新近度/重要性/密度），让排序可解释；
 *  - 节点展示具体日期（MM/DD，B 型修复前全部 undefined）；
 *  - 筛选状态写 URL hash（可分享、可刷新保持），格式 `#topic=<主题id>`；
 *  - 沉底主题（近 90 天无进展）默认折叠，不占首屏。
 *
 * 数据在构建期内联（与 search.html 同款，不依赖 fetch），
 * 渲染全部走 DOM textContent（标题来自外部新闻源，拼 innerHTML 即 XSS）。
 * 数据源优先级由调用方（build-site）决定：data/topics.json → build 索引 → 静态保底。
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

/** 单页最多内联的主题数（与聚类侧 maxTopics 对齐，双保险）。 */
const MAX_TOPICS = 40;

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 质量四因子的中文名（页面可解释「为什么排这里」）。 */
const QD_LABELS = { continuity: "连续性", recency: "新近度", importance: "重要性", density: "密度" };

export function renderTopicsPage({ topics, generatedAt, latest, corpus }) {
  const kept = (topics || []).slice(0, MAX_TOPICS);
  const totalNodes = kept.reduce((n, t) => n + (t.nodes?.length || 0), 0);
  const activeCount = kept.filter((t) => t.active && !t.dormant).length;
  const data = JSON.stringify({
    topics: kept,
    sections: SECTIONS,
    qdLabels: QD_LABELS,
    corpus: corpus || null,
  }).replace(/</g, "\\u003c");

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
  /* —— 控制条：主题过滤（唯一维度）+ 只看有新进展 —— */
  .bar { display:flex; flex-wrap:wrap; gap:.4rem; align-items:center; margin:0 0 .9rem; }
  .bar .grp { display:flex; flex-wrap:wrap; gap:.3rem; align-items:center; }
  .bar .lbl { font-size:.72rem; color:var(--muted); margin-right:.15rem; }
  .fchip { font-size:.72rem; line-height:1.8; padding:0 .5rem; border:1px solid var(--rule); border-radius:999px;
    background:var(--card); color:var(--fg); cursor:pointer; }
  .fchip[aria-pressed="true"] { background:var(--brand); border-color:var(--brand); color:#fff; }
  .fchip:hover { border-color:var(--brand); }
  .topic { background:var(--card); border:1px solid var(--rule); border-radius:10px; padding:.7rem .85rem; margin-bottom:.7rem; }
  .topic.dormant { opacity:.72; }
  .topic h2 { font-size:1rem; margin:0 0 .2rem; display:flex; align-items:baseline; gap:.45rem; }
  .q { font-size:.72rem; font-weight:600; color:var(--brand); font-variant-numeric:tabular-nums;
    border:1px solid var(--rule); border-radius:6px; padding:0 .3rem; }
  .sub { font-size:.76rem; color:var(--muted); }
  .chips { display:flex; flex-wrap:wrap; gap:.3rem; margin:.35rem 0 .1rem; }
  .chip { font-size:.7rem; line-height:1.8; padding:0 .4rem; border:1px solid var(--rule); border-radius:999px; color:var(--muted); }
  /* 「相关标签」前缀：明确这些标签只是描述，不是筛选维度（筛选只认主题） */
  .chip.lead { border:0; padding:0 .1rem; }
  /* —— 质量四因子条 —— */
  .qbar { display:flex; gap:.45rem; flex-wrap:wrap; margin:.35rem 0 .1rem; }
  .qf { font-size:.66rem; color:var(--muted); display:flex; align-items:center; gap:.2rem; }
  .qf i { display:block; width:34px; height:4px; border-radius:2px; background:var(--rule); position:relative; }
  .qf i b { position:absolute; left:0; top:0; bottom:0; border-radius:2px; background:var(--brand); }
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
  .dormant-h { font-size:.78rem; color:var(--muted); margin:1.1rem 0 .5rem; cursor:pointer; user-select:none; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141414; --card:#1e1e1e; --fg:#e8e8e8; --rule:#2e2e2e; } .repeat { background:#2a2a2a; color:#aaa; } }
</style>
</head>
<body>
  <h1>🧭 主题跟踪</h1>
  <p class="meta">${kept.length} 个跨期主题 / ${totalNodes} 个进展节点 · 本周有进展 <b>${activeCount}</b> 个${corpus ? ` · 语料 ${esc(corpus.span)}（${esc(String(corpus.days))} 期 / ${esc(String(corpus.items))} 条）` : ""}${generatedAt ? ` · 生成于 ${esc(generatedAt)}` : ""} · <a href="./index.html">最新一期（${esc(latest)}）</a> · <a href="./search.html">🔍 检索</a> · <a href="./archive.html">归档</a></p>

  <div class="bar" id="bar"></div>
  <div id="list"></div>
  <div class="dormant-h" id="dormant-h" hidden></div>
  <div id="dormant-list"></div>
  <p class="empty" id="empty" hidden>暂无可跟踪的跨期主题（主题需在 ≥2 期中出现过）。</p>

<script type="application/json" id="topics-data">${data}</script>
<script>
(function(){
  var el = document.getElementById('topics-data');
  var DATA = {};
  try { DATA = JSON.parse(el.textContent || '{}'); } catch(e) { DATA = {}; }
  var topics = DATA.topics || [], SECTIONS = DATA.sections || {}, QD = DATA.qdLabels || {};
  var list = document.getElementById('list');
  var bar = document.getElementById('bar');
  if (!topics.length) { document.getElementById('empty').hidden = false; return; }

  // —— 筛选状态（URL hash 持久化：可分享、刷新不丢）——
  // state.topic 存的是**主题 id**（唯一身份），不是标签 —— 见下方 TOPICS 的说明。
  // 2026-10-19 sc：去掉「排序」与「板块」两个控件 —— 主题是唯一入口，主题之间固定按质量分
  // 降序（高价值在前），板块只在节点行末作标注展示。旧链接里的排序/板块参数自动忽略。
  var state = { topic: '', only: false };
  function readHash() {
    var h = (location.hash || '').replace(/^#/, '');
    if (!h) return;
    var legacyTag = '';
    h.split('&').forEach(function(kv) {
      var p = kv.split('=');
      if (p[0] === 'topic') state.topic = decodeURIComponent(p[1] || '');
      // 兼容 2026-10-19 前的旧链接（#tag=原始标签）
      if (p[0] === 'tag') legacyTag = decodeURIComponent(p[1] || '');
      if (p[0] === 'only') state.only = p[1] === '1';
    });
    // 旧参数只在能**唯一**命中一个主题时才采用；否则忽略（回「全部」）——
    // 旧语义本身就不唯一（「财富」曾覆盖 9/12 个主题），不该把歧义带进新链接。
    if (legacyTag && !state.topic) {
      var cand = topics.filter(function(t) {
        return t.label === legacyTag || (t.tags || []).indexOf(legacyTag) >= 0;
      });
      if (cand.length === 1) state.topic = cand[0].id;
    }
  }
  function writeHash() {
    var parts = [];
    if (state.topic) parts.push('topic=' + encodeURIComponent(state.topic));
    if (state.only) parts.push('only=1');
    // ⚠️ 清空筛选时不能只写 pathname —— 会把 ?query 一起抹掉（预览/带参访问时会丢上下文）
    var url = location.pathname + location.search + (parts.length ? '#' + parts.join('&') : '');
    history.replaceState(null, '', url);
  }

  /**
   * 主题过滤维度 = **主题本身**（点击即唯一锚定，只显示这一个主题）。
   *
   * ⛔ 2026-10-19 修正：原实现把 t.tags（每张卡的相关标签）汇总成过滤项，再按
   * 「卡片 tags 含该标签」匹配 —— 而标签会跨主题共享（实测「财富」覆盖 9/12 个主题），
   * 于是点「财富」时「监管合规」等一堆主题也出来了（sc 实测反馈）。
   * 主题身份是**业务标签 + 分组**，不是标签集合，所以过滤必须按 id 精确匹配。
   */
  var TOPICS = topics.slice().sort(function(a, b) {
    return (b.q || 0) - (a.q || 0) || String(a.label).localeCompare(String(b.label));
  });

  function chip(label, pressed, onclick) {
    var c = document.createElement('button');
    c.className = 'fchip';
    c.type = 'button';
    c.textContent = label;
    c.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    c.onclick = onclick;
    return c;
  }
  function renderBar() {
    bar.textContent = '';
    // 「主题」组 = 主题清单（点一下就只看这一个，唯一锚定）。
    // 2026-10-19 sc：删掉「排序」「板块」两组 —— 主题是唯一入口，排序固定按质量分。
    var g1 = document.createElement('div'); g1.className = 'grp';
    var l1 = document.createElement('span'); l1.className = 'lbl'; l1.textContent = '主题';
    g1.appendChild(l1);
    g1.appendChild(chip('全部', !state.topic, function(){ state.topic = ''; writeHash(); render(); }));
    TOPICS.forEach(function(t) {
      g1.appendChild(chip(t.label, state.topic === t.id, function(){ state.topic = t.id; writeHash(); render(); }));
    });
    bar.appendChild(g1);
    var g2 = document.createElement('div'); g2.className = 'grp';
    g2.appendChild(chip('只看本周有新进展', state.only, function(){ state.only = !state.only; writeHash(); render(); }));
    bar.appendChild(g2);
  }

  function lastDate(t) { var d = t.dates || []; return d.length ? d[d.length-1] : ''; }
  /** 主题之间的固定排序：**质量分降序**，同分按最新进展降序（高价值在前）。 */
  function sortFn(a, b) {
    return (b.q||0)-(a.q||0) || lastDate(b).localeCompare(lastDate(a));
  }
  function visible(t) {
    // 主题过滤：按 id **精确匹配**（唯一锚定）
    if (state.topic && t.id !== state.topic) return false;
    if (state.only && !t.active) return false;
    return true;
  }

  function card(t) {
    var box = document.createElement('div');
    box.className = 'topic' + (t.dormant ? ' dormant' : '');
    var h = document.createElement('h2');
    h.textContent = t.label || '(未命名主题)';
    if (typeof t.q === 'number') {
      var q = document.createElement('span');
      q.className = 'q';
      q.textContent = t.q + ' 分';
      q.title = '质量分 = 连续性 40% + 新近度 25% + 重要性 25% + 密度 10%（零 LLM 启发式）';
      h.appendChild(q);
    }
    box.appendChild(h);
    var sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = '跨 ' + (t.dates || []).length + ' 期（' + lastDate(t) + ' 最新，约 ' + (t.spanDays || 1) + ' 天）' +
      (t.rawCount && t.rawCount > (t.nodes||[]).length ? ' · 去重前 ' + t.rawCount + ' 条' : '');
    box.appendChild(sub);
    if (t.qd) {
      var qb = document.createElement('div'); qb.className = 'qbar';
      Object.keys(QD).forEach(function(k) {
        var v = t.qd[k]; if (typeof v !== 'number') return;
        var f = document.createElement('span'); f.className = 'qf';
        var nm = document.createElement('span'); nm.textContent = QD[k];
        var it = document.createElement('i'); var b = document.createElement('b');
        b.style.width = Math.round(v * 100) + '%';
        it.appendChild(b);
        f.appendChild(nm); f.appendChild(it);
        qb.appendChild(f);
      });
      box.appendChild(qb);
    }
    // 「相关标签」：**不含主标签**（它已是卡片标题，重复显示是噪音），
    // 且带前缀「相关标签」—— 明确它只是描述，不是筛选维度（筛选只认主题，见 TOPICS）。
    var rel = (t.tags || []).slice(1);
    if (rel.length) {
      var chips = document.createElement('div'); chips.className = 'chips';
      var pre = document.createElement('span'); pre.className = 'chip lead'; pre.textContent = '相关标签';
      chips.appendChild(pre);
      rel.forEach(function(g) {
        var c = document.createElement('span'); c.className = 'chip'; c.textContent = g;
        chips.appendChild(c);
      });
      box.appendChild(chips);
    }
    var ol = document.createElement('ol'); ol.className = 'tl';
    (t.nodes || []).forEach(function(n) {
      var li = document.createElement('li');
      var d = document.createElement('span'); d.className = 'd';
      d.textContent = n.d || n.date || '';   // MM/DD（B 型修复后有值）
      li.appendChild(d);
      var tw = document.createElement('span'); tw.className = 't';
      var a = document.createElement('a');
      a.href = './' + n.date + '/' + n.date + '.html#itm-' + String(n.i || '').replace(/^itm-/, '');
      a.textContent = n.t || '(无标题)';
      tw.appendChild(a);
      li.appendChild(tw);
      var meta = document.createElement('span'); meta.className = 'tag2';
      meta.textContent = (SECTIONS[n.k] || n.k) + (n.s ? ' · ' + n.s : '');
      li.appendChild(meta);
      if (n.repeat && n.repeat > 1) {
        var r = document.createElement('span'); r.className = 'repeat';
        r.textContent = '持续 ' + n.repeat + ' 期';
        li.appendChild(r);
      }
      ol.appendChild(li);
    });
    box.appendChild(ol);
    return box;
  }

  function render() {
    renderBar(); writeHash();
    var act = topics.filter(function(t){ return t.active && !t.dormant; }).filter(visible).sort(sortFn);
    var dor = topics.filter(function(t){ return !(t.active && !t.dormant); }).filter(visible).sort(sortFn);
    list.textContent = '';
    act.forEach(function(t){ list.appendChild(card(t)); });
    var dh = document.getElementById('dormant-h'), dl = document.getElementById('dormant-list');
    if (dor.length) {
      dh.hidden = false;
      dh.textContent = '💤 沉底主题（近 90 天无新进展）' + dor.length + ' 个 —— 点击展开';
      dl.textContent = '';
      var open = false;
      dh.onclick = function() {
        open = !open;
        dl.textContent = '';
        if (open) { dor.forEach(function(t){ dl.appendChild(card(t)); }); dh.textContent = '💤 沉底主题 ' + dor.length + ' 个 —— 点击收起'; }
        else { dh.textContent = '💤 沉底主题（近 90 天无新进展）' + dor.length + ' 个 —— 点击展开'; }
      };
    } else { dh.hidden = true; dl.textContent = ''; }
    var none = !act.length && !dor.length;
    document.getElementById('empty').hidden = !none;
    if (none) document.getElementById('empty').textContent = '当前筛选条件下没有主题（试试清空筛选）。';
  }

  readHash();
  render();
})();
</script>
</body>
</html>
`;
}
