/**
 * 经营领域专题页（二期 WP10 · 2026-11-28）：把跨期资讯按六大经营领域聚合成一页。
 *
 * 数据源：`data/domains.json`（由 `scripts/domains-index.ts` 用**生产判定函数**
 * `classifyBusinessDomain` 生成）。页面只渲染，不重新判领域 —— 否则同一篇稿
 * 在日报里属「零售信贷」、在专题页属「财富管理」，读者会当成 bug。
 *
 * 与 topics.html / research.html / focus.html 同族：
 *  - 浅色卡片流、单列、系统字体；正文 16px / 辅助 13px；
 *  - 触摸目标 ≥44px，整卡可点；
 *  - **服务端渲染全部内容**，JS 只做领域/二级主题的显隐；
 *  - 空态说明「为什么空 + 什么时候会有」。
 *
 * 展示口径：每个领域给「条目数 + 二级主题分布 + 最近条目」，
 * 客群/产品/事件类型来自 `config/business-domains.json`（纯展示字段）。
 */

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 与 `lib/contracts/report.ts` SECTION_LABELS 同口径（plain node，无法 import TS）。 */
const SECTION_LABEL = {
  gz_local: "广州本地",
  biz_insight: "业务启示",
  policy_market: "政策与市场",
  tech: "科技前沿",
  ipo: "资本市场",
  // 语料里还带着卡片落位键（不是五大板块）：照着显示，别把英文键漏到页面上
  must: "今日必读",
  insight: "商机洞察",
  stock: "股市复盘",
  risk: "风险预警",
};

const CSS = `
  :root { --bg:#f6f6f8; --card:#fff; --ink:#1a1a1c; --muted:#6b6b73; --line:#e4e4e9; --accent:#185fa5; }
  * { box-sizing: border-box; }
  body { margin:0; padding:20px 14px 48px; background:var(--bg); color:var(--ink);
         font:16px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; }
  .wrap { max-width:760px; margin:0 auto; }
  h1 { margin:0 0 4px; font-size:22px; letter-spacing:.3px; }
  .sub { margin:0 0 14px; font-size:13px; color:var(--muted); line-height:1.7; }
  .back { display:inline-flex; align-items:center; gap:.25rem; min-height:36px; padding:6px 14px;
          margin:0 0 12px; border:1px solid var(--line); border-radius:999px; background:var(--card);
          color:var(--ink); font-size:14px; text-decoration:none; -webkit-tap-highlight-color:transparent; }
  .back:hover { border-color:var(--accent); color:var(--accent); }
  .back:active { transform:scale(.98); }
  @media (max-width:719.98px) { .back { min-height:44px; padding:8px 16px; font-size:15px; } }

  .bar { display:flex; gap:6px; margin:0 0 10px; overflow-x:auto; -webkit-overflow-scrolling:touch;
         padding-bottom:2px; scrollbar-width:none; }
  .bar::-webkit-scrollbar { display:none; }
  .chip { flex:0 0 auto; display:inline-flex; align-items:center; min-height:34px; padding:4px 12px;
          border:1px solid var(--line); border-radius:999px; background:var(--card); color:var(--ink);
          font:inherit; font-size:13px; line-height:1.4; cursor:pointer; -webkit-tap-highlight-color:transparent; }
  .chip[aria-pressed="true"] { background:#eaf1fa; border-color:#b9cdf0; color:var(--accent); font-weight:600; }
  .chip .c { color:#9a9aa2; font-weight:400; margin-left:4px; font-size:12px; }
  .chip:active { transform:scale(.98); }
  @media (max-width:719.98px) { .chip { min-height:44px; padding:8px 14px; font-size:14px; } }

  .dsec { margin:0 0 22px; }
  .dsec-h { display:flex; align-items:baseline; gap:8px; margin:0 0 4px; }
  .dsec-h h2 { margin:0; font-size:17px; }
  .dsec-h .n { font-size:12.5px; color:#9a9aa2; font-weight:400; }
  .dhint { margin:0 0 8px; font-size:12.5px; color:var(--muted); line-height:1.7; }
  .dlist { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; }
  .di { position:relative; padding:12px 14px; background:var(--card); border:1px solid var(--line);
        border-radius:12px; }
  .di:active { background:#f2f6fb; }
  .di-t { color:var(--accent); text-decoration:none; font-size:16px; line-height:1.5; display:block; }
  .di-t::after { content:""; position:absolute; inset:0; z-index:0; }
  .di-m { position:relative; z-index:1; margin:5px 0 0; font-size:13px; color:var(--muted); line-height:1.55; }
  .di-tag { display:inline-block; margin-right:6px; padding:0 6px; border-radius:5px;
            background:#f2f2f5; color:#5c5c66; font-size:11.5px; line-height:1.7; }
  .empty { padding:28px 18px; text-align:center; color:var(--muted); font-size:14px;
           background:var(--card); border:1px dashed var(--line); border-radius:12px; line-height:1.8; }
  .empty b { display:block; color:var(--ink); font-size:15px; margin-bottom:6px; }
  footer { margin-top:22px; font-size:12px; color:#9a9aa2; line-height:1.8; }
  .hidden { display:none !important; }
  @media (max-width:719.98px) { body { padding:16px 12px 40px; } .di { padding:13px 14px; } }
`;

function renderItem(it) {
  const title = esc(it.title || it.url || "（无标题）");
  const head = it.url
    ? `<a class="di-t" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${title}</a>`
    : `<span class="di-t">${title}</span>`;
  // 未知板块键不显示（宁可少一个标签，也不把 mystery_key 这种内部键漏到客户面前）
  const sec = SECTION_LABEL[it.section] || "";
  const sub = it.subtopic ? `<span class="di-tag">${esc(it.subtopic)}</span>` : "";
  // 来源名与板块名可能是同一个词（例：source=今日必读 + section=must → 都渲染成「今日必读」），
  // 重复显示会像 bug；相同就不重复。
  const secSame = sec && it.source && sec === it.source;
  return `<li class="di" data-domain="${esc(it.__domain)}" data-sub="${esc(it.subtopic || "其他")}">
    ${head}
    <p class="di-m">${sub}${esc(it.source || "")}${it.itemDate ? ` · ${esc(it.itemDate)}` : ""}${
      sec && !secSame ? ` · ${esc(sec)}` : ""
    }</p>
  </li>`;
}

export function renderDomainsPage({ index, generatedAt, latest } = {}) {
  const back = latest ? `./${latest}/${latest}.html` : "./index.html";
  const domains = (index && Array.isArray(index.domains) ? index.domains : []).filter((d) => d && d.id);
  const withItems = domains.filter((d) => (d.items || []).length > 0);
  const total = index && typeof index.total === "number" ? index.total : 0;
  const classified = index && typeof index.classified === "number" ? index.classified : 0;
  const runs = index && index.windowRuns ? index.windowRuns : 30;
  const base = (index && index.generatedAt) || "";

  const tabs = [
    `<button type="button" class="chip" data-filter-domain="" aria-pressed="true">全部</button>`,
    ...withItems.map(
      (d) =>
        `<button type="button" class="chip" data-filter-domain="${esc(d.id)}" aria-pressed="false">${esc(
          d.short,
        )}<span class="c">${d.count}</span></button>`,
    ),
  ].join("");

  const sections = withItems
    .map((d) => {
      const subs = [
        `<button type="button" class="chip" data-filter-sub="" aria-pressed="true">全部</button>`,
        ...(d.subtopics || []).map(
          (s) =>
            `<button type="button" class="chip" data-filter-sub="${esc(s.name)}" aria-pressed="false">${esc(
              s.name,
            )}<span class="c">${s.count}</span></button>`,
        ),
      ];
      // 没命中任何二级主题的条目归「其他」—— 给一个 chip，否则它们永远筛不出来
      const otherCount = (d.items || []).filter((it) => !it.subtopic).length;
      if (otherCount > 0) {
        subs.push(
          `<button type="button" class="chip" data-filter-sub="其他" aria-pressed="false">其他<span class="c">${otherCount}</span></button>`,
        );
      }
      const subBar = subs.join("");
      const hints = [
        d.segments && d.segments.length ? `常见客群：${d.segments.join(" / ")}` : "",
        d.products && d.products.length ? `相关产品：${d.products.join(" / ")}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const items = (d.items || [])
        .map((it) => renderItem({ ...it, __domain: d.id }))
        .join("");
      return `<section class="dsec" data-domain="${esc(d.id)}" id="d-${esc(d.id)}">
  <div class="dsec-h"><h2>${esc(d.name)}</h2><span class="n">${d.count} 条 · 近 ${runs} 期</span></div>
  ${hints ? `<p class="dhint">${esc(hints)}</p>` : ""}
  <div class="bar" role="group" aria-label="二级主题">${subBar}</div>
  <ul class="dlist">${items}</ul>
</section>`;
    })
    .join("");

  const empty = `<div class="empty">
    <b>还没有可归入经营领域的资讯</b>
    领域专题按跨期语料聚合，语料随每期日报累积。<br>
    当语料里出现可归入六大领域的资讯时，这里会自动出现内容。
  </div>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>经营领域专题${latest ? ` · ${latest}` : ""}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <a class="back" href="${back}">← 返回日报</a>
  <h1>经营领域专题</h1>
  <p class="sub">按六大经营领域聚合近 ${runs} 期资讯（${
    base ? `截至 ${esc(base)}` : "暂无基准期次"
  }）。领域归属由内容判定（标题 + 摘要 + 业务标签），不按来源分类。${
    total ? `近 ${runs} 期 ${total} 条中 ${classified} 条可归入领域，其余与六大领域无可靠关联，不硬凑。` : ""
  }</p>

  ${withItems.length ? `<div class="bar" role="group" aria-label="选择领域">${tabs}</div>${sections}` : empty}
  <div class="empty hidden" id="d-nowin"><b>该筛选下没有条目</b>换一个领域或二级主题看看。</div>

  <footer>
    数据源：跨期语料快照（data/topics-corpus.json）按生产判定函数归类 · 同一资讯跨期只出现一次（取最近一期）。<br>
    生成于 ${esc(generatedAt || "")}
  </footer>
</div>
<script>
(function () {
  var state = { domain: "", sub: "" };
  try {
    var q = new URLSearchParams(location.search);
    state.domain = q.get("d") || "";
    state.sub = q.get("s") || "";
  } catch (e) {}

  function apply() {
    var secs = document.querySelectorAll(".dsec");
    for (var i = 0; i < secs.length; i++) {
      var sec = secs[i];
      var secDomain = sec.getAttribute("data-domain");
      var domainOk = !state.domain || state.domain === secDomain;
      sec.classList.toggle("hidden", !domainOk);
      if (!domainOk) continue;
      var items = sec.querySelectorAll(".di");
      var visible = 0;
      for (var j = 0; j < items.length; j++) {
        var ok = !state.sub || items[j].getAttribute("data-sub") === state.sub;
        items[j].classList.toggle("hidden", !ok);
        if (ok) visible++;
      }
      // 二级主题 chip 的存在性：切换领域时只保留该领域的 chip 组可见
      var subBar = sec.querySelector(".bar");
      if (subBar) subBar.classList.toggle("hidden", !!state.domain && !domainOk);
      sec.setAttribute("data-visible", String(visible));
    }
    var visibleAny = false;
    for (var k = 0; k < secs.length; k++) {
      if (!secs[k].classList.contains("hidden") && +secs[k].getAttribute("data-visible") > 0) visibleAny = true;
    }
    var nowin = document.getElementById("d-nowin");
    if (nowin) nowin.classList.toggle("hidden", visibleAny);

    var btns = document.querySelectorAll("[data-filter-domain],[data-filter-sub]");
    for (var b = 0; b < btns.length; b++) {
      var el = btns[b];
      var pressed = el.hasAttribute("data-filter-domain")
        ? (el.getAttribute("data-filter-domain") || "") === state.domain
        : (el.getAttribute("data-filter-sub") || "") === state.sub;
      el.setAttribute("aria-pressed", pressed ? "true" : "false");
    }
    try {
      var p = new URLSearchParams();
      if (state.domain) p.set("d", state.domain);
      if (state.sub) p.set("s", state.sub);
      var qs = p.toString();
      history.replaceState(null, "", qs ? "?" + qs : location.pathname);
    } catch (e) {}
  }

  document.addEventListener("click", function (ev) {
    var t = ev.target;
    while (t && t !== document && !t.hasAttribute) t = t.parentNode;
    if (!t || !t.hasAttribute) return;
    if (t.hasAttribute("data-filter-domain")) {
      state.domain = t.getAttribute("data-filter-domain") || "";
      state.sub = ""; // 换领域时清掉二级主题（跨领域的同名主题不存在）
    } else if (t.hasAttribute("data-filter-sub")) {
      state.sub = t.getAttribute("data-filter-sub") || "";
    } else return;
    apply();
  });

  apply();
})();
</script>
</body>
</html>`;
}
