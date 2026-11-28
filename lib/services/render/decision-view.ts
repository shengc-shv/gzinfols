/**
 * 零售经营决策情报视角（第一期 · 管理决策型经营情报首页）。
 *
 * 2026-11-28 sc 拍板：新版改为**手机端三层经营情报首页**：
 *   第一层 30 秒总览：核心判断 + 三件重点变化（最多 3）+ 管理层关注（最多 1）
 *   第二层 3 分钟阅读：今日经营重点 3—5 条（发生了什么 / 对经营意味着什么 / 接下来关注什么）
 *   第三层 深度信息：股市紧凑纵向 + 商机 / 风险 / 年度重点 / 六大领域 / 专业入口
 * 版本切换（方案 A）保留：**旧版资讯默认**，新版手动切换；两视角共存同一 HTML，
 * 共用同一 report JSON，旧视角 DOM/锚点/断言零改动。音频只在旧版，新版不接。
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
import { renderStockCompact } from "./stock-block";
import { stripHeroPrefix } from "../../utils/hero-text";
import { BUSINESS_DOMAINS, DOMAIN_IDS, classifyBusinessDomainWithFallback } from "../vocab/business-domains";
import { IPO_DISPLAY_STAGE_LABEL } from "../classify/gd-ipo";
import { gdIpoDisplayStageOf, ipoCompanyShortOf, isRoutineIpoItem, topGdIpo, companyNameOf } from "../classify/gd-ipo-spoken";
import { IPO_LIST_WINDOW_DAYS } from "../../ipo-config";

/**
 * 今日必读的**渲染上限**（2026-11-28）。
 *
 * 与数据侧真源 `MUST_READ_PLAY_TARGET = 5`（`services/memory/event-types.ts`，上限；
 * 基础 3 条 + 质量门槛扩展 0~2 条）对齐：数据侧定稿几条就展示几条，这里只做防御性上限。
 * ⛔ 不要为了让页面「整齐」改成固定 3 —— 数据侧近 8 期稳定产出 4~5 条，
 * 截到 3 等于每期丢掉 1~2 条最高价值信息。
 */
const MUST_READ_RENDER_CAP = 5;

/** 顶部快捷跳转 · 三层锚点（id 与下方 section 一一对应，测试守护）。 */
export const DV_MODULE_NAV: ReadonlyArray<{ id: string; label: string }> = [
  { id: "dv-core", label: "核心判断" },
  { id: "dv-key", label: "重点变化" },
  { id: "dv-attention", label: "管理关注" },
  { id: "dv-priorities", label: "经营重点" },
  { id: "dv-stock", label: "股市行情" },
  { id: "dv-opportunity", label: "商机洞察" },
  { id: "dv-risk", label: "风险预警" },
  { id: "dv-focus", label: "年度重点" },
  { id: "dv-domains", label: "经营领域" },
  { id: "dv-legacy", label: "深度阅读" },
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
function sourceHref(item: Pick<ReportItem, "url">): string {
  // 决策视角不渲染正文条目锚点（itm-* 只在隐藏的旧版 DOM 里）——
  // ⛔ 不能返回 #itm-xxx，否则新版点击是死链。一律走原文外链。
  return item.url || "";
}

/** 只有 URL 时给一个人能读的来源名（域名），不写「相关来源」这种占位词。 */
function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "原文";
  }
}

/** 管理关注文案兜底：模型若把内部候选 ID 写进正文，展示前替换成人话。 */
function humanizeAttention(s: string): string {
  return s.replace(/候选\s*c\d+/gi, "相关条目").replace(/\bc\d+\b/gi, "相关条目");
}

/** 标题匹配用：去掉空白/标点，只留中英文数字。 */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[\s，。！？、；：“”‘’（）()《》\-—·,.!?;:'"\/\\|]/g, "");
}

/** 商机没有 sources 时，按标题 bigram 重合从当日条目里找回来源（同一条信息不另造）。 */
function matchItemsByTopic(topic: string, items: ReportItem[]): ReportItem[] {
  const t = normalizeForMatch(topic);
  if (t.length < 4) return [];
  const grams = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) grams.add(t.slice(i, i + 2));
  return items
    .map((it) => {
      const s = normalizeForMatch(it.title_cn || "");
      let hit = 0;
      for (let i = 0; i < s.length - 1; i++) if (grams.has(s.slice(i, i + 2))) hit++;
      return { it, hit };
    })
    .filter((x) => x.hit >= 3)
    .sort((a, b) => b.hit - a.hit)
    .slice(0, 3)
    .map((x) => x.it);
}

/** 三态增量徽章（复用既有 DeltaMark 文案口径；无则不渲染）。 */
function deltaText(d: DeltaMark | undefined): string {
  if (!d) return "";
  if (d.state === "new") return "新增";
  if (d.state === "changed") return "进展";
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

interface PriorityView {
  title: string;
  url: string;
  short: string;
  what: string;
  impact: string;
  watch: string;
  delta?: DeltaMark;
  importance?: 1 | 2 | 3;
  domain?: string;
  focusHits?: ReportFocusHit[];
  riskLevel?: "critical";
  source?: string;
  date?: string;
}

function firstSentence(s: string, max = 40): string {
  const t = (s ?? "").trim();
  if (!t) return "";
  const head = t.split(/[。；;]/)[0]?.trim() || t;
  return head.length > max ? `${head.slice(0, max - 1)}…` : head;
}

function watchFallback(domain?: string): string {
  switch (domain) {
    case "wealth_aum":
      return "关注财富货架配置与客户风险偏好的变化";
    case "customer_growth":
      return "关注客群结构、获客成本与活跃度的变化";
    case "retail_credit":
      return "关注政策落地节奏与区域成交修复情况";
    case "channel_ai":
      return "关注渠道流量结构与数字化投入产出变化";
    case "risk_consumer":
      return "关注监管口径与客诉风险的变化";
    case "regional_peer":
      return "关注同业动作与区域竞争格局的变化";
    default:
      return "关注后续政策落地与市场反应";
  }
}

function normTitle(s: string): string {
  return (s ?? "").toLowerCase().replace(/[\s，。！？、；：“”‘’（）()《》\-—·]/g, "");
}

/**
 * 三层视图模型：优先读 LLM brief；缺省/残缺时用 must_read + 正文/商机 impact 回退。
 * ⛔ 不造数：所有标题/URL/状态/领域都来自既有报告字段。
 */
function resolvePriorities(
  report: DailyReport,
  bodyMap: Map<string, ReportItem>,
  insightMap: Map<string, ReportInsight>,
): PriorityView[] {
  const must = (report.must_read ?? []).slice(0, MUST_READ_RENDER_CAP);
  const brief = report.brief?.priorities ?? [];
  const byUrl = new Map<string, (typeof brief)[number]>();
  const byTitle = new Map<string, (typeof brief)[number]>();
  for (const p of brief) {
    if (p.url) byUrl.set(p.url, p);
    if (p.title) byTitle.set(normTitle(p.title), p);
  }
  const out: PriorityView[] = [];
  const build = (
    m: (typeof must)[number] | undefined,
    bp: (typeof brief)[number] | undefined,
  ): PriorityView | undefined => {
    const body = m?.url ? bodyMap.get(m.url) : bp?.url ? bodyMap.get(bp.url) : undefined;
    const title = (bp?.title || m?.title || body?.title_cn || "").trim();
    if (!title) return undefined;
    const url = m?.url || bp?.url || body?.url || "";
    return {
      title,
      url,
      short: bp?.short || (m ? firstSentence(m.why) : "") || title,
      what: bp?.what || body?.summary || m?.why || "",
      impact: bp?.impact || (url ? insightMap.get(url)?.impact ?? "" : "") || m?.why || "",
      watch: bp?.watch || watchFallback(body?.primary_domain),
      delta: m?.delta,
      importance: body?.importance,
      domain: body?.primary_domain,
      focusHits: body?.focus_hits,
      riskLevel: bp?.riskLevel,
      source: body?.source,
      date: body?.date,
    };
  };

  const withPromotedRisk = (list: PriorityView[]): PriorityView[] => {
    const risk = report.promotedRisk;
    if (!risk) return list;
    const idx = list.findIndex(
      (p) =>
        (risk.url && p.url === risk.url) ||
        (normTitle(p.title) && normTitle(p.title) === normTitle(risk.title)),
    );
    if (idx >= 0) {
      list[idx] = { ...list[idx], riskLevel: "critical" };
      return list;
    }
    return [{ ...risk, url: risk.url ?? "", riskLevel: "critical" as const }, ...list].slice(0, MUST_READ_RENDER_CAP);
  };

  // LLM 已选 3~5 条 → 只展示它选的（不再把未选 must_read 补回来）。
  if (brief.length) {
    for (const bp of brief) {
      const m = must.find((x) => (bp.url && x.url === bp.url) || normTitle(x.title || "") === normTitle(bp.title));
      const p = build(m, bp);
      if (p) out.push(p);
    }
    return withPromotedRisk(out).slice(0, MUST_READ_RENDER_CAP);
  }

  // 无 brief（历史日报 / LLM 失败）→ 回退 must_read 3~5 条。
  for (const m of must) {
    const body = m.url ? bodyMap.get(m.url) : undefined;
    const bp = (m.url ? byUrl.get(m.url) : undefined) ?? byTitle.get(normTitle(m.title || body?.title_cn || ""));
    const p = build(m, bp);
    if (p) out.push(p);
  }
  return withPromotedRisk(out).slice(0, MUST_READ_RENDER_CAP);
}

/**
 * 第三层去重：事件是否已进入第二层经营重点。
 * 先按 URL 精确命中，再按归一标题包含判断（防同一事件不同标题）。
 */
function priorityRefIndex(title: string, urls: string[], priorities: PriorityView[]): number {
  const urlSet = new Set(urls.filter(Boolean));
  for (let i = 0; i < priorities.length; i++) {
    const p = priorities[i];
    if (p.url && urlSet.has(p.url)) return i + 1;
  }
  const t = normTitle(title);
  if (t.length < 4) return 0;
  for (let i = 0; i < priorities.length; i++) {
    const p = normTitle(priorities[i].title);
    if (t === p) return i + 1;
    if (p.length >= 8 && t.length >= 8 && (t.includes(p) || p.includes(t))) return i + 1;
  }
  return 0;
}

function refCard(n: number, title: string): string {
  return `<div class="dv-ref">
  <a class="dv-ref-link" href="#dv-priority-${n}">已纳入今日经营重点 #${n}，点击查看 ↑</a>
  <span class="dv-ref-title">${escapeHtml(title)}</span>
</div>`;
}

/** 整卡点击热区：原生 a 覆盖全卡，手机 WebView 不依赖 window.open。 */
function cardHit(href: string): string {
  return href
    ? `<a class="dv-card-hit" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" aria-label="打开原文"></a>`
    : "";
}

/** 展开按钮：默认隐藏，前端量到内容溢出才显示。 */
function expandButton(): string {
  return `<button class="dv-expand" type="button" aria-expanded="false" hidden>展开</button>`;
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
  const href = sourceHref({ url: m.url });
  const srcLabel = body?.source ?? (m.url ? "原文" : "来源未标注");
  const src = href
    ? `<a class="dv-src" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(srcLabel)}</a>`
    : `<span class="dv-src dv-src-missing">${escapeHtml(srcLabel)}</span>`;
  const fields = [
    body ? `<span class="dv-chip dv-chip-grade">${gradeLabel(body)}</span>` : "",
    body ? evidenceGrade(body.tier ? String(body.tier) : body.source_type === "official" ? "T1" : "T2")
      ? `<span class="dv-chip dv-chip-evidence">${evidenceGrade(body.tier ? String(body.tier) : body.source_type === "official" ? "T1" : "T2")}</span>` : ""
      : "",
    body?.date ? `<span class="dv-chip dv-chip-date">发布 ${escapeHtml(body.date)}</span>` : "",
    deltaText(m.delta) ? `<span class="dv-chip dv-chip-delta">${escapeHtml(deltaText(m.delta))}</span>` : "",
  ]
    .filter(Boolean)
    .join("");
  const domain = body?.primary_domain
    ? `<span class="dv-chip dv-chip-domain">${escapeHtml(BUSINESS_DOMAINS.find((d) => d.id === body.primary_domain)?.short ?? body.primary_domain)}</span>`
    : "";
  return `<article class="dv-card dv-key"${href ? ' data-href="' + escapeHtml(href) + '"' : ""}>${cardHit(href)}
  <h3 class="dv-card-title">${escapeHtml(m.title || (body?.title_cn ?? ""))}</h3>
  ${body?.focus_hits?.length ? `<div class="dv-ftags">${focusTags(body.focus_hits)}</div>` : ""}
  ${fields || domain ? `<div class="dv-chips">${domain}${fields}</div>` : ""}
  ${fact ? `<p class="dv-fact"><b>事实</b> ${escapeHtml(fact)}</p>` : ""}
  ${inference ? `<p class="dv-infer"><b>研判</b> ${escapeHtml(inference)}</p>` : ""}
  <p class="dv-why"><b>值得关注</b> ${escapeHtml(m.why)}</p>
  <div class="dv-card-foot">来源：${src}</div>
  ${expandButton()}
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
  // 整卡可点：优先站内详情页（与必读同源落点），否则第一来源外链。
  const primary = (it.sources ?? []).find((s) => s?.url);
  const href = primary?.url ? sourceHref({ url: primary.url }) : "";
  const segs = (it.segments ?? []).map((s) => `<span class="dv-tag">${escapeHtml(s)}</span>`).join("");
  const stage =
    it.maturity?.stage === "landed" ? "公开信息显示已落地"
      : it.maturity?.stage === "progress" ? "公开信息显示推进中"
        : it.maturity?.stage === "clue" ? "线索阶段"
          : "";
  return `<article class="dv-card dv-opp"${href ? ' data-href="' + escapeHtml(href) + '"' : ""}>${cardHit(href)}
  <h3 class="dv-card-title">${escapeHtml(it.topic)}${marks ? `<span class="dv-srcs">${marks}</span>` : ""}</h3>
  ${hitBody?.focus_hits?.length ? `<div class="dv-ftags">${focusTags(hitBody.focus_hits)}</div>` : ""}
  ${stage ? `<div class="dv-chips"><span class="dv-chip">${stage}</span>${deltaText(it.delta) ? `<span class="dv-chip dv-chip-delta">${escapeHtml(deltaText(it.delta))}</span>` : ""}</div>` : ""}
  ${it.impact ? `<p class="dv-infer"><b>经营影响</b> ${escapeHtml(it.impact)}</p>` : ""}
  ${segs ? `<div class="dv-tags"><span class="dv-tag-label">关联客群</span>${segs}</div>` : ""}
  ${expandButton()}
</article>`;
}

/** 风险来源链接文字：正常标题原样；超长（正文被塞进 title）退化为域名 +「原文」。 */
function riskSourceLabel(src: { title?: string; url: string }, topic?: string): string {
  const title = (src.title ?? "").trim();
  // 来源标题与卡片标题逐字相同 → 不重复一遍，退回「域名 · 原文」。
  if (title && title !== (topic ?? "").trim() && title.length <= 60) return title;
  const host = hostOfUrl(src.url);
  return host !== "原文" ? `${host} · 原文` : "原文";
}

/** 风险预警卡：风险事项 + 事实依据 + 潜在影响 + 证据等级 + 来源。 */
function riskBlock(r: RiskItem | undefined, bodyMap: Map<string, ReportItem>): string {
  if (!r) return "";
  const src = (r.sources ?? []).find((s) => s?.url) ?? (r.url ? { url: r.url, title: r.topic } : undefined);
  const hitBody = (r.sources ?? []).map((s) => (s?.url ? bodyMap.get(s.url) : undefined)).find((b) => b?.focus_hits?.length);
  const grade = evidenceGrade(r.source);
  const link = src
    ? `<a class="dv-src" href="${escapeHtml(src.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(riskSourceLabel(src, r.topic))}</a>`
    : `<span class="dv-src dv-src-missing">来源未标注</span>`;
  return `<article class="dv-card dv-risk"${src ? ' data-href="' + escapeHtml(src.url) + '"' : ""}>${cardHit(src?.url ?? "")}
  <h3 class="dv-card-title">${escapeHtml(r.topic)}</h3>
  ${hitBody?.focus_hits?.length ? `<div class="dv-ftags">${focusTags(hitBody.focus_hits)}</div>` : ""}
  ${grade || deltaText(r.delta) ? `<div class="dv-chips">${grade ? `<span class="dv-chip dv-chip-grade">${grade}</span>` : ""}${deltaText(r.delta) ? `<span class="dv-chip dv-chip-delta">${escapeHtml(deltaText(r.delta))}</span>` : ""}</div>` : ""}
  ${r.evidence ? `<p class="dv-fact"><b>事实依据</b> ${escapeHtml(r.evidence)}</p>` : ""}
  ${r.impact ? `<p class="dv-infer"><b>潜在影响</b> ${escapeHtml(r.impact)}</p>` : ""}
  <div class="dv-card-foot">来源：${link}</div>
  ${expandButton()}
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
  // `sec` 随条目一起带上：领域兜底（当前仅 IPO → 客户经营）需要知道条目属哪个板块。
  const SECTION_KEYS = ["gz_local", "biz_insight", "policy_market", "tech", "ipo"] as const;
  const rows: Array<{ it: ReportItem; sec: string }> = [];
  for (const s of SECTION_KEYS) for (const it of report.sections?.[s] ?? []) rows.push({ it: { ...it }, sec: s });
  // 浅拷贝：历史报告降级打标只作用于本次渲染，绝不 mutate 入参报告。
  const allItems: ReportItem[] = rows.map((r) => r.it);
  const bodyMap = new Map<string, ReportItem>();
  for (const it of allItems) if (it.url && !bodyMap.has(it.url)) bodyMap.set(it.url, it);
  // 历史报告无 primary_domain（字段为本期新增）：渲染期按同一词表临时打标，
  // 仅用于本次 DOM 展示，不 mutate 报告、不写盘；新报告走管线打标，口径同源。
  for (const { it, sec } of rows) {
    if (it.primary_domain) continue;
    const d = classifyBusinessDomainWithFallback(
      { title: it.title_cn, summary: it.summary, tags: it.tags },
      sec,
    );
    if (d) {
      it.primary_domain = d.primary_domain;
      if (d.related_domains.length) it.related_domains = d.related_domains;
    }
  }
  // 新版自己的落点：卡片来源若不在 sections 里，补一条最小 ReportItem 进领域池，
  // 保证「新版认为重要的信息」同样出现在六大领域清单，而不是只能跳旧版隐藏锚点。
  const addSourceItem = (url?: string, title?: string): void => {
    if (!url || bodyMap.has(url)) return;
    const it: ReportItem = {
      url,
      // 来源标题可能是整篇正文（证监会处罚稿实测 238 字）→ 领域清单只留短标题，
      // 完整内容仍在卡片/原文链接里，避免把长文铺进领域列表。
      title_cn: title ? (title.length > 60 ? title.slice(0, 56) + "…" : title) : url,
      source: hostOfUrl(url),
      source_type: "media",
      date: "",
      summary: "",
      importance: 2,
      rank: 0,
      tags: [],
      locale: "national",
    };
    const d = classifyBusinessDomainWithFallback(
      { title: it.title_cn, summary: it.summary, tags: it.tags },
      null,
    );
    if (d) {
      it.primary_domain = d.primary_domain;
      if (d.related_domains.length) it.related_domains = d.related_domains;
    }
    allItems.push(it);
    bodyMap.set(url, it);
  };

  const resolveInsightSources = (ins: ReportInsight): Array<{ title: string; url: string }> => {
    const given = (ins.sources ?? []).filter((s) => s?.url);
    if (given.length) return given;
    return matchItemsByTopic(ins.topic, allItems).map((it) => ({ title: it.title_cn, url: it.url }));
  };
  const resolvedInsights = (report.insights ?? []).map((ins) => ({
    ...ins,
    sources: resolveInsightSources(ins),
  }));

  for (const m of report.must_read ?? []) addSourceItem(m.url, m.title);
  for (const ins of resolvedInsights) for (const s of ins.sources ?? []) addSourceItem(s.url, s.title);
  if (report.risk) {
    addSourceItem(report.risk.url, report.risk.topic);
    for (const s of report.risk.sources ?? []) addSourceItem(s.url, s.title);
  }
  for (const a of report.attention ?? []) for (const u of a.source_urls ?? []) addSourceItem(u);

  const insightMap = new Map<string, ReportInsight>();
  for (const ins of resolvedInsights) {
    for (const s of ins.sources ?? []) if (s?.url && !insightMap.has(s.url)) insightMap.set(s.url, ins);
  }

  // 今日必读：条数由**数据侧定稿**（exec 池顺序判重后 3~5 条：工作日目标 5、周末版 4，
  // 候补用尽按实际剩余 —— 宁缺毋滥，绝不补足），渲染层只做上限保护，不再二次截断。
  // ⚠️ 2026-11-28 修：原为 `slice(0, 3)`，而数据侧近 8 期实际产 4~5 条 → 每期被机械砍掉
  // 1~2 条（实测 11-24~11-27 各 5 条、11-21~11-23 与 11-28 各 4 条，全部只显示 3 条）。
  const opps = resolvedInsights.slice(0, 3);
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

  // 管理关注（2026-11-28 独立研判）：**只读契约**，渲染层不再从必读/风险里拼装。
  // 无字段 / 空数组 → 整块不输出（历史报告天然兼容，不会退回「必读前两条换个样式」的旧行为）。
  const attnRows = (report.attention ?? []).filter(
    (a) => Boolean(a.topic) && (a.source_urls?.length ?? 0) > 0,
  );

  // ---- ① 页头数据状态 + 三层视图模型 ----
  const priorities = resolvePriorities(report, bodyMap, insightMap);
  const stats = [
    `生成日 ${escapeHtml(date)}`,
    nowHm ? `更新 ${escapeHtml(nowHm)}` : "",
    `资讯 ${rows.length}`,
    `商机 ${report.insights?.length ?? 0}`,
    `风险 ${report.risk ? 1 : 0}`,
    `重点 ${priorities.length}`,
  ].filter(Boolean).join(" · ");

  const hero = stripHeroPrefix(report.hero_line).trim();
  const briefCore = report.brief?.core_judgment?.trim() ?? "";
  const coreRaw = briefCore || hero ||
    (priorities.length ? `今日重点关注：${priorities[0].short}` : "今日暂无足以改变经营判断的重大变化");
  const core = coreRaw.length > 90 ? `${coreRaw.slice(0, 89)}…` : coreRaw;
  const coreSources = [...new Map(
    (report.must_read ?? [])
      .filter((m) => m.url)
      .map((m) => [m.url, bodyMap.get(m.url)?.source || "原文"] as const),
  ).entries()].slice(0, 3);
  const keyChanges = priorities.slice(0, 3);
  const stockHtml = renderStockCompact(report);
  const hasStock = Boolean(stockHtml);
  const hasDomains = allItems.some((it) => it.primary_domain && DOMAIN_IDS.includes(it.primary_domain));
  const navItems = DV_MODULE_NAV.filter(
    (m) =>
      (m.id !== "dv-key" || keyChanges.length > 0) &&
      (m.id !== "dv-priorities" || priorities.length > 0) &&
      (m.id !== "dv-stock" || hasStock) &&
      (m.id !== "dv-focus" || focusRows.length > 0) &&
      (m.id !== "dv-attention" || attnRows.length > 0) &&
      (m.id !== "dv-domains" || hasDomains),
  );

  const coreSection = `<section class="dv-core" id="dv-core">
  <p class="dv-core-eyebrow">核心判断</p>
  <p class="dv-core-text">${escapeHtml(core)}</p>
  <p class="dv-core-meta">${nowHm ? `更新 ${escapeHtml(nowHm)}` : `生成日 ${escapeHtml(date)}`} · 关联事件 ${report.must_read?.length ?? 0} 条${
    coreSources.length
      ? ` · 来源 ${coreSources.map(([url, label]) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`).join(" / ")}`
      : ""
  }</p>
</section>`;

  const keySection = keyChanges.length
    ? `<section class="dv-mod" id="dv-key">
  <div class="dv-mod-head"><h2>三件重点变化</h2><span class="dv-mod-sub">最多 3 件 · 不足不凑数 · 同题不拆条</span></div>
  <ol class="dv-changes">${keyChanges.map((p, i) => `<li>
    <a class="dv-change" href="#dv-priority-${i + 1}" aria-label="查看第 ${i + 1} 条经营重点">
      <div class="dv-change-head"><span class="dv-change-n">${i + 1}</span><h3>${escapeHtml(p.title)}</h3></div>
      <p class="dv-change-line">${escapeHtml(p.short)}</p>
      <div class="dv-chips">${[
        p.riskLevel === "critical" ? '<span class="dv-chip dv-risk-critical">⚠ 极高风险</span>' : "",
        p.domain ? `<span class="dv-chip dv-chip-domain">${escapeHtml(BUSINESS_DOMAINS.find((d) => d.id === p.domain)?.short ?? p.domain)}</span>` : "",
        p.importance ? `<span class="dv-chip dv-chip-grade">${gradeLabel({ importance: p.importance })}</span>` : "",
        deltaText(p.delta) ? `<span class="dv-chip dv-chip-delta">${escapeHtml(deltaText(p.delta))}</span>` : "",
      ].filter(Boolean).join("")}</div>
      <span class="dv-change-more">看详情 ↓</span>
    </a>
  </li>`).join("")}</ol>
  ${backToTop()}
</section>`
    : "";

  const attnTop = attnRows[0];
  const attnTopSection = attnTop
    ? `<section class="dv-mod" id="dv-attention">
  <div class="dv-mod-head"><h2>管理层关注</h2><span class="dv-mod-sub">来自具体事件的独立研判 · 建议性质 · 非已作决定</span></div>
  <article class="dv-attn-top">
    <h3>${escapeHtml(attnTop.topic)}</h3>
    <p><b>管理意义</b> ${escapeHtml(firstSentence(humanizeAttention(attnTop.significance || attnTop.rationale), 58))}</p>
    <div class="dv-chips">${attnTop.domains.slice(0, 2).map((d) => `<span class="dv-chip dv-chip-domain">${escapeHtml(BUSINESS_DOMAINS.find((x) => x.id === d)?.short ?? d)}</span>`).join("")}${attnTop.domains.length >= 2 ? '<span class="dv-chip">建议跨条线研究</span>' : ""}</div>
    <details class="dv-attn-detail"><summary>关注依据</summary><p>${escapeHtml(humanizeAttention(attnTop.rationale))}</p></details>
    <div class="dv-card-foot">来源：${attnTop.source_urls.slice(0, 2).map((u) => `<a class="dv-src" href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(bodyMap.get(u)?.source ?? "原文")}</a>`).join(" ")}</div>
  </article>
  ${backToTop()}
</section>`
    : "";

  const prioritySection = priorities.length
    ? `<section class="dv-mod" id="dv-priorities">
  <div class="dv-mod-head"><h2>今日经营重点</h2><span class="dv-mod-sub">用 3 分钟读懂今天影响零售经营的关键变化</span></div>
  <div class="dv-priorities">${priorities.map((p, i) => `<article class="dv-priority" id="dv-priority-${i + 1}">
    <div class="dv-priority-head"><span class="dv-priority-n">${i + 1}</span><h3>${escapeHtml(p.title)}</h3></div>
    ${p.focusHits?.length ? `<div class="dv-ftags">${focusTags(p.focusHits)}</div>` : ""}
    <div class="dv-chips">${[
      p.riskLevel === "critical" ? '<span class="dv-chip dv-risk-critical">⚠ 极高风险</span>' : "",
      p.domain ? `<span class="dv-chip dv-chip-domain">${escapeHtml(BUSINESS_DOMAINS.find((d) => d.id === p.domain)?.short ?? p.domain)}</span>` : "",
      p.importance ? `<span class="dv-chip dv-chip-grade">${gradeLabel({ importance: p.importance })}</span>` : "",
      deltaText(p.delta) ? `<span class="dv-chip dv-chip-delta">${escapeHtml(deltaText(p.delta))}</span>` : "",
      p.source ? `<span class="dv-chip">${escapeHtml(p.source)}${p.date ? ` · ${escapeHtml(p.date)}` : ""}</span>` : "",
    ].filter(Boolean).join("")}</div>
    <div class="dv-priority-body">
      <div class="dv-priority-part"><b>发生了什么</b><p>${escapeHtml(p.what)}</p></div>
      <div class="dv-priority-part"><b>对经营意味着什么</b><p>${escapeHtml(p.impact)}</p></div>
      <div class="dv-priority-part"><b>接下来关注什么</b><p>${escapeHtml(p.watch)}</p></div>
    </div>
    ${p.url ? `<div class="dv-card-foot">来源：<a class="dv-src" href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.source || "原文")}</a></div>` : ""}
  </article>`).join("")}</div>
  ${backToTop()}
</section>`
    : "";

  const stockSection = stockHtml
    ? `<section class="dv-mod" id="dv-stock">
  <div class="dv-mod-head"><h2>股市行情</h2><span class="dv-mod-sub">A股 / 港股 / 美股 · 三地核心指数与主线板块</span></div>
  ${stockHtml}
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
  <div class="dv-mod-head"><h2>本期经营重点</h2><span class="dv-mod-sub">配置版本 ${escapeHtml(focusSummary?.version ?? "")} · 只列当日有实质命中的 · <a class="dv-mod-link" href="../focus.html">查看跨期追踪 →</a></span></div>
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

  // ---- ③.5 广东IPO 线索（2026-11-28 sc：「IPO 至少兜底可以算经营线索」）----
  // 不新建模块：作为商机洞察的补充线索行嵌在同一模块内 —— IPO 只在有里程碑时才有意义，
  // 单开模块多数日子会留空。口径与三处外发（口播 / 横滑 / exec 池）同源：
  //   · 只列里程碑，季度例行报送（isRoutineIpoItem）整类排除；
  //   · 文案取「企业简称 + 阶段标签」，与推送行同一套收敛函数（ipoCompanyShortOf，逐字同源）；
  //   · ⛔ 不进「商机 N 条」计数（那个口径只认 report.insights）。
  // 🔴 与旧版资讯视角**同源**：同样走 topGdIpo（广东判定 + 7 天窗口 + 同企业不折叠），
  // ⛔ 不再直接读 report.sections.ipo 原始数组（会混入非广东/超窗条目，导致两版信息不对齐）。
  const ipoPool = topGdIpo(report.sections?.ipo ?? [], undefined, 9999, IPO_LIST_WINDOW_DAYS, {
    uniqueCompany: false,
  });
  const ipoLeadItems = ipoPool.filter((it) => !isRoutineIpoItem(it));
  const ipoLeads = ipoLeadItems.slice(0, 6);
  const ipoLeadsBlock = ipoLeads.length
    ? `<div class="dv-ipo-leads">
    <p class="dv-ipo-leads-head">🏦 广东IPO 线索 ${ipoLeadItems.length} 条<span class="dv-ipo-leads-sub">仅里程碑 · 季度例行报送单列</span></p>
    <ul class="dv-ipo-leads-list">${ipoLeads
      .map((it) => {
        // 与旧版卡片同一企业名口径（全称优先，简称仅兜底）
        const name = escapeHtml(companyNameOf(it.title_cn || "") || ipoCompanyShortOf(it));
        const stage = IPO_DISPLAY_STAGE_LABEL[gdIpoDisplayStageOf(it)] || "";
        const label = it.url ? `<a href="${escapeHtml(it.url)}" target="_blank" rel="noopener noreferrer">${name}</a>` : name;
        return `<li class="dv-ipo-lead">${label}${stage ? `<span class="dv-ipo-lead-stage">${escapeHtml(stage)}</span>` : ""}</li>`;
      })
      .join("")}</ul>
    ${ipoLeadItems.length > ipoLeads.length ? `<p class="dv-ipo-leads-more">另有 ${ipoLeadItems.length - ipoLeads.length} 家，见原版资讯视角「广东IPO」</p>` : ""}
  </div>`
    : "";

  // ---- ④ 商机洞察 ----
  const oppCards = opps.map((o) => {
    const n = priorityRefIndex(o.topic, (o.sources ?? []).map((s) => s?.url ?? ""), priorities);
    return n ? refCard(n, o.topic) : opportunityCard(o, bodyMap);
  });
  const opportunity = `<section class="dv-mod" id="dv-opportunity">
  <div class="dv-mod-head"><h2>商机洞察</h2><span class="dv-mod-sub">公开变化中的业务线索 · 非已确认客户需求</span></div>
  ${oppCards.length ? `<div class="dv-scroller">${oppCards.join("")}</div>${swipeHint(oppCards.length)}` : empty("今日暂无可研判的经营机会。")}
  ${ipoLeadsBlock}
  ${backToTop()}
</section>`;

  // ---- ⑤ 风险预警 ----
  const riskRef = report.risk
    ? priorityRefIndex(
        report.risk.topic,
        [report.risk.url ?? "", ...(report.risk.sources ?? []).map((s) => s?.url ?? "")],
        priorities,
      )
    : 0;
  const risk = `<section class="dv-mod" id="dv-risk">
  <div class="dv-mod-head"><h2>风险预警</h2><span class="dv-mod-sub">重大风险独立展示 · 等级依来源客观标注</span></div>
  ${
    report.risk
      ? riskRef
        ? `<div class="dv-scroller">${refCard(riskRef, report.risk.topic)}</div>`
        : `<div class="dv-scroller">${riskBlock(report.risk, bodyMap)}</div>`
      : empty("今日暂无重大风险预警。")
  }
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
  // 空领域不展示：没有当日条目的 tab / 面板整块不出；全空时整个「六大经营领域」不输出。
  const visibleDomains = BUSINESS_DOMAINS.filter((d) => (domainCounts.get(d.id)?.total ?? 0) > 0);
  let defaultDomain = visibleDomains[0]?.id ?? "";
  let richest = -1;
  for (const d of visibleDomains) {
    const t = domainCounts.get(d.id)?.total ?? 0;
    if (t > richest) {
      richest = t;
      defaultDomain = d.id;
    }
  }
  const domainTabs: string[] = [];
  const domainPanels: string[] = [];
  for (const d of visibleDomains) {
    const c = domainCounts.get(d.id) ?? { total: 0, high: 0 };
    const members = allItems.filter((it) => it.primary_domain === d.id).slice(0, 12);
    const tabId = `dv-domain-tab-${d.id}`;
    const panelId = `dv-domain-panel-${d.id}`;
    const on = d.id === defaultDomain;
    domainTabs.push(`<button type="button" role="tab" class="dv-tab${on ? " active" : ""}" id="${tabId}" data-domain-tab="${d.id}" aria-selected="${on}" aria-controls="${panelId}" tabindex="${on ? "0" : "-1"}"><span class="dv-tab-label">${escapeHtml(d.short)}</span><span class="dv-tab-count">${c.total}</span></button>`);
    const detail = members.map((it) => {
      const href = it.url ? escapeHtml(it.url) : "";
      const title = escapeHtml(it.title_cn || it.url);
      const line = href
        ? `<a class="dv-domain-item" href="${href}" target="_blank" rel="noopener noreferrer">${title}</a>`
        : `<span class="dv-domain-item dv-domain-item-plain">${title}</span>`;
      return `<li class="dv-domain-row">${line}<span class="dv-domain-meta">${escapeHtml(it.source)}${it.date ? ` · ${escapeHtml(it.date)}` : ""}</span></li>`;
    }).join("");
    domainPanels.push(`<div class="dv-domain-panel" id="${panelId}" role="tabpanel" aria-labelledby="${tabId}"${on ? "" : " hidden"}>
      <div class="dv-domain-panel-head">${escapeHtml(d.name)} · 当日 ${c.total} 条${c.high ? ` · 含重点 ${c.high}` : ""}${c.total > 12 ? "（前 12 条）" : ""}</div>
      <ul class="dv-domain-list">${detail}</ul>
    </div>`);
  }
  const domainsSection = visibleDomains.length ? `<section class="dv-mod" id="dv-domains">
  <div class="dv-mod-head"><h2>六大经营领域</h2><span class="dv-mod-sub">按领域浏览 · 只列当日有内容的领域 · <a class="dv-mod-link" href="../domains.html">看跨期领域专题 →</a></span></div>
  <div class="dv-tabs" role="tablist" aria-label="六大经营领域">${domainTabs.join("")}</div>
  ${domainPanels.join("")}
  ${backToTop()}
</section>` : "";

  // ---- ⑧ 原有专业内容入口（全部复用现成链接，不建死链）----
  // 🔴 只放**独立页面**入口（sc 2026-11-28 实测踩坑）：此前混进了 `#dv-mustread` /
  // `#dv-opportunity` 两个页内锚点，读者在页面底部点「股市与必读」会被弹回页面上方，
  // 看起来像「链接没链对」。页内跳转已有顶部快捷导航，这里不再重复。
  const legacyItems = [
    { href: "../topics.html", label: "主题追踪", desc: "跨日事件连续性" },
    // 二期 WP9：跨期命中聚合。首页模块低频（年度重点 ≥M2 的期次约 5/30 天），
    // 这里是那 25 天里能进专题页的固定入口。
    { href: "../focus.html", label: "经营重点追踪", desc: "重点命中与热度" },
    { href: "../domains.html", label: "经营领域专题", desc: "六大领域跨期聚合" },
    { href: "../research.html", label: "研报解读", desc: "同业深度分析" },
    { href: "../redchip/index.html", label: "红筹线索", desc: "特色信息入口" },
    { href: "../search.html", label: "资讯搜索", desc: "按标题与主题检索" },
    { href: "../archive.html", label: "历史归档", desc: "按日期查阅" },
  ];
  const legacySection = `<section class="dv-mod" id="dv-legacy">
  <div class="dv-mod-head"><h2>专业内容与深度阅读</h2><span class="dv-mod-sub">独立页面与完整视图 · 点击进入对应板块</span></div>
  <div class="dv-deep-entry">
    <button type="button" class="dv-deep-btn" data-open-classic data-scroll="role-bar">
      <span>完整资讯视图</span>
      <small>五大分类 · 五大角色视图 · 全部原文</small>
    </button>
  </div>
  <nav class="dv-legacy">${legacyItems.map((i) => `<a class="dv-legacy-item" href="${i.href}"><span class="dv-legacy-label">${escapeHtml(i.label)}</span><span class="dv-legacy-desc">${escapeHtml(i.desc)}</span></a>`).join("")}</nav>
  ${backToTop()}
</section>`;

  return `<section class="dv-root" id="view-decision" aria-label="零售经营决策情报">
  <header class="dv-masthead">
    <div class="dv-eyebrow">零售经营决策情报 · 30 秒总览 + 3 分钟重点</div>
    <h1>重点经营情报</h1>
    <p class="dv-date-line">${stats}</p>
    <details class="dv-disclaimer"><summary>AI 研判说明</summary><p>事实来自公开资讯；「核心判断 / 经营影响 / 关注点」为 AI 基于公开信息的分析。管理关注为审慎建议，非已作决定，不构成经营决策或投资建议。</p></details>
    <nav class="dv-quicknav" id="dv-top" aria-label="模块快捷跳转">
      <span class="dv-quicknav-label">快捷跳转</span>
      ${navItems.map((m) => `<a href="#${m.id}">${escapeHtml(m.label)}</a>`).join("")}
    </nav>
  </header>

  ${coreSection}
  ${keySection}
  ${attnTopSection}
  ${prioritySection}
  ${stockSection}
  ${opportunity}
  ${risk}
  ${focusSection}
  ${domainsSection}
  ${legacySection}

  <button type="button" class="dv-float-top" id="dv-float-top" aria-label="返回顶部导航" title="返回顶部导航">↑<span>顶部</span></button>
</section>`;
}

/** 视角切换开关（挂在旧版 role-bar 之上、报头之前）。**默认旧版资讯**，新版手动切换。 */
export function renderViewSwitch(): string {
  return `<div class="view-switch" id="view-switch" role="group" aria-label="版本视角切换">
  <span class="view-switch-label">视角</span>
  <button type="button" class="view-switch-btn active" data-view="classic" aria-pressed="true">原版资讯</button>
  <button type="button" class="view-switch-btn" data-view="decision" aria-pressed="false">经营情报（新）</button>
  <span class="view-switch-hint" id="view-switch-hint">当前：原版资讯视角（可手动切到新版经营情报，偏好本机保存）</span>
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
  .dv-masthead { padding:0.8rem 0.9rem; margin:0 0 0.8rem; border:1px solid var(--rule);
    border-left:4px solid var(--accent-brand); border-radius:var(--r-md); background:var(--bg-elevated); }
  .dv-eyebrow { font-size:0.72rem; letter-spacing:0.04em; color:var(--muted); }
  .dv-masthead h1 { margin:0.2rem 0 0.35rem; font-size:1.25rem; font-weight:600; }
  .dv-date-line { margin:0; font-size:0.76rem; color:var(--fg-soft); font-variant-numeric:tabular-nums; line-height:1.55; }
  .dv-disclaimer { margin:0.4rem 0 0; font-size:0.72rem; color:var(--muted); line-height:1.5; }
  .dv-disclaimer summary { color:var(--link); cursor:pointer; }
  .dv-disclaimer p { margin:0.3rem 0 0; }
  /* 首屏减高：快捷跳转单行横滑，不换行、不显示滚动条 */
  .dv-quicknav { display:flex; flex-wrap:nowrap; align-items:center; gap:0.3rem; margin:0.5rem 0 0;
    overflow-x:auto; overscroll-behavior-x:contain; -webkit-overflow-scrolling:touch;
    scrollbar-width:none; -ms-overflow-style:none; }
  .dv-quicknav::-webkit-scrollbar { display:none; }
  .dv-quicknav-label { flex:0 0 auto; font-size:0.7rem; color:var(--muted); margin-right:0.1rem; }
  .dv-quicknav a { flex:0 0 auto; display:inline-flex; align-items:center; min-height:28px; padding:0.1rem 0.48rem;
    font-size:0.72rem; text-decoration:none; color:var(--fg-soft); background:var(--card);
    border:1px solid var(--rule); border-radius:999px; white-space:nowrap; }
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
  /* 横滑：移动端左右滑（隐藏滚动条 + 右缘渐隐示意还有内容），桌面转等宽网格。
     2026-11-28 sc：卡片按各自内容自然收口 —— 一条长稿不得把同排其余卡片拉到同样高、
     底部留一大片空白（老版招行风 brief 卡片就是各卡独立高度）。 */
  .dv-scroller { display:flex; flex-direction:row; align-items:flex-start; gap:0.7rem;
    overflow-x:auto; -webkit-overflow-scrolling:touch; overscroll-behavior-x:contain;
    scroll-snap-type:x proximity; scrollbar-width:none; -ms-overflow-style:none;
    padding:0.2rem 0.15rem 0.5rem; }
  .dv-scroller::-webkit-scrollbar { display:none; }
  /* 右缘渐隐只吃掉最后 14px，保留下一张卡左侧边线可见，提示还能滑。 */
  .dv-scroller.has-more:not(.at-end) {
    -webkit-mask-image:linear-gradient(to right,#000 calc(100% - 14px),transparent 100%);
    mask-image:linear-gradient(to right,#000 calc(100% - 14px),transparent 100%);
    box-shadow:inset -18px 0 18px -18px rgba(0,0,0,0.18); }
  /* 固定外框 + 固定内容（sc 2026-11-28 终版）：各板块按自身文本长度定尺寸，
     不再内滚，只做限行截断；外层横滑是唯一滚动容器。超出部分点击卡片来源看原文。 */
  .dv-scroller > .dv-card { position:relative; flex:0 0 auto; margin:0;
    display:flex; flex-direction:column; box-sizing:border-box; overflow:hidden;
    scroll-snap-align:start; }
  /* 🔴 固定高度下 flex 子项默认会 shrink：内容超高时标题/正文会被压扁重叠。
     锁住每个直接子块的自然高度，超出部分交给卡片 overflow:hidden 裁掉。 */
  .dv-scroller > .dv-card > * { flex:0 0 auto; position:relative; z-index:1; }
  /* 整卡热区：盖住文字但不盖页脚/来源等真实链接；原生 a 不依赖 JS 弹窗。 */
  /* ⛔ 不用 inset:0：部分安卓 X5/旧 WebView 不支持，热区会塌成 0 高。 */
  .dv-scroller > .dv-card > .dv-card-hit { position:absolute; top:0; right:0; bottom:0; left:0;
    display:block; width:100%; height:100%; z-index:2; border-radius:inherit;
    -webkit-tap-highlight-color:transparent; }
  .dv-scroller > .dv-card a:not(.dv-card-hit) { position:relative; z-index:3; }
  /* 展开/收起：默认隐藏，内容溢出才由脚本显示；浮在卡底，不参与排版。 */
  .dv-scroller > .dv-card > .dv-expand { position:absolute; right:0.55rem; bottom:0.4rem; z-index:4;
    font:inherit; font-size:0.72rem; line-height:1.6; padding:0.08rem 0.5rem;
    border:1px solid var(--rule); border-radius:999px; background:var(--card);
    color:var(--accent-brand); box-shadow:var(--shadow-sm); cursor:pointer; }
  .dv-scroller > .dv-card.has-overflow .dv-card-foot,
  .dv-scroller > .dv-card.has-overflow .dv-tags { padding-right:3.1rem; }
  /* 展开态：解除固定高度与限行，卡片随内容长高（仍只有外层横滑一个滚动容器）。 */
  .dv-scroller > .dv-card.is-expanded { height:auto !important; overflow:visible; padding-bottom:2.1rem; }
  .dv-scroller > .dv-card.is-expanded .dv-card-title,
  .dv-scroller > .dv-card.is-expanded .dv-fact,
  .dv-scroller > .dv-card.is-expanded .dv-infer,
  .dv-scroller > .dv-card.is-expanded .dv-why {
    display:block !important; overflow:visible !important; -webkit-line-clamp:unset !important; }
  /* 近 8 期实测：必读 43~75 字、商机 47~63 字、风险 97~133 字、管理关注 ~78 字。 */
  /* 实测截图校正：按「内容占七成、留白可控」收紧高度；超长内容点卡片看原文。 */
  /* 82vw 让右缘多露 10px 下一张卡边线，配 14px 渐隐刚好提示可滑。 */
  #dv-mustread .dv-scroller > .dv-card { width:min(82vw,332px); height:235px; }
  #dv-opportunity .dv-scroller > .dv-card { width:min(80vw,320px); height:200px; }
  #dv-risk .dv-scroller > .dv-card { width:min(88vw,360px); height:270px; }
  #dv-attention .dv-scroller > .dv-card { width:min(88vw,360px); height:245px; }
  /* 必读卡信息最密：标签压成单行、事实/研判各限 2 行，保证标题与来源不被裁。 */
  #dv-mustread .dv-card .dv-chips { flex-wrap:nowrap; overflow:hidden; }
  #dv-mustread .dv-card .dv-chip { flex:0 0 auto; white-space:nowrap; }
  /* 5 个标签在 296px 内放不下：证据/发布日期让位给 领域/等级/续报，详情页仍可看。 */
  #dv-mustread .dv-card .dv-chip-evidence,
  #dv-mustread .dv-card .dv-chip-date { display:none; }
  #dv-mustread .dv-card .dv-fact,
  #dv-mustread .dv-card .dv-infer { -webkit-line-clamp:2; }
  #dv-mustread .dv-card .dv-why { -webkit-line-clamp:2; }
  .dv-scroller > .dv-card[data-href] { cursor:pointer; }
  /* 来源紧跟正文；短卡多余留白落在卡底，不在正文与来源之间挖一个大洞。 */
  .dv-scroller > .dv-card .dv-card-foot { margin-top:0.65rem; padding-top:0; }
  .dv-swipe-hint { margin:0.1rem 0 0; font-size:0.72rem; color:var(--muted); }
  @media (min-width:720px) {
    .dv-scroller { display:grid; grid-template-columns:repeat(auto-fit,minmax(250px,1fr));
      gap:0.7rem; overflow:visible; padding:0; scroll-snap-type:none;
      -webkit-mask-image:none; mask-image:none; }
    #dv-mustread .dv-scroller > .dv-card,
    #dv-opportunity .dv-scroller > .dv-card,
    #dv-risk .dv-scroller > .dv-card,
    #dv-attention .dv-scroller > .dv-card { width:auto; max-width:none; scroll-snap-align:none; }
    .dv-swipe-hint { display:none; }
  }
  /* 招行风：白卡 + 细边 + 12px 圆角 + --shadow-sm（与老版 .brief 同口径）。 */
  .dv-card { padding:0.8rem 0.95rem; margin:0 0 0.7rem; border:1px solid var(--rule);
    border-radius:12px; background:var(--card); box-shadow:var(--shadow-sm); }
  .dv-card-title { margin:0 0 0.45rem; font-size:0.98rem; font-weight:600; line-height:1.5;
    display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
  .dv-chips { display:flex; flex-wrap:wrap; gap:0.35rem; margin:0 0 0.5rem; }
  .dv-chip { font-size:0.72rem; padding:0.1rem 0.45rem; border-radius:999px;
    background:var(--card-alt); color:var(--fg-soft); }
  .dv-chip-grade { background:var(--rank-mid-bg); color:var(--rank-mid-fg); }
  .dv-chip-domain { background:var(--card-alt); color:var(--accent-brand); }
  .dv-chip-delta { outline:1px solid var(--rank-mid-fg); }
  .dv-chip-risk { background:var(--rank-high-bg); color:var(--rank-high-fg); }
  .dv-fact, .dv-infer, .dv-why { margin:0.35rem 0; font-size:0.86rem; line-height:1.62;
    display:-webkit-box; -webkit-line-clamp:4; -webkit-box-orient:vertical; overflow:hidden; }
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
  .dv-deep-entry { margin:0 0 0.65rem; }
  .dv-deep-btn { width:100%; display:flex; flex-direction:column; align-items:flex-start; gap:0.15rem;
    padding:0.7rem 0.8rem; border:1px solid var(--accent-brand); border-radius:var(--r-md);
    background:var(--card); color:var(--fg); font:inherit; text-align:left; cursor:pointer; }
  .dv-deep-btn span { font-size:0.9rem; font-weight:600; color:var(--accent-brand); }
  .dv-deep-btn small { font-size:0.72rem; color:var(--muted); }
  /* 商机洞察内的 IPO 线索行（2026-11-28）：不占独立模块，只做「可跟进企业」速览 */
  .dv-ipo-leads { margin:0.7rem 0 0; padding:0.6rem 0.7rem; border:1px solid var(--rule);
    border-left:3px solid var(--c-ipo); border-radius:var(--r-md); background:var(--card); }
  .dv-ipo-leads-head { margin:0 0 0.4rem; font-size:0.86rem; font-weight:600; display:flex; flex-wrap:wrap;
    align-items:baseline; gap:0.4rem; }
  .dv-ipo-leads-sub { font-size:0.7rem; font-weight:400; color:var(--muted); }
  .dv-ipo-leads-list { margin:0; padding:0; list-style:none; display:flex; flex-wrap:wrap; gap:0.3rem 0.9rem; }
  .dv-ipo-lead { font-size:0.82rem; }
  .dv-ipo-lead a { color:inherit; text-decoration:none; border-bottom:1px solid var(--rule); }
  .dv-ipo-lead-stage { margin-left:0.35rem; font-size:0.68rem; color:var(--muted);
    border:1px solid var(--rule); border-radius:999px; padding:0 0.35rem; white-space:nowrap; }
  .dv-ipo-leads-more { margin:0.45rem 0 0; font-size:0.7rem; color:var(--muted); }
  .dv-mod-link { color:var(--accent-brand); text-decoration:none; border-bottom:1px dashed currentColor; }
  .dv-mod-link:active { opacity:.7; }
  .dv-mod:target .dv-mod-head { border-bottom-color:var(--accent-brand); }
  /* ---- 第一层：30 秒总览 ---- */
  .dv-core { margin:0 0 1rem; padding:0.95rem 1rem; border:1px solid var(--rule);
    border-left:4px solid var(--accent-brand); border-radius:var(--r-md);
    background:linear-gradient(180deg, var(--bg-elevated), var(--card)); }
  .dv-core-eyebrow { margin:0 0 0.35rem; font-size:0.72rem; letter-spacing:0.06em; color:var(--accent-brand); }
  .dv-core-text { margin:0; font-size:1.02rem; line-height:1.8; font-weight:500; color:var(--fg); }
  .dv-core-meta { margin:0.55rem 0 0; font-size:0.72rem; color:var(--muted); line-height:1.6; }
  .dv-core-meta a { color:var(--link); }
  .dv-changes { list-style:none; margin:0; padding:0; display:grid; gap:0.55rem; }
  .dv-change { display:block; padding:0.7rem 0.8rem; border:1px solid var(--rule); border-radius:var(--r-md);
    background:var(--card); color:inherit; text-decoration:none; }
  .dv-change:active { background:var(--card-alt); }
  .dv-change-more { display:block; margin-top:0.3rem; font-size:0.7rem; color:var(--link); }
  /* 第三层去重后的关联引用条：不再重复整卡 */
  .dv-ref { flex:0 0 auto; width:min(82vw,332px); padding:0.7rem 0.8rem; border:1px dashed var(--rule);
    border-radius:var(--r-md); background:var(--bg); }
  .dv-ref-link { display:block; font-size:0.84rem; font-weight:600; color:var(--accent-brand); text-decoration:none; }
  .dv-ref-title { display:block; margin-top:0.25rem; font-size:0.78rem; line-height:1.5; color:var(--fg-soft); }
  .dv-change-head { display:flex; align-items:flex-start; gap:0.45rem; }
  .dv-change-n { flex:0 0 auto; font-size:0.78rem; font-weight:700; color:var(--accent-brand);
    font-variant-numeric:tabular-nums; line-height:1.5; }
  .dv-change h3 { margin:0; font-size:0.94rem; line-height:1.5; font-weight:600; }
  .dv-change-line { margin:0.35rem 0 0.4rem; font-size:0.84rem; line-height:1.6; color:var(--fg-soft); }
  .dv-attn-top { padding:0.8rem 0.9rem; border:1px solid var(--rule); border-left:3px solid var(--c-finance);
    border-radius:var(--r-md); background:var(--card); }
  .dv-attn-top h3 { margin:0 0 0.35rem; font-size:0.96rem; line-height:1.55; font-weight:600; }
  .dv-attn-top > p { margin:0 0 0.45rem; font-size:0.86rem; line-height:1.7; color:var(--fg-soft); }
  .dv-attn-detail { margin:0.45rem 0; font-size:0.82rem; color:var(--fg-soft); }
  .dv-attn-detail summary { color:var(--link); cursor:pointer; }
  .dv-attn-detail p { margin:0.35rem 0 0; line-height:1.7; }
  /* ---- 第二层：3 分钟经营重点 ---- */
  .dv-priorities { display:grid; gap:0.8rem; }
  .dv-priority { position:relative; padding:0.85rem 0.95rem; border:1px solid var(--rule);
    border-left:3px solid var(--accent-brand); border-radius:var(--r-md); background:var(--card);
    scroll-margin-top:14px; }
  .dv-priority.is-flash { animation:dv-priority-flash 1.2s ease; }
  @keyframes dv-priority-flash {
    0%, 100% { box-shadow:0 0 0 0 rgba(0,0,0,0); border-color:var(--rule); }
    12%, 78% { box-shadow:0 0 0 3px var(--accent-brand); border-color:var(--accent-brand); }
  }
  .dv-priority-head { display:flex; align-items:flex-start; gap:0.45rem; }
  .dv-priority-n { flex:0 0 auto; min-width:1.3rem; font-size:0.9rem; font-weight:700;
    color:var(--accent-brand); font-variant-numeric:tabular-nums; line-height:1.5; }
  .dv-priority-head h3 { margin:0; font-size:1rem; line-height:1.55; font-weight:600; }
  .dv-priority-body { display:grid; gap:0.55rem; margin-top:0.55rem; }
  .dv-priority-part { padding-top:0.5rem; border-top:1px solid var(--rule); }
  .dv-priority-part b { display:block; margin-bottom:0.18rem; font-size:0.76rem; color:var(--accent-brand); }
  .dv-priority-part p { margin:0; font-size:0.86rem; line-height:1.72; color:var(--fg-soft); }
  .dv-risk-critical { color:#fff; background:#b42318; border-color:#b42318; font-weight:600; }
  /* ---- 第三层：股市紧凑纵向 ---- */
  .dv-stock-grid { display:grid; grid-template-columns:1fr; gap:0.65rem; }
  .dv-stock-card { padding:0.75rem 0.85rem; border:1px solid var(--rule); border-radius:var(--r-md);
    background:var(--card); }
  .dv-stock-card--a { border-left:3px solid var(--rank-high-fg); }
  .dv-stock-card--hk { border-left:3px solid var(--c-finance); }
  .dv-stock-card--us { border-left:3px solid var(--c-ipo); }
  .dv-stock-head { display:flex; align-items:baseline; justify-content:space-between; gap:0.5rem; }
  .dv-stock-head h3 { margin:0; font-size:0.9rem; font-weight:600; }
  .dv-stock-head span { font-size:0.7rem; color:var(--muted); }
  .dv-stock-line { margin:0.45rem 0 0; font-size:0.84rem; line-height:1.65; color:var(--fg-soft); }
  .dv-stock-sectors { margin-top:0.35rem; }
  .dv-stock-sec-label { font-size:0.7rem; color:var(--muted); }
  .dv-stock-sectors ul { margin:0.2rem 0 0; padding-left:1rem; font-size:0.8rem; line-height:1.6; color:var(--fg-soft); }
  .dv-stock-report { display:inline-block; margin-top:0.4rem; font-size:0.78rem; color:var(--link); }
  .dv-stock-meta { margin:0.35rem 0 0; font-size:0.68rem; color:var(--muted); }
  .dv-stock-note { margin:0 0 0.2rem; font-size:0.78rem; color:#c8842a; }
  @media (max-width:640px) {
    body.view-decision .view-switch-hint { display:none; }
    .dv-masthead { padding:0.55rem 0.72rem; margin-bottom:0.55rem; }
    .dv-eyebrow { font-size:0.64rem; }
    .dv-masthead h1 { margin:0.08rem 0 0.2rem; font-size:1.08rem; }
    .dv-date-line { font-size:0.69rem; line-height:1.4; }
    .dv-disclaimer { margin-top:0.22rem; font-size:0.66rem; line-height:1.35; }
    .dv-quicknav { margin-top:0.3rem; }
    .dv-core { padding:0.65rem 0.75rem; margin-bottom:0.55rem; }
    .dv-core-eyebrow { font-size:0.66rem; margin-bottom:0.15rem; }
    .dv-core-text { font-size:0.9rem; line-height:1.56; }
    .dv-core-meta { margin-top:0.26rem; font-size:0.64rem; line-height:1.35; }
    .dv-mod { margin:0 0 0.8rem; }
    .dv-mod-head { margin-bottom:0.4rem; padding-bottom:0.3rem; gap:0.25rem; }
    .dv-mod-head h2 { font-size:0.98rem; }
    .dv-mod-sub { font-size:0.68rem; }
    .dv-change { padding:0.45rem 0.58rem; }
    .dv-change h3 { font-size:0.87rem; line-height:1.4; }
    .dv-change-line { margin:0.16rem 0 0.2rem; font-size:0.77rem; line-height:1.4; }
    .dv-change-more { display:none; }
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
  // 20:52 口径：旧版默认、新版手动切换；偏好键再升版，清除旧 decision 偏好。
  var KEY='gz_view_v3';
  var body=document.body;
  var btns=document.querySelectorAll('.view-switch-btn');
  var hint=document.getElementById('view-switch-hint');
  function apply(view){
    var v=(view==='classic')?'classic':'decision';
    body.classList.toggle('view-classic',v==='classic');
    body.classList.toggle('view-decision',v==='decision');
    btns.forEach(function(b){
      var on=b.getAttribute('data-view')===v;
      b.classList.toggle('active',on);
      b.setAttribute('aria-pressed',on?'true':'false');
    });
    if(hint) hint.textContent=v==='classic'
      ? '当前：原版资讯视角（可手动切到新版经营情报，偏好本机保存）'
      : '当前：新版经营情报视角（可切回原版资讯，偏好本机保存）';
    try{localStorage.setItem(KEY,v);}catch(e){}
  }
  // sc 2026-11-28 19:25：新版移动端体验不可用 → 默认回旧版，决策视角保留可切换。
  var saved='classic';
  try{saved=localStorage.getItem(KEY)||'classic';}catch(e){}
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
    // 第一层变化 / 第三层关联引用 → 目标经营重点卡 1.2s 边框高亮
    if(a.classList.contains('dv-change')||a.classList.contains('dv-ref-link')){
      t.classList.remove('is-flash');
      void t.offsetWidth;
      t.classList.add('is-flash');
      setTimeout(function(){t.classList.remove('is-flash');},1250);
    }
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

  // 卡片内容固定不滚动 → 无需方向锁脚本；整卡可点开原文（链接子元素仍优先）。
  if(root) root.addEventListener('click',function(e){
    if(e.target&&e.target.closest&&(e.target.closest('a')||e.target.closest('.dv-expand')))return;
    var card=e.target&&e.target.closest?e.target.closest('.dv-scroller > .dv-card[data-href]'):null;
    if(!card)return;
    var href=card.getAttribute('data-href');
    if(!href)return;
    if(href.slice(0,7)==='http://'||href.slice(0,8)==='https://') window.open(href,'_blank','noopener');
    else window.location.href=href;
  });

  // 第三层「完整资讯视图」：切到旧版后滚到角色/分类区（A 方案，不复制 DOM）。
  if(root) root.addEventListener('click',function(e){
    var b=e.target&&e.target.closest?e.target.closest('[data-open-classic]'):null;
    if(!b)return;
    e.preventDefault();
    var sw=document.querySelector('.view-switch-btn[data-view="classic"]');
    if(sw) sw.click();
    var id=b.getAttribute('data-scroll');
    if(id) setTimeout(function(){
      var t=document.getElementById(id);
      if(t&&t.scrollIntoView) t.scrollIntoView({behavior:'smooth',block:'start'});
    },80);
  });

  // 内容溢出才显示「展开」；展开后解除限行与固定高度，再点收起。
  var cards=root?root.querySelectorAll('.dv-scroller > .dv-card'):[];
  cards.forEach(function(card){
    var btn=card.querySelector('.dv-expand');
    if(!btn)return;
    function refresh(){
      if(card.classList.contains('is-expanded'))return;
      var over=card.scrollHeight>card.clientHeight+2;
      card.classList.toggle('has-overflow',over);
      btn.hidden=!over;
    }
    refresh();
    btn.addEventListener('click',function(e){
      e.preventDefault();
      e.stopPropagation();
      var open=!card.classList.contains('is-expanded');
      card.classList.toggle('is-expanded',open);
      btn.textContent=open?'收起':'展开';
      btn.setAttribute('aria-expanded',open?'true':'false');
    });
  });

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
