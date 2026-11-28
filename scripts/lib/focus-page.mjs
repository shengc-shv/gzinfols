/**
 * 经营重点追踪页（二期 WP9 · 2026-11-28）：把每日台账聚合成跨期专题页。
 *
 * 数据来源（**唯一**）：`data/focus-ledger.json` + `data/focus/versions.json`。
 * 为什么不用各期报告 JSON：线上不存每期报告（`build-site` 只发 html/audio），
 * 而 focus 命中是「跨期聚合」的内容 —— 只能靠随 daily 回流 main 的台账攒。
 * 这也是台账从上线第一天就要写的原因：页面先上，数据慢慢长。
 *
 * 设计口径（与 topics.html / research.html 同族）：
 *  - 浅色卡片流、单列、系统字体；正文 16px / 辅助 13px（手机不缩字号）；
 *  - 触摸目标 ≥44px；整行可点（标题 stretched 到卡片）；
 *  - **服务端渲染全部内容**，JS 只做筛选/排序的显隐（禁用 JS 也能完整阅读）；
 *  - 空态说清「为什么空 + 什么时候会有」，不是白屏。
 *
 * 三条硬口径（与台账契约一致，⛔ 页面不得各自解释）：
 *  1. 时间线只列 **M2/M3 实质命中**；M1 只体现在「近窗相关 N 条」计数里；
 *  2. 重点定义取**当日那个配置版本**的归档（改过词/改过名也能查到当时口径），
 *     找不到才退回最新版本 —— 绝不拿今天的定义解释三个月前的命中；
 *  3. 层级徽章与首页同字（年度重点 / 本季主攻 / 临时专项）。
 */

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 与 `lib/contracts/report.ts` 的 SECTION_LABELS 同口径（本脚本是 plain node，无法 import TS）。 */
const SECTION_LABEL = {
  gz_local: "广州本地",
  biz_insight: "业务启示",
  policy_market: "政策与市场",
  tech: "科技前沿",
  ipo: "资本市场",
};

/** 与首页 `focusTags()` 逐字同源（层级名）。 */
const LAYER_LABEL = {
  annual: "年度重点",
  quarterly: "本季主攻",
  temporary: "临时专项",
};
const LAYER_ORDER = { annual: 0, quarterly: 1, temporary: 2 };

const CSS = `
  :root { --bg:#f6f6f8; --card:#fff; --ink:#1a1a1c; --muted:#6b6b73; --line:#e4e4e9;
          --accent:#185fa5; --warm:#b4520c; --warm-bg:#fdf3e7; --hot:#8a1f1f; --hot-bg:#fbeeee; }
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

  /* 筛选条：横向可滑，不换行（手机端一行放不下时横滑，不堆成三行） */
  .bar { display:flex; gap:6px; margin:0 0 6px; overflow-x:auto; -webkit-overflow-scrolling:touch;
         padding-bottom:2px; scrollbar-width:none; }
  .bar::-webkit-scrollbar { display:none; }
  .bar .lbl { flex:0 0 auto; align-self:center; font-size:12px; color:var(--muted); margin-right:2px; }
  .chip { flex:0 0 auto; display:inline-flex; align-items:center; min-height:34px; padding:4px 12px;
          border:1px solid var(--line); border-radius:999px; background:var(--card); color:var(--fg,#1a1a1c);
          font:inherit; font-size:13px; line-height:1.4; cursor:pointer;
          -webkit-tap-highlight-color:transparent; }
  .chip[aria-pressed="true"] { background:#eaf1fa; border-color:#b9cdf0; color:var(--accent); font-weight:600; }
  .chip:active { transform:scale(.98); }
  @media (max-width:719.98px) { .chip { min-height:44px; padding:8px 14px; font-size:14px; } }

  h2 { margin:22px 0 10px; font-size:15px; color:var(--muted); font-weight:600; letter-spacing:.2px; }
  .hint { margin:0 0 12px; font-size:12.5px; color:#9a9aa2; line-height:1.7; }

  /* 重点卡 */
  .fcard { padding:13px 14px; background:var(--card); border:1px solid var(--line); border-radius:12px;
           margin:0 0 8px; }
  .fhead { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; }
  .fname { font-size:16px; font-weight:600; line-height:1.5; }
  .ftag { font-size:11.5px; line-height:1.6; padding:0 6px; border-radius:6px;
          border:1px solid var(--line); color:var(--muted); }
  .ftag.hot { background:var(--warm-bg); border-color:transparent; color:var(--warm); font-weight:600; }
  .fmeta { margin:5px 0 0; font-size:13px; color:var(--muted); line-height:1.6; }
  .fstat { margin:7px 0 0; display:flex; gap:12px; flex-wrap:wrap; font-size:13px; }
  .fstat b { font-size:15px; color:var(--accent); }
  .fstat .zero { color:#9a9aa2; }
  .fdef { margin:9px 0 0; border-top:1px dashed var(--line); padding-top:8px; }
  .fdef summary { cursor:pointer; font-size:12.5px; color:var(--muted); min-height:32px;
                  display:flex; align-items:center; }
  .fdef[open] summary { margin-bottom:6px; }
  .kw { display:flex; flex-wrap:wrap; gap:5px; }
  .kw span { font-size:12px; padding:1px 7px; border-radius:5px; background:#f2f2f5; color:#5c5c66; }
  .kw span.core { background:#eaf1fa; color:var(--accent); font-weight:600; }
  .kw span.ex { background:var(--hot-bg); color:var(--hot); }
  .dl { margin:8px 0 0; font-size:12.5px; color:var(--muted); line-height:1.7; }

  /* 时间线 */
  .fday { margin:0 0 16px; }
  .fday-h { display:flex; align-items:baseline; gap:8px; margin:0 0 8px; font-size:14px;
            color:var(--muted); font-weight:600; }
  .fday-h .n { font-weight:400; font-size:12.5px; color:#9a9aa2; }
  .flist { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; }
  .fh { position:relative; padding:12px 14px; background:var(--card); border:1px solid var(--line);
        border-radius:12px; }
  .fh:active { background:#f2f6fb; }
  .fh-t { color:var(--accent); text-decoration:none; font-size:16px; line-height:1.5; display:block; }
  .fh-t::after { content:""; position:absolute; inset:0; z-index:0; }
  .fh-m { position:relative; z-index:1; margin:5px 0 0; font-size:13px; color:var(--muted); line-height:1.55; }
  .fh-r { position:relative; z-index:1; margin:3px 0 0; font-size:12.5px; color:#8a8a93; line-height:1.6; }
  .fh-tags { position:relative; z-index:1; display:flex; flex-wrap:wrap; gap:5px; margin:7px 0 0; }
  .pill { font-size:11.5px; line-height:1.6; padding:0 7px; border-radius:6px; border:1px solid var(--line);
          color:var(--muted); }
  .pill.annual { background:#f2f2f5; }
  .pill.quarterly { background:var(--warm-bg); border-color:transparent; color:var(--warm); font-weight:600; }
  .pill.temporary { background:var(--hot-bg); border-color:transparent; color:var(--hot); font-weight:600; }
  .pill.m3 { background:#eaf1fa; border-color:transparent; color:var(--accent); }
  .pill.mustread { background:#eef7ee; border-color:transparent; color:#2f6b36; font-weight:600; }
  .pill.insight { background:#f0f0fb; border-color:transparent; color:#4a4a8f; font-weight:600; }
  .pill.risk { background:var(--hot-bg); border-color:transparent; color:var(--hot); font-weight:600; }

  .empty { padding:28px 18px; text-align:center; color:var(--muted); font-size:14px;
           background:var(--card); border:1px dashed var(--line); border-radius:12px; line-height:1.8; }
  .empty b { display:block; color:var(--ink); font-size:15px; margin-bottom:6px; }
  footer { margin-top:22px; font-size:12px; color:#9a9aa2; line-height:1.8; }
  .hidden { display:none !important; }
  @media (max-width:719.98px) {
    body { padding:16px 12px 40px; }
    .fh { padding:13px 14px; }
  }
`;

/** 日期相减（YYYY-MM-DD，纯字符串比较不用 Date 构造器；两端的日历日都在北京时区算好再传进来）。 */
function dayDiff(a, b) {
  if (!a || !b) return Infinity;
  const toUTC = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, (m || 1) - 1, d || 1);
  };
  return Math.round((toUTC(a) - toUTC(b)) / 86400000);
}

/** 窗口过滤（服务端先算默认 30 天；JS 切换时用同一口径的 dataset 判断）。 */
function inWindow(date, today, days) {
  if (days === 0) return true; // 全部
  const d = dayDiff(today, date);
  return d >= 0 && d < days;
}

/**
 * 汇总台账 → 页面模型。
 *
 * 合并口径：**重点 id 为键**（配置稳定标识，跨版本不变），名字/等级/领域取「最近一次命中」
 * 那天的定义；台量统计按窗口算。这样改名后不会在页面上裂成两条。
 */
function buildModel({ ledger, archive, today }) {
  const days = (ledger && Array.isArray(ledger.days) ? ledger.days : []).filter((d) => d && d.date);
  const versions = (archive && Array.isArray(archive.versions) ? archive.versions : []).filter((v) => v && v.version);
  /** version → (focusId → 定义) */
  const defByVersion = new Map();
  for (const v of versions) {
    const m = new Map();
    for (const f of v.focuses || []) if (f && f.id) m.set(f.id, f);
    defByVersion.set(v.version, m);
  }
  const latestDefs = versions.length ? defByVersion.get(versions[versions.length - 1].version) : null;

  /** @type {Map<string, any>} */
  const focuses = new Map();
  let orderSeq = 0;
  const rows = [];
  for (const d of days) {
    for (const f of d.focuses || []) {
      if (!f || !f.id) continue;
      let hit = focuses.get(f.id);
      if (!hit) {
        hit = {
          id: f.id,
          name: f.name,
          layer: f.layer,
          grade: f.grade,
          domains: f.domains || [],
          // 名字/等级以「最近一次出现」为准（days 已按日期降序）
          lastDate: d.date,
          // 配置顺序（首次出现时的下标）：页面按「层级 + 配置顺序」排，
          // ⛔ 不按 lastDate 排 —— 同一天三条重点的 lastDate 完全相同，比较器会退化成随机序。
          order: orderSeq++,
          definition: (defByVersion.get(d.version) || new Map()).get(f.id) || null,
          stat: { related: 0, real: 0, m3: 0, mustRead: 0, insight: 0, risk: 0, days: new Set() },
        };
        focuses.set(f.id, hit);
      }
      hit.stat.related += f.count || 0;
      hit.stat.real += f.high || 0;
      hit.stat.days.add(d.date);
    }
    for (const h of d.hits || []) {
      if (!h || !h.focusId) continue;
      // 孤儿命中（hits 有、当日 focuses 汇总里没有）不渲染：没有名字与层级，
      // 页面上只会变成一行「重点」标签的裸条目。台账自相矛盾时宁缺不错。
      if (!focuses.has(h.focusId)) continue;
      rows.push({ ...h, date: d.date, version: d.version });
    }
  }
  // 定义缺失时退回最新版本（历史版本补不上时仍能解释「这条重点现在是什么」）
  for (const f of focuses.values()) {
    if (!f.definition && latestDefs) f.definition = latestDefs.get(f.id) || null;
  }
  for (const r of rows) {
    const f = focuses.get(r.focusId);
    if (!f) continue;
    if (r.level === "M3") f.stat.m3 += 1;
    if (r.inMustRead) f.stat.mustRead += 1;
    if (r.inInsights) f.stat.insight += 1;
    if (r.isRisk) f.stat.risk += 1;
  }
  const list = [...focuses.values()].sort(
    (a, b) => (LAYER_ORDER[a.layer] ?? 9) - (LAYER_ORDER[b.layer] ?? 9) || a.order - b.order,
  );
  rows.sort((a, b) => (a.date === b.date ? (b.bonus || 0) - (a.bonus || 0) : a.date < b.date ? 1 : -1));
  return { days, versions, focuses: list, rows, latestVersion: versions.length ? versions[versions.length - 1] : null };
}

/** 单条命中的重要性排序键：风险 > 必读 > 商机 > 普通，同档按加分。 */
function rankOf(h) {
  return (h.isRisk ? 3 : 0) + (h.inMustRead ? 2 : 0) + (h.inInsights ? 1 : 0);
}

/** 一条命中（时间线里的一行）。 */
function renderHit(h) {
  const f = h.__focus;
  const layer = f ? f.layer : "annual";
  const sec = SECTION_LABEL[h.section] || h.section || "";
  const marks = [
    h.isRisk ? `<span class="pill risk">风险条目</span>` : "",
    h.inMustRead ? `<span class="pill mustread">今日必读</span>` : "",
    h.inInsights ? `<span class="pill insight">进商机</span>` : "",
  ].join("");
  const focusPill = f
    ? `<span class="pill ${esc(layer)}">${esc(LAYER_LABEL[layer] || "重点")}：${esc(f.name)}</span>` +
      `<span class="pill m3">${h.level === "M3" ? "精准命中" : "高度相关"}</span>`
    : "";
  const title = esc(h.title || h.url || "（无标题）");
  const body = h.url
    ? `<a class="fh-t" href="${esc(h.url)}" target="_blank" rel="noopener noreferrer">${title}</a>`
    : `<span class="fh-t">${title}</span>`;
  return `<li class="fh" data-date="${esc(h.date)}" data-focus="${esc(h.focusId)}"
      data-rank="${rankOf(h)}" data-bonus="${Number(h.bonus) || 0}"
      data-mark="${h.isRisk ? "risk" : h.inMustRead ? "mustread" : h.inInsights ? "insight" : "plain"}">
    ${body}
    <p class="fh-m">${esc(h.source || "")}${h.itemDate ? ` · ${esc(h.itemDate)}` : ""}${sec ? ` · ${esc(sec)}` : ""}</p>
    ${h.reason ? `<p class="fh-r">命中依据：${esc(h.reason)}</p>` : ""}
    <div class="fh-tags">${focusPill}${marks}</div>
  </li>`;
}

/** 一个重点的卡片（含定义折叠）。 */
function renderFocusCard(f, domainLabels) {
  const st = f.stat;
  const winReal = st.real;
  const layerHot = f.layer !== "annual";
  const d = f.definition || {};
  const core = (d.core_keywords || []).map((k) => `<span class="core">${esc(k)}</span>`).join("");
  const kw = (d.keywords || []).map((k) => `<span>${esc(k)}</span>`).join("");
  const ex = (d.exclude_keywords || []).map((k) => `<span class="ex">${esc(k)}</span>`).join("");
  const period = d.start_date || d.end_date ? `${esc(d.start_date || "—")} ~ ${esc(d.end_date || "—")}` : "未设结束日";
  return `<li class="fcard" data-focus="${esc(f.id)}">
    <div class="fhead">
      <span class="fname">${esc(f.name)}</span>
      <span class="ftag${layerHot ? " hot" : ""}">${esc(LAYER_LABEL[f.layer] || "重点")}</span>
      <span class="ftag">${esc(f.grade || "")} 级</span>
    </div>
    <p class="fmeta">${period}${
      f.domains.length
        ? ` · 关联领域 ${esc(f.domains.map((d) => domainLabels[d] || d).join(" / "))}`
        : ""
    }${
      d.description ? `<br>${esc(d.description)}` : ""
    }</p>
    <p class="fstat">
      <span>实质命中 <b>${winReal}</b> 条</span>
      <span${st.m3 ? "" : ' class="zero"'}>精准 ${st.m3}</span>
      <span${st.mustRead ? "" : ' class="zero"'}>必读 ${st.mustRead}</span>
      <span${st.insight ? "" : ' class="zero"'}>商机 ${st.insight}</span>
      <span${st.risk ? "" : ' class="zero"'}>风险 ${st.risk}</span>
      <span class="zero">相关 ${st.related} 条</span>
    </p>
    ${
      core || kw || ex
        ? `<details class="fdef"><summary>当时的判定词表（${(d.core_keywords || []).length + (d.keywords || []).length} 个）</summary>
      <div class="kw">${core}${kw}${ex}</div>
      ${d.source ? `<p class="dl">来源：${esc(d.source)}</p>` : ""}
    </details>`
        : ""
    }
  </li>`;
}

export function renderFocusPage({ ledger, archive, generatedAt, latest, today, windowDays = 30, domainLabels = {} } = {}) {
  const todayStr = today || generatedAt || "";
  const model = buildModel({ ledger, archive, today: todayStr });
  const back = latest ? `./${latest}/${latest}.html` : "./index.html";

  // 🔴 时间线渲染**全量**：窗口切换是纯前端显隐，「全部」必须能在 DOM 里找到更早的期次。
  //    若这里按 30 天裁剪，点「全部」只会看到 30 天内的 —— 全量数据一次性内嵌，
  //    台账一年也就几百行，不值得为体积再引入客户端取数。
  const byDate = new Map();
  for (const r of model.rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }
  // 「窗口内实质命中」统计要看窗口，重算一遍覆盖 buildModel 的全量口径
  const winStat = new Map();
  for (const r of model.rows) {
    if (!inWindow(r.date, todayStr, windowDays)) continue;
    const s = winStat.get(r.focusId) || { real: 0, m3: 0, mustRead: 0, insight: 0, risk: 0 };
    s.real += 1;
    if (r.level === "M3") s.m3 += 1;
    if (r.inMustRead) s.mustRead += 1;
    if (r.inInsights) s.insight += 1;
    if (r.isRisk) s.risk += 1;
    winStat.set(r.focusId, s);
  }
  for (const f of model.focuses) {
    const s = winStat.get(f.id);
    // related 是台账里的「相关总数」（含 M1），窗口切换后无法重算 → 明确标注为全量口径
    f.stat = {
      real: s ? s.real : 0,
      m3: s ? s.m3 : 0,
      mustRead: s ? s.mustRead : 0,
      insight: s ? s.insight : 0,
      risk: s ? s.risk : 0,
      related: f.stat.related,
      days: f.stat.days,
    };
  }

  const focusChips = model.focuses
    .map((f) => `<button type="button" class="chip" data-filter-focus="${esc(f.id)}" aria-pressed="false">${esc(f.name)}</button>`)
    .join("");

  const timeline = [...byDate.entries()]
    .map(([date, list]) => {
      const rowsHtml = list
        .map((r) => {
          r.__focus = model.focuses.find((f) => f.id === r.focusId) || null;
          return renderHit(r);
        })
        .join("");
      const gap = dayDiff(todayStr, date);
      const dayLabel = gap === 0 ? `${date}（今日）` : gap === 1 ? `${date}（昨日）` : date;
      return `<section class="fday" data-day="${esc(date)}">
    <div class="fday-h">${esc(dayLabel)}<span class="n">${list.length} 条实质命中</span></div>
    <ul class="flist">${rowsHtml}</ul>
  </section>`;
    })
    .join("");

  const emptyState = `<div class="empty">
    <b>还没有实质命中记录</b>
    本期重点功能已上线，命中台账从首期运行起逐日累积。<br>
    年度重点本身就不会天天有信号 —— 出现第一条 M2/M3 命中的那天，这里才会有内容。
  </div>`;

  const winHasHit = model.rows.some((r) => inWindow(r.date, todayStr, windowDays));
  const noHitInWindow = `<div class="empty" id="f-nowin"${winHasHit ? ' hidden' : ""}>
    <b>所选时间窗内没有实质命中</b>
    换一个时间窗看看（全部 / 30 天），或等下一次命中。
  </div>`;

  const coverDays = model.days.length;
  const latestDay = model.days[0] ? model.days[0].date : "";
  const totalHits = model.rows.length;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>经营重点追踪${latest ? ` · ${latest}` : ""}</title>
<style>${CSS}</style>
</head>
<body data-today="${esc(todayStr)}">
<div class="wrap">
  <a class="back" href="${back}">← 返回日报</a>
  <h1>经营重点追踪</h1>
  <p class="sub">按年度 / 季度 / 临时重点聚合各期日报的命中情报。只列 <b>M2 高度相关以上</b> 的实质命中；
  M1 弱相关只计入「相关 N 条」。${
    coverDays
      ? `当前覆盖 ${coverDays} 个期次（最新 ${esc(latestDay)}），累计 ${totalHits} 条实质命中。`
      : "目前尚无台账数据。"
  }</p>

  ${
    model.focuses.length
      ? `<div class="bar" role="group" aria-label="时间窗">
    <span class="lbl">时间</span>
    <button type="button" class="chip" data-filter-days="1" aria-pressed="false">今日</button>
    <button type="button" class="chip" data-filter-days="7" aria-pressed="false">7 天</button>
    <button type="button" class="chip" data-filter-days="30" aria-pressed="true">30 天</button>
    <button type="button" class="chip" data-filter-days="0" aria-pressed="false">全部</button>
  </div>
  <div class="bar" role="group" aria-label="按重点筛选">
    <span class="lbl">重点</span>
    <button type="button" class="chip" data-filter-focus="" aria-pressed="true">全部</button>
    ${focusChips}
  </div>
  <div class="bar" role="group" aria-label="排序">
    <span class="lbl">排序</span>
    <button type="button" class="chip" data-sort="recent" aria-pressed="true">最新</button>
    <button type="button" class="chip" data-sort="importance" aria-pressed="false">重要性</button>
  </div>
  <p class="hint">「相关」为台账全量口径（含弱相关），不随时间窗变化；其余计数按所选时间窗。</p>

  <h2>在跟的重点</h2>
  <ul class="flist" style="gap:8px">${model.focuses.map((f) => renderFocusCard(f, domainLabels)).join("")}</ul>

  <h2>实质命中的情报</h2>
  ${timeline}${totalHits ? noHitInWindow : emptyState}`
      : emptyState
  }

  <footer>
    数据来源：每期日报的经营重点命中台账（${
      model.latestVersion ? `当前配置版本 ${esc(model.latestVersion.version)}` : "无配置版本"
    }）· 时间线按北京时区期次日归档。<br>
    生成于 ${esc(generatedAt || todayStr || "")}${
      model.versions.length > 1 ? ` · 历史配置版本 ${model.versions.length} 个（命中条目按当时版本的定义判定）` : ""
    }
  </footer>
</div>
<script>
(function () {
  var body = document.body;
  var today = body.getAttribute("data-today") || "";
  var state = { days: ${Number(windowDays) || 30}, focus: "", sort: "recent" };

  function utc(s) { var p = String(s || "").split("-"); return Date.UTC(+p[0], (+p[1] || 1) - 1, +p[2] || 1); }
  function diffDays(a, b) { if (!a || !b) return 1e9; return Math.round((utc(a) - utc(b)) / 86400000); }

  // 入口参数：focus.html?f=<id>（首页重点模块点进来直接定位）
  try {
    var q = new URLSearchParams(location.search);
    var f = q.get("f");
    if (f) state.focus = f;
    var w = q.get("days");
    if (w !== null && w !== "") state.days = Number(w) || 0;
  } catch (e) {}

  function apply() {
    // 焦点筛选 + 时间窗 → 行显隐；组头无可见行则整组隐藏
    var rows = document.querySelectorAll(".fh");
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var okFocus = !state.focus || (r.getAttribute("data-focus") || "").split(" ").indexOf(state.focus) >= 0;
      var okDays = state.days === 0 || diffDays(today, r.getAttribute("data-date")) < state.days;
      r.classList.toggle("hidden", !(okFocus && okDays));
    }
    var groups = document.querySelectorAll(".fday");
    for (var g = 0; g < groups.length; g++) {
      var vis = groups[g].querySelectorAll(".fh:not(.hidden)").length;
      groups[g].classList.toggle("hidden", vis === 0);
      var n = groups[g].querySelector(".fday-h .n");
      if (n) n.textContent = vis + " 条实质命中";
    }
    // 一条可见行都没有 → 显示「所选时间窗内没有实质命中」（仅当全量有数据时存在该块）
    var anyVisible = document.querySelectorAll(".fh:not(.hidden)").length > 0;
    var nowin = document.getElementById("f-nowin");
    if (nowin) nowin.classList.toggle("hidden", anyVisible);

    // 重点卡：不匹配的隐去（只留一个重点时，上面统计仍按时间窗）
    var cards = document.querySelectorAll(".fcard");
    for (var c = 0; c < cards.length; c++) {
      var cf = cards[c].getAttribute("data-focus");
      cards[c].classList.toggle("hidden", !!state.focus && cf !== state.focus);
    }
    // 排序：只在组内重排（跨天仍按日期降序，日期本身就是最强的阅读秩序）
    if (state.sort === "importance") {
      var lists = document.querySelectorAll(".fday .flist");
      for (var l = 0; l < lists.length; l++) {
        var items = [].slice.call(lists[l].children);
        items.sort(function (a, b) {
          var ra = +a.getAttribute("data-rank"), rb = +b.getAttribute("data-rank");
          if (ra !== rb) return rb - ra;
          return (+b.getAttribute("data-bonus")) - (+a.getAttribute("data-bonus"));
        });
        for (var k = 0; k < items.length; k++) lists[l].appendChild(items[k]);
      }
    } else {
      var lists2 = document.querySelectorAll(".fday .flist");
      for (var m = 0; m < lists2.length; m++) {
        var its = [].slice.call(lists2[m].children);
        its.sort(function (a, b) {
          return (+b.getAttribute("data-bonus")) - (+a.getAttribute("data-bonus"));
        });
        for (var k2 = 0; k2 < its.length; k2++) lists2[m].appendChild(its[k2]);
      }
    }
    // 按钮态
    var btns = document.querySelectorAll("[data-filter-days],[data-filter-focus],[data-sort]");
    for (var b = 0; b < btns.length; b++) {
      var el = btns[b];
      var pressed =
        el.hasAttribute("data-filter-days") ? Number(el.getAttribute("data-filter-days")) === state.days :
        el.hasAttribute("data-filter-focus") ? (el.getAttribute("data-filter-focus") || "") === state.focus :
        el.getAttribute("data-sort") === state.sort;
      el.setAttribute("aria-pressed", pressed ? "true" : "false");
    }
    // 同步地址栏（可分享「某个重点 + 某时间窗」的视图）
    try {
      var p = new URLSearchParams();
      if (state.focus) p.set("f", state.focus);
      if (state.days !== 30) p.set("days", String(state.days));
      var qs = p.toString();
      history.replaceState(null, "", qs ? "?" + qs : location.pathname);
    } catch (e) {}
  }

  document.addEventListener("click", function (ev) {
    var t = ev.target;
    while (t && t !== document && !t.hasAttribute) t = t.parentNode;
    if (!t || !t.hasAttribute) return;
    if (t.hasAttribute("data-filter-days")) state.days = Number(t.getAttribute("data-filter-days")) || 0;
    else if (t.hasAttribute("data-filter-focus")) state.focus = t.getAttribute("data-filter-focus") || "";
    else if (t.hasAttribute("data-sort")) state.sort = t.getAttribute("data-sort") || "recent";
    else return;
    apply();
  });

  apply();
})();
</script>
</body>
</html>`;
}
