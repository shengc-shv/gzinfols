/**
 * 红筹「会前版本」穿透分析报告页（plan-redchip-crawl-push §5.3）。
 *
 * ⚡ 零 LLM：本模块只用**写死的 HTML 模板 + 字符串拼接**，数据全部来自已结构化的
 * `RedchipLead` 与变更日志 —— 与 `redchip-page.mjs` 同一类工作，毫秒级、无外部调用。
 * 因此可以为**每一条**线索生成一页（覆盖率 100%，解决「点开是空的」）。
 *
 * 深度版覆盖（T6）：若存在 `site/redchip/deep/<id>.html` 或 `manual/<id>.html`，
 * 卡片入口会指向那一份（由 `adapters/redchip/report-resolver` 决定），本模块不参与。
 *
 * 水印：页面固定标注「会前版本 · 待深度核验」——红线「线索 ≠ 结论」。
 */

const VERDICT_LABEL = {
  redchip: "红筹线索",
  "non-redchip": "非红筹",
  unverified: "红筹线索·待核",
};

const VIE_LABEL = {
  current: "存在 VIE 架构（协议控制）",
  historical: "曾有 VIE 安排（已终止）",
  none: "未见 VIE 安排",
  unverified: "VIE 未核验",
};

/** HTML 转义（与站点其它页同口径）。 */
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 变更类型文案。 */
const CHANGE_LABEL = { added: "新增", removed: "移除", changed: "变更" };

function timelineRows(lead, changes) {
  const rows = [];
  if (lead.submitDate) rows.push([`${lead.submitDate}`, "递表", "官方申请版本呈交（窗口基准）"]);
  if (lead.discoveredAt) rows.push([lead.discoveredAt.slice(0, 10), "入监测", `首次进入红筹快照（${esc(lead.status || "状态未知")}）`]);
  for (const c of changes) {
    const when = String(c.at ?? "").slice(0, 10);
    if (c.type === "changed") {
      rows.push([when, CHANGE_LABEL.changed, `${esc(c.field ?? "字段")}：${esc(c.from ?? "—")} → ${esc(c.to ?? "—")}`]);
    } else if (c.type === "added") {
      rows.push([when, CHANGE_LABEL.added, "进入监测池"]);
    } else if (c.type === "removed") {
      rows.push([when, CHANGE_LABEL.removed, "离开监测池（撤表 / 已上市归档）"]);
    }
  }
  return rows
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([d, t, x]) => `<tr><td class="d">${esc(d)}</td><td class="t">${esc(t)}</td><td>${x}</td></tr>`)
    .join("");
}

/**
 * 渲染单条线索的会前版本报告页。
 *
 * @param {object} lead  RedchipLead
 * @param {object} opts  { changes?: RedchipChange[], capturedAt?: string }
 * @returns {string} 完整 HTML
 */
export function renderRedchipReport(lead, opts = {}) {
  const changes = (opts.changes ?? []).filter((c) => c.appId === lead.leadId);
  const label = VERDICT_LABEL[lead.verdict] ?? lead.verdict;
  const isRedchip = lead.verdict === "redchip";
  const badgeCls = isRedchip ? "b-redchip" : lead.verdict === "unverified" ? "b-unverified" : "b-non";

  const nameMain = lead.nameCn || lead.nameEn || lead.leadId;
  const nameAlt = lead.nameCn && lead.nameEn ? lead.nameEn : "";

  // 判定依据一句话（可核验，不写结论性表述）
  const basis = isRedchip
    ? `封面页注册地「${esc(lead.domicile || "—")}」属离岸法域 ∧ 集团实体语境下广东城市命中 ${lead.gdCityHits} 次（阈值 ≥ 3）`
    : lead.verdict === "unverified"
      ? "申请版本文本不可用（扫描件 / 抽取失败），判定证据不足 —— 待人工核验"
      : `未同时满足「离岸注册」与「广东运营」两条：注册地「${esc(lead.domicile || "—")}」，广东命中 ${lead.gdCityHits} 次`;

  const evidence = (lead.gdEvidence ?? [])
    .map((e) => `<li>${esc(e.text)}${e.page ? `<span class="pg">p.${esc(e.page)}</span>` : ""}</li>`)
    .join("");
  const arch = (lead.archNotes ?? []).map((n) => `<li>${esc(n)}</li>`).join("");

  const pdfLink = lead.sourceUrl
    ? `<a class="cta" href="${esc(lead.sourceUrl)}" target="_blank" rel="noopener">申请版本 PDF（港交所披露易）→</a>`
    : `<span class="muted">未记录申请版本链接</span>`;
  const deepLink = (lead.reports ?? [])
    .filter((r) => r.kind === "deep" || r.kind === "manual")
    .map((r) => `<a class="cta alt" href="${esc(r.url.replace(/^redchip\//, ""))}">${esc(r.title)} →</a>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(nameMain)} · 红筹穿透分析（会前版本）</title>
<meta name="robots" content="noindex">
<style>
  :root { color-scheme: light dark; --fg:#1a1a1a; --muted:#6b7280; --rule:#e5e7eb; --card:#fff; --bg:#f7f7f8; --red:#b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8e8ea; --muted:#9aa0a6; --rule:#33353a; --card:#1d1e22; --bg:#141518; --red:#f87171; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:1.25rem; background:var(--bg); color:var(--fg); font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif; }
  .wrap { max-width:820px; margin:0 auto; }
  .top { display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; margin-bottom:.35rem; }
  .badge { font-size:.72rem; font-weight:600; padding:2px 8px; border-radius:4px; }
  .b-redchip { background:var(--red); color:#fff; }
  .b-unverified { color:var(--red); border:1px solid var(--red); }
  .b-non { background:var(--rule); color:var(--muted); }
  .wm { margin-left:auto; font-size:.68rem; color:var(--red); border:1px dashed var(--red); border-radius:4px; padding:2px 8px; }
  h1 { font-size:1.25rem; margin:.1rem 0 .15rem; line-height:1.35; }
  .alt { color:var(--muted); font-size:.86rem; margin:0 0 .75rem; }
  .basis { background:color-mix(in srgb, var(--red) 8%, var(--card)); border-left:3px solid var(--red); padding:.6rem .8rem; border-radius:8px; margin:0 0 1rem; }
  section { background:var(--card); border:1px solid var(--rule); border-radius:12px; padding:.85rem 1rem; margin-bottom:.85rem; }
  h2 { font-size:.95rem; margin:0 0 .5rem; }
  table { width:100%; border-collapse:collapse; }
  td { padding:.28rem .4rem; border-bottom:1px solid var(--rule); vertical-align:top; }
  td.d { white-space:nowrap; color:var(--muted); width:6.6rem; }
  td.t { white-space:nowrap; width:3.4rem; color:var(--red); }
  ul { margin:.2rem 0 0; padding-left:1.1rem; }
  li { margin:.2rem 0; }
  .pg { color:var(--muted); margin-left:.35rem; font-size:.75rem; }
  .kv { display:grid; grid-template-columns:6rem 1fr; gap:.25rem .6rem; }
  .kv dt { color:var(--muted); }
  .kv dd { margin:0; }
  .cta { display:inline-block; margin-top:.4rem; margin-right:1rem; color:var(--red); text-decoration:none; font-size:.86rem; }
  .cta:hover { text-decoration:underline; }
  .muted { color:var(--muted); }
  .topnav { margin:0 0 .5rem; font-size:.82rem; }
  .topnav a { color:var(--muted); text-decoration:none; }
  .topnav a:hover { text-decoration:underline; }
  footer { color:var(--muted); font-size:.74rem; line-height:1.6; }
</style>
</head>
<body>
<div class="wrap">
  <p class="topnav"><a href="../index.html">← 红筹台账</a> · <a href="../../index.html">最新一期简报</a></p>
  <div class="top">
    <span class="badge ${badgeCls}">${esc(label)}</span>
    <span class="wm">会前版本 · 待深度核验</span>
  </div>
  <h1>${esc(nameMain)}</h1>
  ${nameAlt ? `<p class="alt">${esc(nameAlt)}</p>` : ""}
  <p class="basis"><strong>判定依据：</strong>${basis}</p>

  <section>
    <h2>架构穿透</h2>
    <dl class="kv">
      <dt>申请编号</dt><dd>${esc(lead.leadId)}</dd>
      <dt>注册地</dt><dd>${esc(lead.domicile || "—")}${lead.isOffshore ? "（离岸法域）" : ""}</dd>
      <dt>VIE</dt><dd>${esc(VIE_LABEL[lead.vie] ?? lead.vie ?? "—")}</dd>
      <dt>拟上市</dt><dd>${esc(lead.board || "—")}｜${esc(lead.status || "—")}</dd>
    </dl>
    ${arch ? `<ul>${arch}</ul>` : `<p class="muted">暂无架构要点（离岸地 / 持股路径 / VIE 安排）—— 待人工或深度版补充。</p>`}
  </section>

  <section>
    <h2>广东连接证据</h2>
    <p>集团实体语境下广东城市命中 <strong>${lead.gdCityHits}</strong> 次（阈值 ≥ 3）${lead.gdCityMentions ? ` · 全文裸提及 ${lead.gdCityMentions} 次` : ""}</p>
    ${evidence ? `<ul>${evidence}</ul>` : `<p class="muted">暂无原文摘录 —— 待深度版补充（可先点下方 PDF 核对封面与「业务／历史沿革」章）。</p>`}
  </section>

  <section>
    <h2>进展时间线</h2>
    <table><tbody>${timelineRows(lead, changes)}</tbody></table>
  </section>

  <section>
    <h2>官方入口</h2>
    ${pdfLink}
    ${deepLink}
  </section>

  <footer>
    <p>数据来源：港交所披露易「新上市申請版本及相關資料」（公开静态清单）。判定为**机器口径**：封面页固定句式取注册地 ∈ 离岸法域 ∧ 集团实体语境下广东城市命中 ≥ 3；「线索」不代表已确认的结论，亦不构成任何投资建议。</p>
    <p>抓取时刻：${esc(opts.capturedAt || "—")}${lead.lastChangedAt ? ` ｜ 最近变更：${esc(lead.lastChangedAt)}` : ""}</p>
  </footer>
</div>
</body>
</html>
`;
}
