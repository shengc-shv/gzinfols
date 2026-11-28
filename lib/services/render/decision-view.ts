/**
 * 零售经营决策情报视角（第一期 · 管理决策型经营情报首页）。
 *
 * 2026-11-28 sc 拍板：按新规格**推翻早版六模块**，改为八模块结构：
 *   ① 页头数据状态 ② 今日定调 ③ 今日必读 ④ 商机洞察 ⑤ 风险预警
 *   ⑥ 管理关注 ⑦ 六大经营领域（平铺标签 + 单一明细面板） ⑧ 原有专业内容入口
 * 版本切换（方案 A）保留：本 DOM 与旧版资讯视角共存同一 HTML，body class 切显隐，
 * 共用同一 report JSON，旧视角 DOM/锚点/断言零改动。
 *
 * 内容红线（用户级长期记忆 + 本期 sc 口径）：
 *  - 脱敏：不出现「广州分行 / 分管行长」等身份或具体行名，只写客观项目描述；
 *  - 时间真实性：只展示报告既有 date / published_at，不拿抓取时间兜底、不造「事件日」；
 *    本期按 sc 口径**不搞四字段拆分**（每天出报，今天/昨天足够）；
 *  - 事实与 AI 研判分栏：summary/evidence = 事实，impact = 研判；证据等级由来源客观标注；
 *  - 折中建议（sc 拍板）：管理关注用「建议关注 / 建议进一步核实」审慎措辞，明示非已作决定，
 *    **不下业务指令、不生成指标目标**；
 *  - 宁缺毋滥：字段缺失给空状态，不 AI 造数补足；超长来源标题不铺正文。
 */
import type { DailyReport, ReportInsight, ReportItem, RiskItem } from "../../contracts/report";
import type { DeltaMark, ReportFocusHit } from "../../contracts/report";
import { escapeHtml } from "./cards";
import { itemAnchorId } from "./atoms";
import { prevDateKey } from "../../utils/time";
import { stripHeroPrefix } from "../../utils/hero-text";
import { BUSINESS_DOMAINS, DOMAIN_IDS, classifyBusinessDomain } from "../vocab/business-domains";

/** 顶部快捷跳转 + 八模块锚点（id 与下方 section 一一对应，测试守护）。 */
export const DV_MODULE_NAV: ReadonlyArray<{ id: string; label: string }> = [
  { id: "dv-hero", label: "今日定调" },
  { id: "dv-focus", label: "本期重点" },
  { id: "dv-mustread", label: "今日必读" },
  { id: "dv-opportunity", label: "商机洞察" },
  { id: "dv-risk", label: "风险预警" },
  { id: "dv-attention", label: "管理关注" },
  { id: "dv-domains", label: "经营领域" },
  { id: "dv-legacy", label: "专业内容" },
];

/** 重要性 S/A/B（规格 2.2）：由既有 importance 1/2/3 映射展示，不改契约、不碰排序。 */
function gradeLabel(it: Pick<ReportItem, "importance">): string {
  return it.importance === 3 ? "S 重大变化" : it.importance === 2 ? "A 重要变化" : "B 一般关注";
}

/** 证据等级 E1~E4（规格 8.2）：由来源权威 T1/T1.5/T2 客观映射，不代表 AI 置信度。 */
function evidenceGrade(source?: string): string {
  return source === "T1" ? "E1 官方披露" : source === "T1.5" ? "E2 权威机构" : source === "T2" ? "E3 媒体报道" : "";
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

/**
 * 经营重点标签（二期，规格 5.2）。
 *
 * 🔴 只认**年度三大重点**（sc 2026-11-28 定）：季度/临时专项只参与排序加权，
 * 不上卡片。此处再过滤一次，是防止旧报告或旁路脚本写入季度命中后泄漏到页面 ——
 * 卡片上挂一个首页重点列表里没有的标签，等于给读者一个点不到的解释。
 * 一条最多两个（数据侧 `focus_hits` 已截断）。
 * ⚠️ 标签只说明「与年度经营重点相关」，**不是**事件本身的重要性 ——
 * 后者由同一行的「S/A/B 重大变化」独立表达，两者绝不合并成一句话（规格 5.4）。
 */
function focusTags(hits: ReportFocusHit[] | undefined): string {
  const annual = (hits ?? []).filter((h) => h.layer === "annual");
  if (!annual.length) return "";
  return annual
    .map(
      (h) =>
        `<span class="dv-ftag" title="${escapeHtml(h.reason)}">年度重点：${escapeHtml(h.name)}</span>`,
    )
    .join("");
}

/** 今日必读单卡：标题 + 核心事实 + 研判 + 关注理由 + S/A/B + 证据等级 + 来源。 */
function mustReadCard(
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
    body ? `<span class="dv-chip dv-chip-grade">${gradeLabel(body)}</span>` : "",
    body ? evidenceGrade(body.tier ? String(body.tier) : body.source_type === "official" ? "T1" : "T2")
      ? `<span class="dv-chip">${evidenceGrade(body.tier ? String(body.tier) : body.source_type === "official" ? "T1" : "T2")}</span>` : ""
      : "",
    body?.date ? `<span class="dv-chip">发布 ${escapeHtml(body.date)}</span>` : "",
    deltaText(m.delta) ? `<span class="dv-chip dv-chip-delta">${escapeHtml(deltaText(m.delta))}</span>` : "",
  ]
    .filter(Boolean)
    .join("");
  const domain = body?.primary_domain
    ? `<span class="dv-chip dv-chip-domain">${escapeHtml(BUSINESS_DOMAINS.find((d) => d.id === body.primary_domain)?.short ?? body.primary_domain)}</span>`
    : "";
  return `<article class="dv-card dv-key">
  <h3 class="dv-card-title">${escapeHtml(m.title || (body?.title_cn ?? ""))}</h3>
  ${body?.focus_hits?.length ? `<div class="dv-ftags">${focusTags(body.focus_hits)}</div>` : ""}
  ${fields || domain ? `<div class="dv-chips">${domain}${fields}</div>` : ""}
  ${fact ? `<p class="dv-fact"><b>事实</b> ${escapeHtml(fact)}</p>` : ""}
  ${inference ? `<p class="dv-infer"><b>研判</b> ${escapeHtml(inference)}</p>` : ""}
  <p class="dv-why"><b>值得关注</b> ${escapeHtml(m.why)}</p>
  <div class="dv-card-foot">来源：${src}</div>
</article>`;
}

/** 商机洞察卡：机会 + 客群 + 影响（事实呈现，不写操作指令）。 */
function opportunityCard(it: ReportInsight, bodyMap: Map<string, ReportItem>): string {
  // 命中信息挂在正文条目上（来源 url 反查）：商机卡没有自己的 url，
  // 取第一条能对上正文的来源作为代表 —— 与「找原文」用的是同一落点。
  const hitBody = (it.sources ?? []).map((s) => (s?.url ? bodyMap.get(s.url) : undefined)).find((b) => b?.focus_hits?.length);
  const marks = (it.sources ?? [])
    .filter((s) => s?.url)
    .slice(0, 3)
    .map(
      (s, i) =>
        `<a class="dv-mark" href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(s.title)}">${["①", "②", "③"][i]}</a>`,
    )
    .join("");
  const segs = (it.segments ?? []).map((s) => `<span class="dv-tag">${escapeHtml(s)}</span>`).join("");
  const stage =
    it.maturity?.stage === "landed" ? "公开信息显示已落地"
      : it.maturity?.stage === "progress" ? "公开信息显示推进中"
        : it.maturity?.stage === "clue" ? "线索阶段"
          : "";
  return `<article class="dv-card dv-opp">
  <h3 class="dv-card-title">${escapeHtml(it.topic)}${marks ? `<span class="dv-srcs">${marks}</span>` : ""}</h3>
  ${hitBody?.focus_hits?.length ? `<div class="dv-ftags">${focusTags(hitBody.focus_hits)}</div>` : ""}
  ${stage ? `<div class="dv-chips"><span class="dv-chip">${stage}</span>${deltaText(it.delta) ? `<span class="dv-chip dv-chip-delta">${escapeHtml(deltaText(it.delta))}</span>` : ""}</div>` : ""}
  ${it.impact ? `<p class="dv-infer"><b>经营影响</b> ${escapeHtml(it.impact)}</p>` : ""}
  ${segs ? `<div class="dv-tags"><span class="dv-tag-label">关联客群</span>${segs}</div>` : ""}
</article>`;
}

/** 风险来源链接文字：正常标题原样；超长（正文被塞进 title）退化为域名 +「原文」。 */
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

/** 风险预警卡：风险事项 + 事实依据 + 潜在影响 + 证据等级 + 来源。 */
function riskBlock(r: RiskItem | undefined, bodyMap: Map<string, ReportItem>): string {
  if (!r) return "";
  const src = (r.sources ?? []).find((s) => s?.url);
  const hitBody = (r.sources ?? []).map((s) => (s?.url ? bodyMap.get(s.url) : undefined)).find((b) => b?.focus_hits?.length);
  const grade = evidenceGrade(r.source);
  const link = src
    ? `<a class="dv-src" href="${escapeHtml(src.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(riskSourceLabel(src))}</a>`
    : `<span class="dv-src dv-src-missing">来源未标注</span>`;
  return `<article class="dv-card dv-risk">
  <h3 class="dv-card-title">${escapeHtml(r.topic)}</h3>
  ${hitBody?.focus_hits?.length ? `<div class="dv-ftags">${focusTags(hitBody.focus_hits)}</div>` : ""}
  ${grade || deltaText(r.delta) ? `<div class="dv-chips">${grade ? `<span class="dv-chip dv-chip-grade">${grade}</span>` : ""}${deltaText(r.delta) ? `<span class="dv-chip dv-chip-delta">${escapeHtml(deltaText(r.delta))}</span>` : ""}</div>` : ""}
  ${r.evidence ? `<p class="dv-fact"><b>事实依据</b> ${escapeHtml(r.evidence)}</p>` : ""}
  ${r.impact ? `<p class="dv-infer"><b>潜在影响</b> ${escapeHtml(r.impact)}</p>` : ""}
  <div class="dv-card-foot">来源：${link}</div>
</article>`;
}

function empty(text: string): string {
  return `<p class="dv-empty">${escapeHtml(text)}</p>`;
}

/** 横滑提示：仅当卡片多于 1 张时给（单张不提示左右滑，避免无意义的滑动暗示）。 */
function swipeHint(n: number): string {
  return n > 1 ? `<p class="dv-swipe-hint">左右滑动查看 ${n} 条</p>` : "";
}

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
    .flatMap((s) => report.sections?.[s] ?? [])
    // 浅拷贝：历史报告降级打标只作用于本次渲染，绝不 mutate 入参报告。
    .map((it) => ({ ...it }));
  const bodyMap = new Map<string, ReportItem>();
  for (const it of allItems) if (it.url && !bodyMap.has(it.url)) bodyMap.set(it.url, it);
  // 历史报告无 primary_domain（字段为本期新增）：渲染期按同一词表临时打标，
  // 仅用于本次 DOM 展示，不 mutate 报告、不写盘；新报告走管线打标，口径同源。
  for (const it of allItems) {
    if (it.primary_domain) continue;
    const d = classifyBusinessDomain({ title: it.title_cn, summary: it.summary, tags: it.tags });
    if (d) {
      it.primary_domain = d.primary_domain;
      if (d.related_domains.length) it.related_domains = d.related_domains;
    }
  }
  const insightMap = new Map<string, ReportInsight>();
  for (const ins of report.insights ?? []) {
    for (const s of ins.sources ?? []) if (s?.url && !insightMap.has(s.url)) insightMap.set(s.url, ins);
  }

  const keys = (report.must_read ?? []).slice(0, 3); // 默认 Top3，高价值最多 5 由数据侧定稿
  const opps = (report.insights ?? []).slice(0, 3);
  const yesterday = prevDateKey(date, 1);
  // 本期经营重点（二期）：只列**年度三大重点**，且只列当日有实质命中（M2/M3）的。
  // 无实质命中就整块不输出 —— 经营重点不是每天都有事发生，空行/占位只会稀释注意力
  // （与「今日定调为空则整行消失」同一口径）。季度/临时专项仍参与排序加权，但不在此展示。
  const focusSummary = report.focus;
  const focusRows = (focusSummary?.items ?? [])
    .filter((f) => f.layer === "annual" && f.high > 0)
    .map((f) => ({
      f,
      members: allItems.filter((it) => (it.focus_hits ?? []).some((h) => h.id === f.id)).slice(0, 8),
    }))
    .filter((r) => r.members.length > 0);

  // ---- ① 页头数据状态 ----
  const stats = [
    `简报生成日 ${escapeHtml(date)}`,
    `统计区间 ${escapeHtml(yesterday)} — ${escapeHtml(date)}`,
    nowHm ? `数据更新 ${escapeHtml(nowHm)}` : "",
    `去重后资讯 ${allItems.length} 条`,
    `商机 ${report.insights?.length ?? 0} 条`,
    `风险 ${report.risk ? 1 : 0} 条`,
  ].filter(Boolean).join(" · ");

  // ---- ② 今日定调（复用 hero_line，有才显示，不凑主题）----
  // 与旧版同源：剥掉历史遗留「今日分行焦点：」补位前缀，避免双标签/前缀泄漏。
  const hero = stripHeroPrefix(report.hero_line).trim();
  // 空定调整块不输出（PRD 铁律），快捷跳转同步过滤该锚点，避免指向不存在的目标。
  const navItems = (hero ? DV_MODULE_NAV : DV_MODULE_NAV.filter((m) => m.id !== "dv-hero")).filter(
    (m) => m.id !== "dv-focus" || focusRows.length > 0,
  );
  const heroBlock = hero
    ? `<section class="dv-mod dv-hero" id="dv-hero">
  <div class="dv-mod-head"><h2>今日定调</h2><span class="dv-mod-sub">基于公开事实的综合判断 · 非新闻标题复述</span></div>
  <p class="dv-hero-text">${escapeHtml(hero)}</p>
  ${backToTop()}
</section>`
    : "";

  // ---- ②.5 本期经营重点（二期）----
  // 数据来自 `report.focus`（生成当时写入的汇总）。两条硬口径（sc 2026-11-28）：
  // ① 只列年度三大重点（季度/临时专项只参与排序加权，不在此展示）；
  // ② 只有当日常有实质命中（M2/M3）时才列该条，一条都没有则整块不输出 ——
  //    「配置里没设重点」或「今天确实没事发生」都不该在首页占位提醒。
  // 点击展开当日命中条目（本页展开、零死链）；专题页（跨期聚合）是后续 WP9。
  const focusSection = focusRows.length
    ? `<section class="dv-mod" id="dv-focus">
  <div class="dv-mod-head"><h2>本期经营重点</h2><span class="dv-mod-sub">配置版本 ${escapeHtml(focusSummary?.version ?? "")} · 只列当日有实质命中的</span></div>
  <ul class="dv-focus-list">${focusRows
    .map(({ f, members }) => {
      const meta = [
        `<span class="dv-focus-layer">年度重点</span>`,
        `<span class="dv-focus-grade">${escapeHtml(f.grade)} 级</span>`,
        `当日 ${f.count} 条 · 实质 ${f.high}`,
      ].join("");
      const body = `<ul class="dv-focus-items">${members
        .map((it) => {
          const title = escapeHtml(it.title_cn || it.url);
          const link = it.url
            ? `<a class="dv-domain-item" href="${escapeHtml(it.url)}" target="_blank" rel="noopener noreferrer">${title}</a>`
            : `<span class="dv-domain-item dv-domain-item-plain">${title}</span>`;
          const lv = (it.focus_hits ?? []).find((h) => h.id === f.id);
          return `<li class="dv-domain-row">${link}<span class="dv-domain-meta">${escapeHtml(it.source)}${it.date ? ` · ${escapeHtml(it.date)}` : ""}${lv ? ` · ${lv.level === "M3" ? "精准命中" : "高度相关"}` : ""}</span></li>`;
        })
        .join("")}</ul>`;
      return `<li class="dv-focus-row">
    <button type="button" class="dv-focus-btn" data-expand-focus="${escapeHtml(f.id)}" aria-expanded="false" aria-controls="dv-focus-detail-${escapeHtml(f.id)}">
      <span class="dv-focus-name">${escapeHtml(f.name)}</span>
      <span class="dv-focus-meta">${meta}</span>
    </button>
    <div class="dv-focus-detail" id="dv-focus-detail-${escapeHtml(f.id)}" hidden>${body}</div>
  </li>`;
    })
    .join("")}</ul>
  ${backToTop()}
</section>`
    : "";

  // ---- ③ 今日必读 ----
  const mustRead = `<section class="dv-mod" id="dv-mustread">
  <div class="dv-mod-head"><h2>今日必读</h2><span class="dv-mod-sub">默认 3 条 · 重要性优先 · 经营价值优先</span></div>
  ${keys.length ? `<div class="dv-scroller">${keys.map((m) => mustReadCard(m, bodyMap, insightMap)).join("")}</div>${swipeHint(keys.length)}` : empty("今日暂无值得重点关注的变化（宁缺毋滥，不生成内容补足数量）。")}
  ${backToTop()}
</section>`;

  // ---- ④ 商机洞察 ----
  const opportunity = `<section class="dv-mod" id="dv-opportunity">
  <div class="dv-mod-head"><h2>商机洞察</h2><span class="dv-mod-sub">公开变化中的业务线索 · 非已确认客户需求</span></div>
  ${opps.length ? `<div class="dv-scroller">${opps.map((o) => opportunityCard(o, bodyMap)).join("")}</div>${swipeHint(opps.length)}` : empty("今日暂无可研判的经营机会。")}
  ${backToTop()}
</section>`;

  // ---- ⑤ 风险预警 ----
  const risk = `<section class="dv-mod" id="dv-risk">
  <div class="dv-mod-head"><h2>风险预警</h2><span class="dv-mod-sub">重大风险独立展示 · 等级依来源客观标注</span></div>
  ${report.risk ? `<div class="dv-scroller">${riskBlock(report.risk, bodyMap)}</div>` : empty("今日暂无重大风险预警。")}
  ${backToTop()}
</section>`;

  // ---- ⑥ 管理关注（折中建议：审慎措辞 + 可溯源，非已作决定）----
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
  const shown = attention.slice(0, 3);
  const attentionHtml = shown.length
    ? `<div class="dv-scroller">${shown.map((a, i) => `<article class="dv-card dv-attn">
    <h3 class="dv-card-title"><span class="dv-attn-n">${i + 1}</span> ${escapeHtml(a.topic)}</h3>
    <p class="dv-why">${escapeHtml(a.reason)}</p>
    <div class="dv-chips"><span class="dv-chip">建议关注</span>${a.needCheck ? '<span class="dv-chip dv-chip-risk">建议进一步核实</span>' : ""}${a.crossDept ? '<span class="dv-chip">建议跨条线研究</span>' : ""}</div>
  </article>`).join("")}</div>${swipeHint(shown.length)}`
    : empty("今日暂无需要归纳的管理关注事项。");
  const attentionSection = `<section class="dv-mod" id="dv-attention">
  <div class="dv-mod-head"><h2>管理关注</h2><span class="dv-mod-sub">不超过 3 项 · 建议性质 · 非已作决定</span></div>
  ${attentionHtml}
  ${backToTop()}
</section>`;

  // ---- ⑦ 六大经营领域（平铺标签 + 单一明细面板；不做跨模块过滤）----
  const domainCounts = new Map<string, { total: number; high: number }>();
  for (const d of DOMAIN_IDS) domainCounts.set(d, { total: 0, high: 0 });
  for (const it of allItems) {
    if (!it.primary_domain || !domainCounts.has(it.primary_domain)) continue;
    const c = domainCounts.get(it.primary_domain)!;
    c.total += 1;
    if (it.importance === 3 || it.importance === 2) c.high += 1;
  }
  // 默认选中当日条目最多的领域（并列取配置顺序在前）；全为 0 时选第一个，
  // 保证首屏就有内容可读，而不是一片空白面板。
  let defaultDomain = DOMAIN_IDS[0];
  let richest = -1;
  for (const d of BUSINESS_DOMAINS) {
    const t = domainCounts.get(d.id)?.total ?? 0;
    if (t > richest) {
      richest = t;
      defaultDomain = d.id;
    }
  }
  const domainTabs: string[] = [];
  const domainPanels: string[] = [];
  for (const d of BUSINESS_DOMAINS) {
    const c = domainCounts.get(d.id) ?? { total: 0, high: 0 };
    const members = allItems.filter((it) => it.primary_domain === d.id).slice(0, 12);
    const tabId = `dv-domain-tab-${d.id}`;
    const panelId = `dv-domain-panel-${d.id}`;
    const on = d.id === defaultDomain;
    domainTabs.push(`<button type="button" role="tab" class="dv-tab${on ? " active" : ""}" id="${tabId}" data-domain-tab="${d.id}" aria-selected="${on}" aria-controls="${panelId}" tabindex="${on ? "0" : "-1"}"><span class="dv-tab-label">${escapeHtml(d.short)}</span><span class="dv-tab-count${c.total ? "" : " dv-tab-zero"}">${c.total}</span></button>`);
    const detail = members.length
      ? members.map((it) => {
          const href = it.url ? escapeHtml(it.url) : "";
          const title = escapeHtml(it.title_cn || it.url);
          const line = href
            ? `<a class="dv-domain-item" href="${href}" target="_blank" rel="noopener noreferrer">${title}</a>`
            : `<span class="dv-domain-item dv-domain-item-plain">${title}</span>`;
          return `<li class="dv-domain-row">${line}<span class="dv-domain-meta">${escapeHtml(it.source)}${it.date ? ` · ${escapeHtml(it.date)}` : ""}</span></li>`;
        }).join("")
      : `<li class="dv-domain-row dv-domain-none">当日暂无该领域条目</li>`;
    domainPanels.push(`<div class="dv-domain-panel" id="${panelId}" role="tabpanel" aria-labelledby="${tabId}"${on ? "" : " hidden"}>
      <div class="dv-domain-panel-head">${escapeHtml(d.name)} · 当日 ${c.total} 条${c.high ? ` · 含重点 ${c.high}` : ""}${c.total > 12 ? "（前 12 条）" : ""}</div>
      <ul class="dv-domain-list">${detail}</ul>
    </div>`);
  }
  const domainsSection = `<section class="dv-mod" id="dv-domains">
  <div class="dv-mod-head"><h2>六大经营领域</h2><span class="dv-mod-sub">按领域浏览 · 点击标签查看当日条目</span></div>
  <div class="dv-tabs" role="tablist" aria-label="六大经营领域">${domainTabs.join("")}</div>
  ${domainPanels.join("")}
  ${backToTop()}
</section>`;

  // ---- ⑧ 原有专业内容入口（全部复用现成链接，不建死链）----
  // 🔴 只放**独立页面**入口（sc 2026-11-28 实测踩坑）：此前混进了 `#dv-mustread` /
  // `#dv-opportunity` 两个页内锚点，读者在页面底部点「股市与必读」会被弹回页面上方，
  // 看起来像「链接没链对」。页内跳转已有顶部快捷导航，这里不再重复。
  const legacyItems = [
    { href: "../topics.html", label: "主题追踪", desc: "跨日事件连续性" },
    { href: "../research.html", label: "研报解读", desc: "同业深度分析" },
    { href: "../redchip/index.html", label: "红筹线索", desc: "特色信息入口" },
    { href: "../search.html", label: "资讯搜索", desc: "按标题与主题检索" },
    { href: "../archive.html", label: "历史归档", desc: "按日期查阅" },
  ];
  const legacySection = `<section class="dv-mod" id="dv-legacy">
  <div class="dv-mod-head"><h2>专业内容与深度阅读</h2><span class="dv-mod-sub">独立页面 · 点击进入对应板块</span></div>
  <nav class="dv-legacy">${legacyItems.map((i) => `<a class="dv-legacy-item" href="${i.href}"><span class="dv-legacy-label">${escapeHtml(i.label)}</span><span class="dv-legacy-desc">${escapeHtml(i.desc)}</span></a>`).join("")}</nav>
  ${backToTop()}
</section>`;

  return `<section class="dv-root" id="view-decision" aria-label="零售经营决策情报">
  <header class="dv-masthead">
    <div class="dv-eyebrow">零售经营决策情报 · 外部经营环境观察</div>
    <h1>零售经营决策情报</h1>
    <p class="dv-date-line">${stats}</p>
    <p class="dv-disclaimer">事实来自公开资讯；「研判 / 经营影响 / 潜在影响」为 AI 基于公开信息的分析。管理关注为审慎建议，非已作决定，不构成经营决策或投资建议。</p>
    <nav class="dv-quicknav" id="dv-top" aria-label="模块快捷跳转">
      <span class="dv-quicknav-label">快捷跳转</span>
      ${navItems.map((m) => `<a href="#${m.id}">${escapeHtml(m.label)}</a>`).join("")}
    </nav>
  </header>

  ${heroBlock}
  ${focusSection}
  ${mustRead}
  ${opportunity}
  ${risk}
  ${attentionSection}
  ${domainsSection}
  ${legacySection}

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

/** 决策视角 CSS：只定义新类名，不覆盖任何旧版选择器（防止两套视角串样式）。 */
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
  .dv-date-line { margin:0; font-size:0.8rem; color:var(--fg-soft); font-variant-numeric:tabular-nums; line-height:1.7; }
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
  .dv-mod-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:0.5rem;
    margin:0 0 0.7rem; padding-bottom:0.4rem; border-bottom:2px solid var(--rule); }
  .dv-mod-head h2 { margin:0; font-size:1.06rem; font-weight:600; }
  .dv-mod-sub { font-size:0.74rem; color:var(--muted); }
  .dv-hero-text { margin:0; padding:0.9rem 1rem; font-size:0.92rem; line-height:1.75;
    border-left:3px solid var(--accent-brand); border-radius:var(--r-md); background:var(--card); }
  /* 横滑：移动端左右滑（隐藏滚动条 + 右缘渐隐示意还有内容），桌面转等宽网格 */
  .dv-scroller { display:flex; flex-direction:row; align-items:stretch; gap:0.7rem;
    overflow-x:auto; -webkit-overflow-scrolling:touch; overscroll-behavior-x:contain;
    scroll-snap-type:x mandatory; scrollbar-width:none; -ms-overflow-style:none;
    padding:0.2rem 0.15rem 0.5rem; }
  .dv-scroller::-webkit-scrollbar { display:none; }
  .dv-scroller.has-more:not(.at-end) {
    -webkit-mask-image:linear-gradient(to right,#000 calc(100% - 30px),transparent 100%);
    mask-image:linear-gradient(to right,#000 calc(100% - 30px),transparent 100%); }
  .dv-scroller > .dv-card { flex:0 0 auto; width:min(80vw,330px); margin:0;
    display:flex; flex-direction:column; box-sizing:border-box;
    scroll-snap-align:start; scroll-snap-stop:always; box-shadow:0 1px 3px rgba(0,0,0,0.05); }
  .dv-scroller > .dv-card .dv-card-foot { margin-top:auto; padding-top:0.55rem; }
  .dv-swipe-hint { margin:0.1rem 0 0; font-size:0.72rem; color:var(--muted); }
  @media (min-width:720px) {
    .dv-scroller { display:grid; grid-template-columns:repeat(auto-fit,minmax(250px,1fr));
      gap:0.7rem; overflow:visible; padding:0; scroll-snap-type:none;
      -webkit-mask-image:none; mask-image:none; }
    .dv-scroller > .dv-card { width:auto; max-width:none; scroll-snap-align:none; }
    .dv-swipe-hint { display:none; }
  }
  .dv-card { padding:0.85rem 0.95rem; margin:0 0 0.7rem; border:1px solid var(--rule);
    border-radius:var(--r-md); background:var(--card); }
  .dv-card-title { margin:0 0 0.45rem; font-size:0.98rem; font-weight:600; line-height:1.5; }
  .dv-chips { display:flex; flex-wrap:wrap; gap:0.35rem; margin:0 0 0.5rem; }
  .dv-chip { font-size:0.72rem; padding:0.1rem 0.45rem; border-radius:999px;
    background:var(--card-alt); color:var(--fg-soft); }
  .dv-chip-grade { background:var(--rank-mid-bg); color:var(--rank-mid-fg); }
  .dv-chip-domain { background:var(--card-alt); color:var(--accent-brand); }
  .dv-chip-delta { outline:1px solid var(--rank-mid-fg); }
  .dv-chip-risk { background:var(--rank-high-bg); color:var(--rank-high-fg); }
  .dv-fact, .dv-infer, .dv-why { margin:0.35rem 0; font-size:0.86rem; line-height:1.62; }
  .dv-fact b, .dv-infer b, .dv-why b { font-weight:600; color:var(--fg); }
  .dv-infer { color:var(--fg-soft); }
  .dv-tags { display:flex; flex-wrap:wrap; gap:0.3rem; margin:0.5rem 0 0; }
  .dv-tag { font-size:0.71rem; padding:0.08rem 0.4rem; border:1px solid var(--rule);
    border-radius:6px; color:var(--muted); }
  .dv-tag-label { font-size:0.71rem; color:var(--muted); }
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
  /* 本期经营重点（二期）：一行一条年度重点，点击展开当日命中条目。
     只展示年度三大重点（sc 2026-11-28），故不再有「本季主攻」强调态。 */
  .dv-ftags { display:flex; flex-wrap:wrap; gap:0.3rem; margin:0 0 0.45rem; }
  .dv-ftag { font-size:0.71rem; line-height:1.5; padding:0.08rem 0.42rem; border-radius:6px;
    background:var(--card-alt); color:var(--fg-soft); border:1px solid var(--rule); }
  .dv-focus-list { list-style:none; margin:0; padding:0;
    border:1px solid var(--rule); border-radius:var(--r-md); background:var(--card); overflow:hidden; }
  .dv-focus-row + .dv-focus-row { border-top:1px solid var(--rule); }
  .dv-focus-btn { display:flex; flex-direction:column; gap:0.22rem; width:100%;
    font:inherit; text-align:left; cursor:pointer; padding:0.7rem 0.85rem; min-height:52px;
    background:transparent; border:0; color:var(--fg); }
  .dv-focus-btn:active, .dv-focus-btn[aria-expanded="true"] { background:var(--card-alt); }
  .dv-focus-name { font-size:0.9rem; font-weight:600; line-height:1.5; }
  .dv-focus-meta { display:flex; flex-wrap:wrap; align-items:center; gap:0.4rem;
    font-size:0.73rem; color:var(--muted); }
  .dv-focus-layer { padding:0.05rem 0.4rem; border-radius:999px; border:1px solid var(--rule); color:var(--fg-soft); }
  .dv-focus-grade { color:var(--accent-brand); }
  .dv-focus-detail { padding:0.2rem 0.85rem 0.7rem; background:var(--bg); }
  .dv-focus-detail[hidden] { display:none; }
  .dv-focus-items { list-style:none; margin:0; padding:0; }
  /* 六大经营领域：平铺标签条（窄屏两行三列全可见，桌面一行六等分）+ 单一明细面板 */
  .dv-tabs { display:flex; flex-wrap:wrap; margin:0 0 0.8rem; border-bottom:1px solid var(--rule); }
  .dv-tab { flex:1 1 33.33%; min-width:0; display:inline-flex; align-items:center; justify-content:center;
    gap:0.3rem; font:inherit; font-size:0.84rem; line-height:1.4; padding:0.55rem 0.35rem;
    min-height:42px; border:0; border-bottom:2px solid transparent; border-radius:0;
    background:transparent; color:var(--muted); cursor:pointer; white-space:nowrap; }
  .dv-tab.active { color:var(--fg); font-weight:600; border-bottom-color:var(--accent-brand);
    background:var(--card-alt); }
  .dv-tab-label { overflow:hidden; text-overflow:ellipsis; }
  .dv-tab-count { font-size:0.72rem; font-variant-numeric:tabular-nums; opacity:0.8; }
  .dv-tab.active .dv-tab-count { color:var(--accent-brand); opacity:1; }
  .dv-tab-zero { opacity:0.4; }
  @media (min-width:720px) {
    .dv-tab { flex:1 1 0; font-size:0.86rem; }
  }
  .dv-domain-panel { padding:0.75rem 0.9rem; border:1px solid var(--rule);
    border-radius:var(--r-md); background:var(--bg); }
  .dv-domain-panel[hidden] { display:none; }
  .dv-domain-panel-head { font-size:0.78rem; font-weight:600; color:var(--fg-soft);
    margin-bottom:0.4rem; padding-bottom:0.4rem; border-bottom:1px solid var(--rule); }
  .dv-domain-list { list-style:none; margin:0; padding:0; }
  .dv-domain-row { padding:0.45rem 0; border-top:1px solid var(--rule); }
  .dv-domain-row:first-child { border-top:0; padding-top:0; }
  .dv-domain-item { font-size:0.85rem; line-height:1.55; color:var(--link); text-decoration:none; }
  .dv-domain-item-plain { color:var(--fg); }
  .dv-domain-meta { display:block; font-size:0.72rem; color:var(--muted); margin-top:0.15rem; }
  .dv-domain-none { font-size:0.82rem; color:var(--muted); }
  .dv-legacy { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:0.5rem; }
  .dv-legacy-item { display:flex; flex-direction:column; gap:0.15rem; padding:0.6rem 0.75rem;
    border:1px solid var(--rule); border-radius:var(--r-md); background:var(--card);
    text-decoration:none; color:var(--fg); }
  .dv-legacy-item:active { background:var(--card-alt); }
  .dv-legacy-label { font-size:0.86rem; font-weight:600; }
  .dv-legacy-desc { font-size:0.72rem; color:var(--muted); }
  .dv-mod:target .dv-mod-head { border-bottom-color:var(--accent-brand); }
  @media (max-width:640px) {
    .dv-masthead h1 { font-size:1.28rem; }
    .dv-card { padding:0.8rem; }
    .dv-card-title { font-size:0.94rem; }
    .dv-legacy { grid-template-columns:1fr; }
    .dv-domain-panel { padding:0.7rem 0.8rem; }
    .dv-float-top { right:0.75rem; bottom:0.75rem; width:42px; height:42px; }
    .view-switch-hint { flex-basis:100%; }
  }
`;

/** 视角切换 + 快捷跳转平滑滚动 + 返回顶部 + 横滑边缘态 + 领域标签切换（均纯前端，不改数据）。 */
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
  var sw=document.getElementById('view-switch');
  if(sw) sw.addEventListener('click',function(e){
    var b=e.target&&e.target.closest?e.target.closest('.view-switch-btn'):null;
    if(!b)return;
    apply(b.getAttribute('data-view'));
  });

  var top=document.getElementById('dv-top');
  var floatTop=document.getElementById('dv-float-top');
  function onScroll(){
    if(floatTop) floatTop.classList.toggle('is-visible',(window.scrollY||window.pageYOffset||0)>320);
  }
  function smoothTo(el){ if(el&&el.scrollIntoView) el.scrollIntoView({behavior:'smooth',block:'start'}); }
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

  // 横滑边缘态：内容超出时右缘渐隐，滑到底取消渐隐（纯视觉，不动数据/不改布局）
  var scrollers=root?root.querySelectorAll('.dv-scroller'):[];
  function markEdge(el){
    var over=el.scrollWidth-el.clientWidth>4;
    el.classList.toggle('has-more',over);
    el.classList.toggle('at-end',!over||el.scrollLeft>=el.scrollWidth-el.clientWidth-4);
  }
  if(scrollers.length){
    scrollers.forEach(function(el){
      markEdge(el);
      el.addEventListener('scroll',function(){markEdge(el);},{passive:true});
    });
    window.addEventListener('resize',function(){scrollers.forEach(markEdge);},{passive:true});
  }

  // 六大经营领域：平铺标签切换单一明细面板（不跳外页、不做跨模块过滤）
  function selectDomain(id){
    if(!root) return;
    root.querySelectorAll('.dv-tab[data-domain-tab]').forEach(function(t){
      var on=t.getAttribute('data-domain-tab')===id;
      t.classList.toggle('active',on);
      t.setAttribute('aria-selected',on?'true':'false');
      t.setAttribute('tabindex',on?'0':'-1');
    });
    root.querySelectorAll('.dv-domain-panel').forEach(function(p){
      p.hidden=p.id!=='dv-domain-panel-'+id;
    });
  }
  if(root) root.addEventListener('click',function(e){
    var t=e.target&&e.target.closest?e.target.closest('.dv-tab[data-domain-tab]'):null;
    if(!t)return;
    selectDomain(t.getAttribute('data-domain-tab'));
  });
  // 标签键盘可达：左右方向键在六个领域间切换（role=tablist 语义要求）
  if(root) root.addEventListener('keydown',function(e){
    var t=e.target;
    if(!t||!t.getAttribute||!t.getAttribute('data-domain-tab'))return;
    var step=e.key==='ArrowRight'?1:(e.key==='ArrowLeft'?-1:0);
    if(!step)return;
    var list=Array.prototype.slice.call(root.querySelectorAll('.dv-tab[data-domain-tab]'));
    var i=list.indexOf(t);
    if(i<0)return;
    var next=list[(i+step+list.length)%list.length];
    e.preventDefault();
    selectDomain(next.getAttribute('data-domain-tab'));
    next.focus();
  });
  // 本期经营重点：点击展开/收起当日命中条目（逐行独立展开，不做单选互斥 ——
  // 管理者常要同时对照两三条重点；与六大领域「单一面板」不同，那里是互斥浏览）
  if(root) root.addEventListener('click',function(e){
    var b=e.target&&e.target.closest?e.target.closest('.dv-focus-btn[data-expand-focus]'):null;
    if(!b)return;
    var id=b.getAttribute('data-expand-focus');
    var box=document.getElementById('dv-focus-detail-'+id);
    if(!box)return;
    var opening=box.hidden;
    box.hidden=!opening;
    b.setAttribute('aria-expanded',opening?'true':'false');
  });
})();`;
}
