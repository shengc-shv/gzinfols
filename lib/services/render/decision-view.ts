/**
 * 零售经营决策情报视角（L1 领导首页 · 一期）。
 *
 * 定位（PRD 1.2 / 1.4）：零售经营决策视角，把「发生了什么」转为「对零售经营意味着什么」。
 * 一期只做**信息价值链的重构呈现**——六模块全部复用 report 既有字段，
 * 零新数据契约、零 LLM、零操作建议（项目铁律：全篇不输出行动指引）。
 *
 * 与旧视角关系（sc 2026-11-28 拍板方案 A）：
 *  - 本模块渲染的 DOM 与旧版资讯视角**共存于同一份 HTML**，用 JS 切 class 显隐；
 *  - 两层共用同一 report JSON，不复制数据、不改采集/AI/发布链路；
 *  - 旧视角结构、id、锚点、测试断言一律不动（本文件只新增，不修改旧 DOM）。
 *
 * 内容红线（对齐用户级长期记忆）：
 *  - 时间真实性：只展示既有 `date`/`published_at`，不拿抓取时间兜底、不造"事件日"；
 *  - 事实与 AI 研判分栏标注：客观事实摘要 = item.summary，研判 = insight.impact/risk.impact；
 *  - 结论带来源：每张卡可溯源（站内锚点或外链），来源缺失显式标注；
 *  - 不输出操作建议：PRD 里的「建议研究方向」等改为「关注要点」（客观呈现，不下指令）。
 */
import type { DailyReport, ReportInsight, ReportItem, RiskItem } from "../../contracts/report";
import type { DeltaMark } from "../../contracts/report";
import { escapeHtml } from "./cards";
import { itemAnchorId } from "./atoms";
import { prevDateKey } from "../../utils/time";

/** 六大业务专题（PRD 4.7）。一期只做入口导航，专题页本身属后续阶段。 */
export const BUSINESS_DOMAINS: ReadonlyArray<{ id: string; label: string; hint: string }> = [
  { id: "wealth", label: "财富管理", hint: "理财 · 基金 · 保险 · 黄金 · 私行" },
  { id: "customer", label: "客户经营", hint: "代发 · 社保 · 客群 · 社区金融" },
  { id: "credit", label: "零售信贷", hint: "住房 · 消费贷 · 经营贷 · 信用卡" },
  { id: "channel", label: "渠道科技", hint: "手机银行 · 网点 · AI 应用 · 数据安全" },
  { id: "risk", label: "风险消保", hint: "监管 · 消保 · 反诈 · 适当性" },
  { id: "region", label: "区域同业", hint: "广州经济 · 产业政策 · 同业动态" },
];

/**
 * 顶部快捷跳转的六个模块（PRD 8.3：移动端首屏可见、纵向排列、无需横向滚动）。
 * id 必须与下方六个 `<section class="dv-mod" id="...">` 一一对应，测试守护。
 */
export const DV_MODULE_NAV: ReadonlyArray<{ id: string; label: string }> = [
  { id: "dv-yesterday", label: "关键要情" },
  { id: "dv-morning", label: "今晨更新" },
  { id: "dv-opportunity", label: "经营机会" },
  { id: "dv-risk", label: "风险预警" },
  { id: "dv-attention", label: "管理关注" },
  { id: "dv-domains", label: "业务专题" },
];

/** 重要性等级（PRD 4.2）。只映射既有字段，不新造分数。 */
function importanceLabel(it: ReportItem): string {
  if (it.importance === 3) return "重点";
  if (it.importance === 1) return "一般";
  return "常规";
}

/** 来源溯源：正文已收录 → 站内锚点；否则外链；都缺失 → 标注来源名（不编造链接）。 */
function sourceHref(item: Pick<ReportItem, "url" | "source">, inBody: boolean): string {
  if (item.url && inBody) return `#${itemAnchorId(item.url)}`;
  if (item.url) return item.url;
  return "";
}

/** 三态增量徽章（复用既有 DeltaMark 文案口径；无则不渲染）。 */
function deltaText(d: DeltaMark | undefined): string {
  if (!d) return "";
  if (d.state === "new") return "新增";
  if (d.state === "changed") return "有进展";
  return `续报${d.issueNo ? ` · 第${d.issueNo}期` : ""}`;
}

/** 一条"昨日关键要情"卡（PRD 4.2 八要素）。事实与研判分栏。 */
function keyEventCard(
  m: { title?: string; why: string; url: string; delta?: DeltaMark },
  bodyMap: Map<string, ReportItem>,
  insightMap: Map<string, ReportInsight>,
): string {
  const body = m.url ? bodyMap.get(m.url) : undefined;
  const fact = body?.summary ?? "";
  const inference = m.url ? insightMap.get(m.url)?.impact ?? "" : "";
  const href = sourceHref({ url: m.url, source: body?.source ?? "" }, Boolean(body));
  const srcLabel = body?.source ?? (m.url ? "原文" : "来源未标注");
  const src = href
    ? `<a class="dv-src" href="${escapeHtml(href)}"${!body && m.url ? ' target="_blank" rel="noopener noreferrer"' : ""}>${escapeHtml(srcLabel)}</a>`
    : `<span class="dv-src dv-src-missing">${escapeHtml(srcLabel)}</span>`;
  const fields = [
    body ? `<span class="dv-chip">${importanceLabel(body)}</span>` : "",
    body?.date ? `<span class="dv-chip">发布 ${escapeHtml(body.date)}</span>` : "",
    deltaText(m.delta) ? `<span class="dv-chip dv-chip-delta">${escapeHtml(deltaText(m.delta))}</span>` : "",
  ]
    .filter(Boolean)
    .join("");
  return `<article class="dv-card dv-key">
  <h3 class="dv-card-title">${escapeHtml(m.title || (body?.title_cn ?? ""))}</h3>
  ${fields ? `<div class="dv-chips">${fields}</div>` : ""}
  ${fact ? `<p class="dv-fact"><b>事实</b> ${escapeHtml(fact)}</p>` : ""}
  ${inference ? `<p class="dv-infer"><b>研判</b> ${escapeHtml(inference)}</p>` : ""}
  <p class="dv-why"><b>关注理由</b> ${escapeHtml(m.why)}</p>
  ${body?.tags?.length ? `<div class="dv-tags">${body.tags.map((t) => `<span class="dv-tag">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
  <div class="dv-card-foot">来源：${src}</div>
</article>`;
}

/** 经营机会卡（PRD 4.4）：事实影响呈现，不写"建议研究方向"（项目零建议红线）。 */
function opportunityCard(it: ReportInsight): string {
  const marks = (it.sources ?? [])
    .filter((s) => s?.url)
    .slice(0, 3)
    .map(
      (s, i) =>
        `<a class="dv-mark" href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(s.title)}">${["①", "②", "③"][i]}</a>`,
    )
    .join("");
  const segs = (it.segments ?? [])
    .map((s) => `<span class="dv-tag">${escapeHtml(s)}</span>`)
    .join("");
  const stage =
    it.maturity?.stage === "landed" ? "公开信息显示已落地"
      : it.maturity?.stage === "progress" ? "公开信息显示推进中"
        : it.maturity?.stage === "clue" ? "线索阶段"
          : "";
  return `<article class="dv-card dv-opp">
  <h3 class="dv-card-title">${escapeHtml(it.topic)}${marks ? `<span class="dv-srcs">${marks}</span>` : ""}</h3>
  ${stage ? `<div class="dv-chips"><span class="dv-chip">${stage}</span>${deltaText(it.delta) ? `<span class="dv-chip dv-chip-delta">${escapeHtml(deltaText(it.delta))}</span>` : ""}</div>` : ""}
  ${it.impact ? `<p class="dv-infer"><b>经营影响</b> ${escapeHtml(it.impact)}</p>` : ""}
  ${segs ? `<div class="dv-tags">${segs}</div>` : ""}
</article>`;
}

/**
 * 风险来源链接文字：正常标题原样显示；超长标题（实为正文被塞进 title）
 * 改显示域名 +「原文」，不把整篇正文铺在卡片上。链接本身始终可溯源。
 */
function riskSourceLabel(src: { title?: string; url: string }): string {
  const title = (src.title ?? "").trim();
  if (title && title.length <= 60) return title;
  let host = "";
  try {
    host = new URL(src.url).hostname.replace(/^www\./, "");
  } catch {
    // 非法 URL 不显示域名，退化为「原文」
  }
  return host ? `${host} · 原文` : "原文";
}

/** 风险卡（PRD 4.5）：等级由既有 source 字段客观标注，不凭标题判级。 */
function riskBlock(r: RiskItem | undefined): string {
  if (!r) return "";
  const src = (r.sources ?? []).find((s) => s?.url);
  const grade = r.source === "T1" ? "官方来源" : r.source === "T1.5" ? "准官方来源" : r.source === "T2" ? "媒体来源" : "";
  const link = src
    ? `<a class="dv-src" href="${escapeHtml(src.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(riskSourceLabel(src))}</a>`
    : `<span class="dv-src dv-src-missing">来源未标注</span>`;
  return `<article class="dv-card dv-risk">
  <h3 class="dv-card-title">${escapeHtml(r.topic)}</h3>
  ${grade ? `<div class="dv-chips"><span class="dv-chip dv-chip-risk">${grade}</span>${deltaText(r.delta) ? `<span class="dv-chip dv-chip-delta">${escapeHtml(deltaText(r.delta))}</span>` : ""}</div>` : ""}
  ${r.evidence ? `<p class="dv-fact"><b>事实依据</b> ${escapeHtml(r.evidence)}</p>` : ""}
  ${r.impact ? `<p class="dv-infer"><b>潜在影响</b> ${escapeHtml(r.impact)}</p>` : ""}
  <div class="dv-card-foot">来源：${link}</div>
</article>`;
}

/** 空状态（PRD 4.2：不足 3 条允许少于 3，不允许 AI 制造内容补足）。 */
function empty(text: string): string {
  return `<p class="dv-empty">${escapeHtml(text)}</p>`;
}

/** 板块底部返回顶部导航：长页面读到一半也能一键回到顶部快捷导航。 */
function backToTop(): string {
  return `<a class="dv-back" href="#dv-top">↑ 返回顶部导航</a>`;
}

/**
 * 渲染决策视角 DOM。返回整段（含根节点），由 full.ts 插入 `<main>` 顶层。
 * `nowHm` 为调用方注入的北京时间 HH:mm（缺省不显示，禁止隐式时钟）。
 */
export function renderDecisionView(report: DailyReport, date: string, nowHm: string): string {
  // ---- 数据准备：全部来自既有字段 ----
  const allItems: ReportItem[] = (["gz_local", "biz_insight", "policy_market", "tech", "ipo"] as const)
    .flatMap((s) => report.sections?.[s] ?? []);
  const bodyMap = new Map<string, ReportItem>();
  for (const it of allItems) if (it.url && !bodyMap.has(it.url)) bodyMap.set(it.url, it);
  const insightMap = new Map<string, ReportInsight>();
  for (const ins of report.insights ?? []) {
    for (const s of ins.sources ?? []) if (s?.url && !insightMap.has(s.url)) insightMap.set(s.url, ins);
  }

  // 昨日关键要情：must_read（已是"与源一一匹配 + 分数最高"的定稿集）
  const keys = (report.must_read ?? []).slice(0, 5);

  // 今晨重要更新：报告日当天发布（item.date = MM/DD），与昨日严格分离。
  const mmdd = `${date.slice(5, 7)}/${date.slice(8, 10)}`;
  const fresh = allItems.filter((it) => it.date === mmdd).slice(0, 5);

  // 经营机会：insights 原样（已按客群配额选定）
  const opps = report.insights ?? [];

  // 今日管理关注：≤3 项，从"必读关注理由 + 风险 + 机会"归纳，措辞用"建议关注/建议研究/建议进一步核实"（PRD 4.6）。
  // 只做归纳呈现，不新增 AI 判断、不下指令。
  const attention: Array<{ topic: string; reason: string; needCheck: boolean; crossDept: boolean }> = [];
  for (const m of keys.slice(0, 2)) {
    attention.push({
      topic: m.title || bodyMap.get(m.url)?.title_cn || m.url,
      reason: m.why,
      needCheck: false,
      crossDept: (bodyMap.get(m.url)?.tags ?? []).length > 1,
    });
  }
  if (report.risk) {
    attention.push({
      topic: report.risk.topic,
      reason: report.risk.impact || report.risk.evidence,
      needCheck: true,
      crossDept: true,
    });
  }
  const attentionHtml = attention.length
    ? attention
        .slice(0, 3)
        .map(
          (a, i) => `<article class="dv-card dv-attn">
    <h3 class="dv-card-title"><span class="dv-attn-n">${i + 1}</span> ${escapeHtml(a.topic)}</h3>
    <p class="dv-why">${escapeHtml(a.reason)}</p>
    <div class="dv-chips"><span class="dv-chip">建议关注</span>${a.needCheck ? '<span class="dv-chip dv-chip-risk">建议进一步核实</span>' : ""}${a.crossDept ? '<span class="dv-chip">建议跨部门研究</span>' : ""}</div>
  </article>`,
        )
        .join("")
    : empty("今日暂无需要归纳的管理关注事项。");

  // 四大日期（PRD 4.1）：生成日 / 昨日事件统计日 / 今晨更新截止 / 数据更新。
  // 事件实际发生时间无字段 → 不展示、不编造（时间真实性红线）。
  const yesterday = prevDateKey(date, 1);
  const dateLine = [
    `简报生成日 ${escapeHtml(date)}`,
    `昨日事件统计 ${escapeHtml(yesterday)}`,
    nowHm ? `今晨更新截至 ${escapeHtml(nowHm)}` : "",
    nowHm ? `数据更新 ${escapeHtml(nowHm)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return `<section class="dv-root" id="view-decision" aria-label="零售经营决策情报">
  <header class="dv-masthead">
    <div class="dv-eyebrow">零售经营决策情报 · 外部经营环境观察</div>
    <h1>零售经营决策情报</h1>
    <p class="dv-date-line">${dateLine}</p>
    <p class="dv-disclaimer">事实来自公开资讯；「研判 / 经营影响 / 潜在影响」为 AI 基于公开信息的分析，不构成经营决策或投资建议。</p>
    <nav class="dv-quicknav" id="dv-top" aria-label="模块快捷跳转">
      <span class="dv-quicknav-label">快捷跳转</span>
      ${DV_MODULE_NAV.map((m) => `<a href="#${m.id}">${escapeHtml(m.label)}</a>`).join("")}
    </nav>
  </header>

  <section class="dv-mod" id="dv-yesterday">
    <div class="dv-mod-head"><h2>昨日最值得关注的 ${keys.length} 件事</h2><span class="dv-mod-sub">重要性优先 · 经营价值优先</span></div>
    ${keys.length ? keys.map((m) => keyEventCard(m, bodyMap, insightMap)).join("") : empty("昨日暂无值得重点关注的事项（宁缺毋滥，不生成内容补足数量）。")}
  ${backToTop()}
  </section>

  <section class="dv-mod" id="dv-morning">
    <div class="dv-mod-head"><h2>今晨重要更新</h2><span class="dv-mod-sub">仅当日发布 · 与昨日要情严格分离</span></div>
    ${fresh.length
      ? fresh
          .map(
            (it) => `<article class="dv-card dv-fresh">
      <h3 class="dv-card-title">${escapeHtml(it.title_cn)}</h3>
      ${it.summary ? `<p class="dv-fact"><b>事实</b> ${escapeHtml(it.summary)}</p>` : ""}
      <div class="dv-card-foot">来源：<a class="dv-src" href="${escapeHtml(sourceHref(it, true))}">${escapeHtml(it.source)}</a> · ${escapeHtml(it.date)}</div>
    </article>`,
          )
          .join("")
      : empty("今晨暂无新发布的重要变化。")}
  ${backToTop()}
  </section>

  <section class="dv-mod" id="dv-opportunity">
    <div class="dv-mod-head"><h2>经营机会</h2><span class="dv-mod-sub">基于公开变化研判 · 非已确认客户需求</span></div>
    ${opps.length ? opps.map(opportunityCard).join("") : empty("本期暂无可研判的经营机会。")}
  ${backToTop()}
  </section>

  <section class="dv-mod" id="dv-risk">
    <div class="dv-mod-head"><h2>风险预警</h2><span class="dv-mod-sub">等级依来源客观标注 · 不凭标题判级</span></div>
    ${riskBlock(report.risk) || empty("本期暂无风险预警事项。")}
  ${backToTop()}
  </section>

  <section class="dv-mod" id="dv-attention">
    <div class="dv-mod-head"><h2>今日管理关注</h2><span class="dv-mod-sub">归纳不超过 3 项 · 建议性质 · 非已作决定</span></div>
    ${attentionHtml}
  ${backToTop()}
  </section>

  <section class="dv-mod" id="dv-domains">
    <div class="dv-mod-head"><h2>六大业务专题</h2><span class="dv-mod-sub">按业务领域浏览资讯 · 事件 · 历史追踪</span></div>
    <nav class="dv-domains">${BUSINESS_DOMAINS.map(
      (d) => `<a class="dv-domain" href="../topics.html">
      <span class="dv-domain-label">${escapeHtml(d.label)}</span>
      <span class="dv-domain-hint">${escapeHtml(d.hint)}</span>
    </a>`,
    ).join("")}</nav>
  ${backToTop()}
  </section>

  <button type="button" class="dv-float-top" id="dv-float-top" aria-label="返回顶部导航" title="返回顶部导航">↑<span>顶部</span></button>
</section>`;
}

/** 视角切换开关（挂在旧版 role-bar 之上、报头之前）。默认决策视角。 */
export function renderViewSwitch(): string {
  return `<div class="view-switch" id="view-switch" role="group" aria-label="版本视角切换">
  <span class="view-switch-label">视角</span>
  <button type="button" class="view-switch-btn active" data-view="decision" aria-pressed="true">决策情报</button>
  <button type="button" class="view-switch-btn" data-view="classic" aria-pressed="false">原版资讯</button>
  <span class="view-switch-hint" id="view-switch-hint">当前：零售经营决策视角（可在两版间切换，偏好本机保存）</span>
</div>`;
}

/**
 * 视角切换 CSS。只定义新类名，不覆盖任何旧版选择器（防止两套视角串样式）。
 * 注意：CSS 注释会被 stripCssComments 剥离，源码注释保留给维护者。
 */
export const DECISION_VIEW_CSS = `
  .view-switch { display:flex; flex-wrap:wrap; align-items:center; gap:0.4rem;
    margin:0 0 1.1rem; padding:0.55rem 0.7rem; border:1px solid var(--rule);
    border-radius:var(--r-md); background:var(--bg-elevated); }
  .view-switch-label { font-size:0.78rem; color:var(--muted); }
  .view-switch-btn { font:inherit; font-size:0.8rem; line-height:2; padding:0 0.75rem;
    border:1px solid var(--rule); border-radius:999px; background:var(--bg);
    color:var(--fg); cursor:pointer; min-height:34px; }
  .view-switch-btn.active { background:var(--accent); color:var(--accent-fg); border-color:var(--accent); }
  .view-switch-hint { font-size:0.72rem; color:var(--muted); }
  body.view-classic #view-decision { display:none; }
  body.view-decision #view-classic { display:none; }
  .dv-root { display:block; }
  .dv-masthead { padding:1.1rem 1.15rem; margin:0 0 1.4rem; border:1px solid var(--rule);
    border-left:4px solid var(--accent-brand); border-radius:var(--r-md); background:var(--bg-elevated); }
  .dv-eyebrow { font-size:0.76rem; letter-spacing:0.04em; color:var(--muted); }
  .dv-masthead h1 { margin:0.35rem 0 0.55rem; font-size:1.5rem; font-weight:600; }
  .dv-date-line { margin:0; font-size:0.8rem; color:var(--fg-soft); font-variant-numeric:tabular-nums; }
  .dv-disclaimer { margin:0.6rem 0 0; font-size:0.74rem; color:var(--muted); line-height:1.55; }
  .dv-quicknav { display:flex; flex-wrap:wrap; align-items:center; gap:0.4rem; margin:0.8rem 0 0; }
  .dv-quicknav-label { font-size:0.74rem; color:var(--muted); margin-right:0.15rem; }
  .dv-quicknav a { display:inline-flex; align-items:center; min-height:32px; padding:0.2rem 0.62rem;
    font-size:0.78rem; text-decoration:none; color:var(--fg-soft); background:var(--card);
    border:1px solid var(--rule); border-radius:999px; }
  .dv-quicknav a:active { background:var(--card-alt); }
  .dv-back { display:inline-block; margin:0.85rem 0 0; font-size:0.78rem; color:var(--link); text-decoration:none; }
  .dv-back:active { text-decoration:underline; }
  .dv-float-top { position:fixed; right:1rem; bottom:1rem; z-index:50;
    display:none; flex-direction:column; align-items:center; justify-content:center;
    width:46px; height:46px; padding:0; border:1px solid var(--rule); border-radius:999px;
    background:var(--bg-elevated); color:var(--fg-soft); font:inherit; font-size:1.1rem;
    line-height:1; cursor:pointer; box-shadow:0 2px 10px rgba(0,0,0,0.12); }
  .dv-float-top span { font-size:0.66rem; margin-top:0.12rem; }
  .dv-float-top.is-visible { display:flex; }
  .dv-mod { margin:0 0 1.7rem; }
  .dv-mod:target .dv-mod-head { border-bottom-color:var(--accent-brand); }
  .dv-mod-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:0.5rem;
    margin:0 0 0.7rem; padding-bottom:0.4rem; border-bottom:2px solid var(--rule); }
  .dv-mod-head h2 { margin:0; font-size:1.06rem; font-weight:600; }
  .dv-mod-sub { font-size:0.74rem; color:var(--muted); }
  .dv-card { padding:0.85rem 0.95rem; margin:0 0 0.7rem; border:1px solid var(--rule);
    border-radius:var(--r-md); background:var(--card); }
  .dv-card-title { margin:0 0 0.45rem; font-size:0.98rem; font-weight:600; line-height:1.5; }
  .dv-chips { display:flex; flex-wrap:wrap; gap:0.35rem; margin:0 0 0.5rem; }
  .dv-chip { font-size:0.72rem; padding:0.1rem 0.45rem; border-radius:999px;
    background:var(--card-alt); color:var(--fg-soft); }
  .dv-chip-delta { background:var(--rank-mid-bg); color:var(--rank-mid-fg); }
  .dv-chip-risk { background:var(--rank-high-bg); color:var(--rank-high-fg); }
  .dv-fact, .dv-infer, .dv-why { margin:0.35rem 0; font-size:0.86rem; line-height:1.62; }
  .dv-fact b, .dv-infer b, .dv-why b { font-weight:600; color:var(--fg); }
  .dv-infer { color:var(--fg-soft); }
  .dv-tags { display:flex; flex-wrap:wrap; gap:0.3rem; margin:0.5rem 0 0; }
  .dv-tag { font-size:0.71rem; padding:0.08rem 0.4rem; border:1px solid var(--rule);
    border-radius:6px; color:var(--muted); }
  .dv-card-foot { margin:0.6rem 0 0; font-size:0.74rem; color:var(--muted); }
  .dv-src { color:var(--link); }
  .dv-src-missing { color:var(--muted); }
  .dv-srcs { margin-left:0.4rem; }
  .dv-mark { color:var(--link); font-size:0.82rem; }
  .dv-risk { border-left:3px solid var(--rank-high-fg); }
  .dv-opp { border-left:3px solid var(--c-finance); }
  .dv-key { border-left:3px solid var(--accent-brand); }
  .dv-attn-n { display:inline-block; min-width:1.25rem; color:var(--accent-brand); font-variant-numeric:tabular-nums; }
  .dv-empty { margin:0; padding:1rem; font-size:0.85rem; color:var(--muted);
    border:1px dashed var(--rule); border-radius:var(--r-md); background:var(--bg); }
  .dv-domains { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:0.6rem; }
  .dv-domain { display:flex; flex-direction:column; gap:0.2rem; min-height:56px; padding:0.7rem 0.8rem;
    border:1px solid var(--rule); border-radius:var(--r-md); background:var(--card); text-decoration:none; color:var(--fg); }
  .dv-domain:active { background:var(--card-alt); }
  .dv-domain-label { font-size:0.9rem; font-weight:600; }
  .dv-domain-hint { font-size:0.73rem; color:var(--muted); }
  @media (max-width:640px) {
    .dv-masthead h1 { font-size:1.28rem; }
    .dv-date-line { line-height:1.7; }
    .dv-card { padding:0.8rem; }
    .dv-card-title { font-size:0.94rem; }
    .dv-fact, .dv-infer, .dv-why { font-size:0.84rem; }
    .dv-domains { grid-template-columns:1fr; }
    .dv-float-top { right:0.75rem; bottom:0.75rem; width:42px; height:42px; }
    .view-switch-hint { flex-basis:100%; }
  }
`;

/** 视角切换脚本：class 切 body + localStorage 记住偏好 + 更新按钮态。 */
export function generateDecisionViewScript(): string {
  return `
(function(){
  var KEY='gz_view';
  var body=document.body;
  var btns=document.querySelectorAll('.view-switch-btn');
  var hint=document.getElementById('view-switch-hint');
  var DEFAULT_HINT=hint?hint.textContent:'';
  function apply(view){
    var v=(view==='classic')?'classic':'decision';
    body.classList.toggle('view-classic',v==='classic');
    body.classList.toggle('view-decision',v==='decision');
    btns.forEach(function(b){
      var on=b.getAttribute('data-view')===v;
      b.classList.toggle('active',on);
      b.setAttribute('aria-pressed',on?'true':'false');
    });
    if(hint) hint.textContent=DEFAULT_HINT.replace('零售经营决策视角',v==='classic'?'原版资讯视角':'零售经营决策视角');
    try{localStorage.setItem(KEY,v);}catch(e){}
  }
  var saved='decision';
  try{saved=localStorage.getItem(KEY)||'decision';}catch(e){}
  apply(saved);
  document.getElementById('view-switch').addEventListener('click',function(e){
    var b=e.target&&e.target.closest?e.target.closest('.view-switch-btn'):null;
    if(!b)return;
    apply(b.getAttribute('data-view'));
  });

  // 返回顶部：板块底部链接 + 右下角悬浮按钮（滚过一屏才出现，不遮挡开头）。
  var top=document.getElementById('dv-top');
  var floatTop=document.getElementById('dv-float-top');
  function onScroll(){
    if(floatTop) floatTop.classList.toggle('is-visible',(window.scrollY||window.pageYOffset||0)>320);
  }
  function smoothTo(el){
    if(el&&el.scrollIntoView) el.scrollIntoView({behavior:'smooth',block:'start'});
  }
  window.addEventListener('scroll',onScroll,{passive:true});
  onScroll();
  if(floatTop) floatTop.addEventListener('click',function(){smoothTo(top);});
  var root=document.getElementById('view-decision');
  if(root) root.addEventListener('click',function(e){
    var a=e.target&&e.target.closest?e.target.closest('a[href^="#dv-"]'):null;
    if(!a)return;
    var t=document.getElementById(a.getAttribute('href').slice(1));
    if(!t)return;
    e.preventDefault();
    smoothTo(t);
  });
})();`;
}
