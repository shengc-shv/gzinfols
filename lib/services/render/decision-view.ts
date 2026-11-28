/**
 * 零售经营决策情报视角（第一期 · 管理决策型经营情报首页）。
 *
 * 2026-11-28 sc 拍板：按新规格**推翻早版六模块**，改为八模块结构：
 *   ① 页头数据状态 ② 今日定调 ③ 今日必读 ④ 商机洞察 ⑤ 风险预警
 *   ⑥ 管理关注 ⑦ 六大经营领域导航 ⑧ 原有专业内容入口（+ 角色轻量筛选）
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
import type { DeltaMark } from "../../contracts/report";
import { escapeHtml } from "./cards";
import { itemAnchorId } from "./atoms";
import { prevDateKey } from "../../utils/time";
import { stripHeroPrefix } from "../../utils/hero-text";
import { BUSINESS_DOMAINS, DOMAIN_IDS, classifyBusinessDomain } from "../vocab/business-domains";

/** 顶部快捷跳转 + 八模块锚点（id 与下方 section 一一对应，测试守护）。 */
export const DV_MODULE_NAV: ReadonlyArray<{ id: string; label: string }> = [
  { id: "dv-hero", label: "今日定调" },
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
  return `<article class="dv-card dv-key"${body?.primary_domain ? ` data-domain="${escapeHtml(body.primary_domain)}"` : ""}>
  <h3 class="dv-card-title">${escapeHtml(m.title || (body?.title_cn ?? ""))}</h3>
  ${fields || domain ? `<div class="dv-chips">${domain}${fields}</div>` : ""}
  ${fact ? `<p class="dv-fact"><b>事实</b> ${escapeHtml(fact)}</p>` : ""}
  ${inference ? `<p class="dv-infer"><b>研判</b> ${escapeHtml(inference)}</p>` : ""}
  <p class="dv-why"><b>值得关注</b> ${escapeHtml(m.why)}</p>
  <div class="dv-card-foot">来源：${src}</div>
</article>`;
}

/** 商机洞察卡：机会 + 客群 + 影响（事实呈现，不写操作指令）。 */
function opportunityCard(it: ReportInsight, domainOf: (url: string) => string): string {
  const domain = (it.sources ?? []).map((s) => s?.url).find((u) => u && domainOf(u)) ?? "";
  const dom = domain ? domainOf(domain) : "";
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
  return `<article class="dv-card dv-opp"${dom ? ` data-domain="${escapeHtml(dom)}"` : ""}>
  <h3 class="dv-card-title">${escapeHtml(it.topic)}${marks ? `<span class="dv-srcs">${marks}</span>` : ""}</h3>
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
function riskBlock(r: RiskItem | undefined, domainOf: (url: string) => string): string {
  if (!r) return "";
  const src = (r.sources ?? []).find((s) => s?.url);
  const dom = (r.sources ?? []).map((s) => s?.url).find((u) => u && domainOf(u)) ?? "";
  const grade = evidenceGrade(r.source);
  const link = src
    ? `<a class="dv-src" href="${escapeHtml(src.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(riskSourceLabel(src))}</a>`
    : `<span class="dv-src dv-src-missing">来源未标注</span>`;
  return `<article class="dv-card dv-risk"${dom ? ` data-domain="${escapeHtml(domainOf(dom))}"` : ""}>
  <h3 class="dv-card-title">${escapeHtml(r.topic)}</h3>
  ${grade || deltaText(r.delta) ? `<div class="dv-chips">${grade ? `<span class="dv-chip dv-chip-grade">${grade}</span>` : ""}${deltaText(r.delta) ? `<span class="dv-chip dv-chip-delta">${escapeHtml(deltaText(r.delta))}</span>` : ""}</div>` : ""}
  ${r.evidence ? `<p class="dv-fact"><b>事实依据</b> ${escapeHtml(r.evidence)}</p>` : ""}
  ${r.impact ? `<p class="dv-infer"><b>潜在影响</b> ${escapeHtml(r.impact)}</p>` : ""}
  <div class="dv-card-foot">来源：${link}</div>
</article>`;
}

function empty(text: string): string {
  return `<p class="dv-empty">${escapeHtml(text)}</p>`;
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
  const domainOf = (url: string): string => bodyMap.get(url)?.primary_domain ?? "";
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
  const navItems = hero ? DV_MODULE_NAV : DV_MODULE_NAV.filter((m) => m.id !== "dv-hero");
  const heroBlock = hero
    ? `<section class="dv-mod dv-hero" id="dv-hero">
  <div class="dv-mod-head"><h2>今日定调</h2><span class="dv-mod-sub">基于公开事实的综合判断 · 非新闻标题复述</span></div>
  <p class="dv-hero-text">${escapeHtml(hero)}</p>
  ${backToTop()}
</section>`
    : "";

  // ---- ③ 今日必读 ----
  const mustRead = `<section class="dv-mod" id="dv-mustread">
  <div class="dv-mod-head"><h2>今日必读</h2><span class="dv-mod-sub">默认 3 条 · 重要性优先 · 经营价值优先</span></div>
  ${keys.length ? `<div class="dv-scroller">${keys.map((m) => mustReadCard(m, bodyMap, insightMap)).join("")}</div>` : empty("今日暂无值得重点关注的变化（宁缺毋滥，不生成内容补足数量）。")}
  ${backToTop()}
</section>`;

  // ---- ④ 商机洞察 ----
  const opportunity = `<section class="dv-mod" id="dv-opportunity">
  <div class="dv-mod-head"><h2>商机洞察</h2><span class="dv-mod-sub">公开变化中的业务线索 · 非已确认客户需求</span></div>
  ${opps.length ? `<div class="dv-scroller">${opps.map((o) => opportunityCard(o, domainOf)).join("")}</div>` : empty("今日暂无可研判的经营机会。")}
  ${backToTop()}
</section>`;

  // ---- ⑤ 风险预警 ----
  const risk = `<section class="dv-mod" id="dv-risk">
  <div class="dv-mod-head"><h2>风险预警</h2><span class="dv-mod-sub">重大风险独立展示 · 等级依来源客观标注</span></div>
  ${report.risk ? `<div class="dv-scroller">${riskBlock(report.risk, domainOf)}</div>` : empty("今日暂无重大风险预警。")}
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
  const attentionHtml = attention.length
    ? attention.slice(0, 3).map((a, i) => `<article class="dv-card dv-attn">
    <h3 class="dv-card-title"><span class="dv-attn-n">${i + 1}</span> ${escapeHtml(a.topic)}</h3>
    <p class="dv-why">${escapeHtml(a.reason)}</p>
    <div class="dv-chips"><span class="dv-chip">建议关注</span>${a.needCheck ? '<span class="dv-chip dv-chip-risk">建议进一步核实</span>' : ""}${a.crossDept ? '<span class="dv-chip">建议跨条线研究</span>' : ""}</div>
  </article>`).join("")
    : empty("今日暂无需要归纳的管理关注事项。");
  const attentionSection = `<section class="dv-mod" id="dv-attention">
  <div class="dv-mod-head"><h2>管理关注</h2><span class="dv-mod-sub">不超过 3 项 · 建议性质 · 非已作决定</span></div>
  ${attentionHtml}
  ${backToTop()}
</section>`;

  // ---- ⑦ 六大经营领域导航（当日计数 + S/A 亮标；领域判定来自数据侧 primary_domain）----
  const domainCounts = new Map<string, { total: number; high: number }>();
  for (const d of DOMAIN_IDS) domainCounts.set(d, { total: 0, high: 0 });
  for (const it of allItems) {
    if (!it.primary_domain || !domainCounts.has(it.primary_domain)) continue;
    const c = domainCounts.get(it.primary_domain)!;
    c.total += 1;
    if (it.importance === 3 || it.importance === 2) c.high += 1;
  }
  const domainCards: string[] = [];
  const domainDetails: string[] = [];
  for (const d of BUSINESS_DOMAINS) {
    const c = domainCounts.get(d.id) ?? { total: 0, high: 0 };
    const members = allItems.filter((it) => it.primary_domain === d.id).slice(0, 12);
    const detailId = `dv-domain-detail-${d.id}`;
    domainCards.push(`<button type="button" class="dv-domain" data-expand-domain="${d.id}" aria-expanded="false" aria-controls="${detailId}">
      <span class="dv-domain-label">${escapeHtml(d.short)}</span>
      <span class="dv-domain-hint">${escapeHtml(d.name)}</span>
      <span class="dv-domain-count">${c.total > 0 ? `当日 ${c.total} 条${c.high ? ` · 含重点 ${c.high}` : ""}` : "当日暂无"}</span>
    </button>`);
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
    domainDetails.push(`<div class="dv-domain-detail" id="${detailId}" hidden>
      <div class="dv-domain-detail-head">${escapeHtml(d.short)} · 当日条目${members.length > 12 ? "（前 12 条）" : ""}</div>
      <ul class="dv-domain-list">${detail}</ul>
    </div>`);
  }
  const domainsSection = `<section class="dv-mod" id="dv-domains">
  <div class="dv-mod-head"><h2>六大经营领域</h2><span class="dv-mod-sub">按领域浏览 · 点击展开当日条目</span></div>
  <div class="dv-roles" role="group" aria-label="按经营领域过滤">
    <button type="button" class="dv-role active" data-role="all">全部</button>
    ${BUSINESS_DOMAINS.map((d) => `<button type="button" class="dv-role" data-role="${d.id}">${escapeHtml(d.short)}</button>`).join("")}
  </div>
  <nav class="dv-domains">${domainCards.join("")}</nav>
  ${domainDetails.join("")}
  ${backToTop()}
</section>`;

  // ---- ⑧ 原有专业内容入口（全部复用现成链接，不建死链）----
  const legacyItems = [
    { href: "#dv-mustread", label: "股市与必读", desc: "本期市场与要情" },
    { href: "#dv-opportunity", label: "广东IPO", desc: "区域资本市场" },
    { href: "../topics.html", label: "主题追踪", desc: "跨日事件连续性" },
    { href: "../research.html", label: "研报解读", desc: "同业深度分析" },
    { href: "../redchip/index.html", label: "红筹线索", desc: "特色信息入口" },
    { href: "../search.html", label: "资讯搜索", desc: "按标题与主题检索" },
    { href: "../archive.html", label: "历史归档", desc: "按日期查阅" },
  ];
  const legacySection = `<section class="dv-mod" id="dv-legacy">
  <div class="dv-mod-head"><h2>专业内容与深度阅读</h2><span class="dv-mod-sub">原有模块保留 · 不与首页核心内容重复堆叠</span></div>
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
  .dv-scroller { display:flex; flex-direction:row; gap:0.6rem;
    overflow-x:auto; -webkit-overflow-scrolling:touch; scroll-snap-type:x mandatory;
    scrollbar-width:thin; scrollbar-color:var(--rule) transparent;
    padding:0 0.4rem 0.6rem 0; }
  .dv-scroller > .dv-card { flex:0 0 auto; width:82vw; max-width:340px;
    margin:0; scroll-snap-align:start; box-sizing:border-box; }
  @media (min-width:720px) {
    .dv-scroller { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr));
      overflow:visible; padding-bottom:0; padding-right:0; scroll-snap-type:none; }
    .dv-scroller > .dv-card { width:auto; max-width:none; }
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
  .dv-roles { display:flex; flex-wrap:wrap; gap:0.4rem; margin:0 0 0.7rem; }
  .dv-role { font:inherit; font-size:0.78rem; padding:0.24rem 0.7rem; min-height:32px;
    border:1px solid var(--rule); border-radius:999px; background:var(--bg);
    color:var(--fg-soft); cursor:pointer; }
  .dv-role.active { background:var(--accent); color:var(--accent-fg); border-color:var(--accent); }
  .dv-domains { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:0.6rem; }
  .dv-domain { display:flex; flex-direction:column; gap:0.2rem; min-height:64px; padding:0.7rem 0.8rem;
    border:1px solid var(--rule); border-radius:var(--r-md); background:var(--card); text-decoration:none; color:var(--fg); }
  .dv-domain { font:inherit; text-align:left; cursor:pointer; }
  .dv-domain:active, .dv-domain[aria-expanded="true"] { background:var(--card-alt); }
  .dv-domain-detail { margin:0.5rem 0 0; padding:0.7rem 0.85rem;
    border:1px solid var(--rule); border-radius:var(--r-md); background:var(--bg); }
  .dv-domain-detail[hidden] { display:none; }
  .dv-domain-detail-head { font-size:0.78rem; font-weight:600; color:var(--fg-soft); margin-bottom:0.45rem; }
  .dv-domain-list { list-style:none; margin:0; padding:0; }
  .dv-domain-row { padding:0.4rem 0; border-top:1px solid var(--rule); }
  .dv-domain-row:first-child { border-top:0; }
  .dv-domain-item { font-size:0.85rem; line-height:1.5; color:var(--link); text-decoration:none; }
  .dv-domain-item-plain { color:var(--fg); }
  .dv-domain-meta { display:block; font-size:0.72rem; color:var(--muted); margin-top:0.15rem; }
  .dv-domain-none { font-size:0.82rem; color:var(--muted); }
  .dv-domain-label { font-size:0.9rem; font-weight:600; }
  .dv-domain-hint { font-size:0.73rem; color:var(--muted); }
  .dv-domain-count { font-size:0.72rem; color:var(--accent-brand); }
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
    .dv-domains, .dv-legacy { grid-template-columns:1fr; }
    .dv-float-top { right:0.75rem; bottom:0.75rem; width:42px; height:42px; }
    .view-switch-hint { flex-basis:100%; }
  }
`;

/** 视角切换 + 快捷跳转平滑滚动 + 返回顶部 + 角色轻量筛选（均纯前端，不改数据）。 */
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

  // 六大领域标签过滤：只按领域 id 过滤卡片，不新增 AI 任务、不删数据、不改锚点
  var roleBar=root?root.querySelector('.dv-roles'):null;
  if(roleBar) roleBar.addEventListener('click',function(e){
    var b=e.target&&e.target.closest?e.target.closest('.dv-role'):null;
    if(!b)return;
    var domain=b.getAttribute('data-role')||'all';
    roleBar.querySelectorAll('.dv-role').forEach(function(x){x.classList.toggle('active',x===b);});
    root.querySelectorAll('.dv-scroller .dv-card').forEach(function(card){
      if(domain==='all'){card.style.display='';return;}
      var dom=card.getAttribute('data-domain')||'';
      card.style.display=(dom===domain)?'':'none';
    });
  });

  // 领域卡片点击 → 本页展开/收起该领域当日条目（不跳外页、零死链）
  if(root) root.addEventListener('click',function(e){
    var b=e.target&&e.target.closest?e.target.closest('.dv-domain[data-expand-domain]'):null;
    if(!b)return;
    var id=b.getAttribute('data-expand-domain');
    var detail=document.getElementById('dv-domain-detail-'+id);
    if(!detail)return;
    var opening=detail.hidden;
    root.querySelectorAll('.dv-domain-detail').forEach(function(d){d.hidden=true;});
    root.querySelectorAll('.dv-domain[data-expand-domain]').forEach(function(x){x.setAttribute('aria-expanded','false');});
    detail.hidden=!opening;
    b.setAttribute('aria-expanded',opening?'true':'false');
  });
})();`;
}
