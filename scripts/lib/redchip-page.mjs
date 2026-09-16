#!/usr/bin/env node
/**
 * 红筹展示页渲染（纯 JS 模块）。
 *
 * 为什么是 .mjs 而不是 TS：发布根 `site/` 的**唯一写者**是 `scripts/build-site.mjs`，
 * 而 build-site 必须能被 `node scripts/build-site.mjs` 直接跑（测试用 spawnSync 调它），
 * 因此它不能 import .ts —— 展示页渲染逻辑以 .mjs 模块形式就近提供。
 *
 * 页面能力：清单（关键字段 + 发现时间 + 来源链接）+ 变更历史 + 筛选 + 排序（纯静态、无框架）。
 */

const DISCLAIMER = "公开信息初筛，线索 ≠ 结论，须回港交所原文复核";

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const VERDICT_LABEL = {
  redchip: "红筹",
  "non-redchip": "非红筹",
  unverified: "待核验",
};

const VIE_LABEL = {
  current: "现行",
  historical: "已终止",
  none: "无",
  unverified: "未核验",
};

function changeTypeLabel(t) {
  return t === "added" ? "新增" : t === "removed" ? "移除" : "变更";
}

/**
 * 单行。
 *
 * @param p 快照条目
 * @param reportHrefs `leadId|appId → 报告页相对路径`；**只含确实生成了页面**的线索
 *   （由 build-site 在生成报告页后回填）——避免总览页出现指向不存在文件的死链。
 */
function rowOf(p, reportHrefs) {
  const verdict = VERDICT_LABEL[p.verdict] ?? p.verdict;
  const proof = p.sourceUrl
    ? `<a href="${esc(p.sourceUrl)}" target="_blank" rel="noopener noreferrer">原文</a>`
    : "—";
  const href = reportHrefs?.get(String(p.leadId ?? "")) ?? reportHrefs?.get(String(p.appId ?? ""));
  const report = href ? `<a class="rpt" href="${esc(href)}">报告</a>` : "—";
  return `      <tr data-verdict="${esc(p.verdict)}" data-board="${esc(p.board)}" data-offshore="${esc(
    String(p.isOffshore),
  )}" data-gd="${esc(String(p.isGdConnected))}" data-name="${esc(p.nameCn || p.nameEn)}" data-discovered="${esc(
    p.discoveredAt,
  )}" data-submit="${esc(p.submitDate ?? "")}">
        <td class="nm">${esc(p.nameCn || p.nameEn)}<div class="en">${esc(p.nameEn || "")}</div></td>
        <td>${esc(p.board)}</td>
        <td>${esc(p.status)}</td>
        <td>${esc(p.submitDate ?? "—")}</td>
        <td>${esc(p.domicile ?? "未识别")}${p.isOffshore ? ' <span class="tag t-off">离岸</span>' : ""}</td>
        <td class="num">${esc(p.gdCityHits)}${p.isGdConnected ? ' <span class="tag t-gd">粤</span>' : ""}</td>
        <td>${esc(VIE_LABEL[p.vie] ?? p.vie)}</td>
        <td><span class="tag t-${esc(p.verdict)}">${esc(verdict)}</span></td>
        <td class="dt">${esc(String(p.discoveredAt).slice(0, 10))}</td>
        <td>${proof}</td>
        <td>${report}</td>
      </tr>`;
}

/**
 * @param {{snapshot: {capturedAt:string,count:number,projects:Array}|null, changes: Array,
 *          reportHrefs?: Map<string,string>}} input
 *   reportHrefs：`leadId|appId → 报告页相对路径`（build-site 生成报告页后回填；
 *   缺失时「报告」列一律显示 —，不臆造链接）
 * @returns {string} HTML
 */
export function renderRedchipPage({ snapshot, changes, reportHrefs }) {
  const projects = snapshot?.projects ?? [];
  const rows = projects.map((p) => rowOf(p, reportHrefs)).join("\n");
  const changeRows = (changes ?? [])
    .slice()
    .reverse()
    .map(
      (c) => `      <tr>
        <td class="dt">${esc(String(c.at).slice(0, 10))}</td>
        <td><span class="tag t-${esc(c.type)}">${esc(changeTypeLabel(c.type))}</span></td>
        <td>${esc(c.appId)}</td>
        <td>${esc(c.nameCn ?? "")}</td>
        <td>${esc(c.field ?? "—")}</td>
        <td>${esc(c.from ?? "—")} → ${esc(c.to ?? "—")}</td>
        <td>${c.sourceUrl ? `<a href="${esc(c.sourceUrl)}" target="_blank" rel="noopener noreferrer">原文</a>` : "—"}</td>
      </tr>`,
    )
    .join("\n");

  const redchipCount = projects.filter((p) => p.verdict === "redchip").length;

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>红筹项目监测</title>
<style>
body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;margin:1.5rem;color:#1a1a1f;background:#f6f5f3}
h1{font-size:1.3rem;margin:0 0 .3rem}
h2{font-size:1.05rem;margin:1.8rem 0 .6rem}
.sub{color:#797986;font-size:.85rem;margin-bottom:1rem}
.bar{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin-bottom:.8rem}
select,input{padding:.35rem .5rem;border:1px solid #ddd;border-radius:.4rem;font-size:.85rem;background:#fff}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e7e5e1;border-radius:.5rem;overflow:hidden}
th,td{padding:.5rem .6rem;border-bottom:1px solid #f0eeeb;text-align:left;vertical-align:top;font-size:.85rem}
th{background:#faf9f7;cursor:pointer;user-select:none;white-space:nowrap}
th:hover{background:#f2f0ec}
.nm{font-weight:600;min-width:12rem}
.en{color:#9a9aa4;font-size:.75rem;font-weight:400}
.num{text-align:right}
.dt{white-space:nowrap;color:#4a4a52}
.tag{display:inline-block;border-radius:.35rem;padding:.05rem .4rem;font-size:.75rem}
.t-redchip{background:#fde8e8;color:#c01c1c}
.t-non-redchip{background:#eef0f2;color:#6b7280}
.t-unverified{background:#e6e9fd;color:#3b36a8}
.t-off{background:#fdf0d9;color:#9a5b09}
.t-gd{background:#e6f7ee;color:#059669}
.t-added{background:#e6f7ee;color:#059669}
.t-removed{background:#fde8e8;color:#c01c1c}
.t-changed{background:#e6e9fd;color:#3b36a8}
.empty{padding:1.2rem;color:#797986;font-size:.9rem}
.warn{margin-top:1.5rem;padding:.8rem 1rem;background:#fdf0d9;border-radius:.5rem;color:#9a5b09;font-size:.85rem}
a{color:#2f4cdd}
</style></head><body>
<h1>红筹项目监测</h1>
<div class="sub">快照时间 ${esc(snapshot?.capturedAt ?? "—")} · 共 ${projects.length} 家（红筹 ${redchipCount}）· 口径：境外注册 ∧ 广东运营实体词频 ≥ 3</div>

<h2>项目清单</h2>
<div class="bar">
  <select id="fVerdict"><option value="">全部判定</option><option value="redchip">红筹</option><option value="non-redchip">非红筹</option><option value="unverified">待核验</option></select>
  <select id="fBoard"><option value="">全部板块</option><option value="主板">主板</option><option value="GEM">GEM</option></select>
  <select id="fOff"><option value="">离岸不限</option><option value="true">仅离岸</option><option value="false">仅非离岸</option></select>
  <select id="fGd"><option value="">广东不限</option><option value="true">粤连接达标</option><option value="false">未达标</option></select>
  <input id="fName" placeholder="企业名称关键词" />
  <select id="sortBy"><option value="discovered">按发现时间</option><option value="submit">按递表日</option><option value="name">按企业名</option></select>
</div>
${
  projects.length === 0
    ? '<div class="empty">暂无数据（尚未生成快照）。</div>'
    : `<table id="tbl">
  <thead><tr>
    <th data-k="name">企业名称</th><th>板块</th><th>状态</th><th data-k="submit">递表日</th>
    <th>注册地</th><th>广东词频</th><th>VIE</th><th>判定</th><th data-k="discovered">发现时间</th><th>来源</th><th>报告</th>
  </tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`
}

<h2>变更历史</h2>
${
  (changes ?? []).length === 0
    ? '<div class="empty">暂无变更记录。</div>'
    : `<table>
  <thead><tr><th>时间</th><th>类型</th><th>申请编号</th><th>企业名</th><th>字段</th><th>变化</th><th>来源</th></tr></thead>
  <tbody>
${changeRows}
  </tbody>
</table>`
}

<div class="warn">⚠️ ${DISCLAIMER}。本页由公开招股书信息自动初筛生成，仅作线索，广东连接须回原文复核。</div>

<script>
(function(){
  var tbody = document.querySelector('#tbl tbody');
  if(!tbody) return;
  var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
  function apply(){
    var v=document.getElementById('fVerdict').value, b=document.getElementById('fBoard').value,
        o=document.getElementById('fOff').value, g=document.getElementById('fGd').value,
        n=document.getElementById('fName').value.trim().toLowerCase();
    rows.forEach(function(r){
      var ok = (!v||r.dataset.verdict===v) && (!b||r.dataset.board===b)
            && (!o||r.dataset.offshore===o) && (!g||r.dataset.gd===g)
            && (!n|| (r.dataset.name||'').toLowerCase().indexOf(n)>=0);
      r.style.display = ok? '' : 'none';
    });
    sort();
  }
  function sort(){
    var k=document.getElementById('sortBy').value;
    var key = k==='submit'?'submit': (k==='name'?'name':'discovered');
    var sorted = rows.slice().sort(function(a,b){
      var x=a.dataset[key]||'', y=b.dataset[key]||'';
      return key==='name' ? x.localeCompare(y,'zh') : (x<y?1:x>y?-1:0);
    });
    sorted.forEach(function(r){ tbody.appendChild(r); });
  }
  ['fVerdict','fBoard','fOff','fGd','fName','sortBy'].forEach(function(id){
    var el=document.getElementById(id); if(!el) return;
    el.addEventListener(el.tagName==='INPUT'?'input':'change', apply);
  });
  document.querySelectorAll('#tbl th[data-k]').forEach(function(th){
    th.addEventListener('click', function(){
      var map={name:'name',submit:'submit',discovered:'discovered'};
      document.getElementById('sortBy').value = map[th.dataset.k]||'discovered';
      apply();
    });
  });
})();
</script>
</body></html>`;
}
