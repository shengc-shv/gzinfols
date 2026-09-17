/**
 * 执行摘要区块渲染（2026-09-14 C-1 Phase3 自 `render/full.ts` **纯搬移**，行为零变化）：
 * `resolveTitleMap`（must_read 回写标题）· `renderReportExec`（摘要主区块）·
 * `FOREIGN_REGION_RE`（广州本地严格过滤的外地地名锚）。
 *
 * 注意：`mergeStoredExecutive` **不在本文件** —— 它是业务规则，唯一实现在
 * `services/assemble/merge-executive.ts`（生产由 `side-exec-summary` 调用）；
 * 此前 `render/full.ts` 另有一份**仅格式不同的副本**，而测试 import 的是 render 那份
 * ——「测试测的不是生产代码」的第三例（同 `mergeRollingIntoReport`），已收敛。
 */
import type {
  DailyReport,
  ReportInsight,
  ReportItem,
  ReportSectionKey,
} from "../../contracts/report";
import { SECTIONS } from "../enrich/validator";
import { selectTopMustRead } from "../enrich/select-top";
import { OTHER_SEGMENT, PRIORITY_SEGMENTS } from "../classify/customer-segment";
import { STR } from "./i18n";
import { escapeHtml } from "./cards";
import { renderStockIndexBlock, renderStockRecap, renderGdIpoStrip } from "./stock-block";
import { tagClsOf, itemAnchorId } from "./atoms";
import { renderDeltaBadge } from "./delta-badge";
import { renderMaturityBadge, renderNextStep } from "./maturity-badge";
import type { ProductLineCoverage } from "../../contracts/report";

/** 构造 url → 中文标题 映射（供 must_read 回写标题）。 */
export function resolveTitleMap(report: DailyReport): Map<string, string> {
  const m = new Map<string, string>();
  const secs: ReportSectionKey[] = ["gz_local", "biz_insight", "policy_market", "tech", "ipo"];
  for (const s of secs) {
    for (const it of report.sections?.[s] ?? []) {
      if (it.url && it.title_cn) m.set(it.url, it.title_cn);
    }
  }
  return m;
}

/**
 * 顶部执行摘要：今日定调 + 今日必读 + 商机洞察（消费新 report 结构：
 * hero_line / must_read / insights）。must_read 仅含 url+why，按 url 回写标题。
 */
/**
 * A1a：今日必读**首屏**展示条数，其余折叠（「展开其余 N 条」）。
 * 依据 PRD：读者在微信内置浏览器里首屏应只看到 Top3，避免摘要区过长挤掉下方板块。
 * 注意与音频侧的「三件事」（selectTopMustRead 取 3）口径一致，避免首屏与口播不符。
 */
const MUST_HEAD_COUNT = 3;

export function renderReportExec(report: DailyReport): string {
  const titleMap = resolveTitleMap(report);
  // N 层：选 top 3（音频核心）+ 数据化"三件事"标识
  const sourceItems: ReportItem[] = SECTIONS.flatMap((s) => report.sections[s] ?? []);
  /**
   * F2 摘要信息密度治理（2026-09-16 用户批准；同日按用户实测反馈修正）：
   * **不重复外链，但必须保留能真正跳转的溯源路径**。
   *
   * 实测（PRD §5.2 #2）：摘要层 7/9 行的源 URL 已在正文出现 → 独立信息密度仅 22%。
   * 处置口径：
   *   · 必读条目已在正文 → 不再是外链，改为「见正文」**站内锚点**（点击跳到正文卡片）；
   *   · 洞察/风险的来源标记 ①②③：正文已收录 → 站内锚点；正文未收录 → 外链。
   *     ⚠️ **任一来源都不删除** —— 此前把「已在正文」的来源整条剔除，导致两张洞察卡片
   *     连一个溯源入口都没有（用户实测反馈），此错已修正。
   *   · 每个来源标记带条目日期（MM/DD）：陈旧来源（如两天前的 IPO）在 UI 上可见、可判断。
   */
  const bodyUrls = new Set(sourceItems.map((i) => i.url).filter(Boolean));
  const urlDate = new Map(sourceItems.map((i) => [i.url, i.date] as const));
  const dedup = { mustInBody: 0, mustTotal: 0, srcTotal: 0, srcAnchored: 0 };
  /** 来源标记：正文已收录 → 站内锚点；未收录 → 外链（两类都渲染）。 */
  const sourceMarks = (
    sources: Array<{ title?: string; url: string }> | undefined,
    markClass: string,
  ): string => {
    const list = (sources ?? []).filter((s) => s.url).slice(0, 3);
    if (list.length === 0) return "";
    dedup.srcTotal += list.length;
    const anchorCls = markClass.replace("-srcs", "-src");
    const marks = list
      .map((s, i) => {
        const inBody = bodyUrls.has(s.url);
        if (inBody) dedup.srcAnchored++;
        const d = urlDate.get(s.url);
        const hint = `${inBody ? "跳转正文" : "打开原文"}${d ? ` · ${d}` : ""}${s.title ? ` · ${s.title}` : ""}`;
        const glyph = ["①", "②", "③"][i];
        return inBody
          ? `<a class="${anchorCls} ${anchorCls}-inbody" href="#${itemAnchorId(s.url)}" title="${escapeHtml(hint)}" aria-label="${escapeHtml(hint)}">${glyph}</a>`
          : `<a class="${anchorCls}" href="${escapeHtml(s.url)}" target="_blank" rel="noopener" title="${escapeHtml(hint)}" aria-label="${escapeHtml(hint)}">${glyph}</a>`;
      })
      .join("");
    return ` <span class="${markClass}">${marks}</span>`;
  };
  const { top: topMust, rationale: topRationale } = selectTopMustRead(
    report.must_read,
    sourceItems,
  );
  const topMustUrls = new Set(topMust.map((m) => m.url));
  const must = report.must_read
    .map((m, i) => {
      const title = m.title || titleMap.get(m.url) || m.url;
      const body = `<strong>${escapeHtml(title)}</strong><span class="must-why">${escapeHtml(m.why)}</span>`;
      dedup.mustTotal++;
      const inBody = Boolean(m.url && bodyUrls.has(m.url));
      if (inBody) dedup.mustInBody++;
      // 已在正文的条目：不再给第二遍外链，改为「见正文」站内锚点（点击跳到正文卡片）
      const inner = m.url && !inBody
        ? `<a class="must-body must-link" href="${escapeHtml(m.url)}" target="_blank" rel="noopener">${body}</a>`
        : `<div class="must-body">${body}${
            inBody ? `<a class="must-inbody" href="#${itemAnchorId(m.url!)}">见正文</a>` : ""
          }</div>`;
      const isTop = m.url && topMustUrls.has(m.url);
      const topBadge = isTop ? `<span class="must-top-badge" title="今日三件事：行长音频重点">三件事</span>` : "";
      // A1a：首屏只留 Top3，其余按序下沉（折叠），避免摘要区过长挤掉下方板块
      const moreCls = i >= MUST_HEAD_COUNT ? " must-more" : "";
      const cls = (isTop ? "must-card must-top" : "must-card") + moreCls;
      return `<li class="${cls}" data-audio-section="must" ${isTop ? 'data-top-must="true"' : ""}><span class="must-index">${i + 1}</span>${inner}${topBadge}${renderDeltaBadge(m.delta)}</li>`;
    })
    .join("");
  const renderInsightCard = (it: ReportInsight): string => {
    const srcMarks = sourceMarks(it.sources, "insight-srcs");
    const segs = it.segments && it.segments.length ? it.segments : [OTHER_SEGMENT];
    // C1（2026-09-17）：客群标签**可点** —— 点一下即按该客群筛选下方板块并滚动过去。
    // 从 span 改成 button：此前只展示、没有入口，AI 的客群打标成果读者用不上。
    const segChips = `<div class="insight-segs">${segs
      .map(
        (s) =>
          `<button type="button" class="seg-chip seg-${SEG_KEY[s] ?? "other"}" data-seg="${escapeHtml(s)}" title="按「${escapeHtml(SEG_SHORT[s] ?? s)}」筛选下方板块">${escapeHtml(SEG_SHORT[s] ?? s)}</button>`,
      )
      .join("")}</div>`;
    return `<article class="insight" data-audio-section="insight">
      ${(it.tags ?? []).length > 0
        ? `<div class="insight-tags">${(it.tags ?? [])
            .map((t) => `<span class="tag ${tagClsOf(t)}">${escapeHtml(t)}</span>`)
            .join("")}</div>`
        : ""}
      ${segChips}
      <h3>${escapeHtml(it.topic)}${renderDeltaBadge(it.delta)}${renderMaturityBadge(it.maturity)}${srcMarks}</h3>
      ${it.impact ? `<p><b>影响：</b>${escapeHtml(it.impact)}</p>` : ""}
      ${it.action ? `<p><b>建议：</b>${escapeHtml(it.action)}</p>` : ""}
      ${renderNextStep(it.maturity)}
    </article>`;
  };
  // 商机洞察：单板块（恢复原始模式），客户客群标签打在具体信息卡片上；
  // 每标签最多出现 2 条（其他业务线最多 1 条），多标签按其优先级归口、各标签配额独立计数（互不挤占）。
  const SEG_LIST = PRIORITY_SEGMENTS as readonly string[];
  const SEG_SHORT: Record<string, string> = {
    "零售AUM": "零售AUM",
    "中高端客群(过亿资产)": "高端客户",
    "普惠小微贷款客户": "普惠小微",
    [OTHER_SEGMENT]: "其他业务线",
  };
  const SEG_KEY: Record<string, string> = {
    "零售AUM": "aum",
    "中高端客群(过亿资产)": "private",
    "普惠小微贷款客户": "inclusive",
    [OTHER_SEGMENT]: "other",
  };
  const SEG_CAP: Record<string, number> = {
    "零售AUM": 2,
    "中高端客群(过亿资产)": 2,
    "普惠小微贷款客户": 2,
    [OTHER_SEGMENT]: 1,
  };
  const primaryOf = (it: ReportInsight): string => {
    let best: string | null = null;
    let bestIdx = Number.POSITIVE_INFINITY;
    for (const s of it.segments ?? []) {
      const idx = SEG_LIST.indexOf(s);
      if (idx >= 0 && idx < bestIdx) {
        bestIdx = idx;
        best = s;
      }
    }
    return best ?? OTHER_SEGMENT;
  };
  // 配额选择：按优先级归口排序，逐条占用其所有标签的配额（各标签独立计数，互不挤占）
  const used: Record<string, number> = {};
  const selectedInsights: ReportInsight[] = [];
  const sortedForCap = [...(report.insights ?? [])].sort((a, b) => {
    const pa = SEG_LIST.indexOf(primaryOf(a));
    const pb = SEG_LIST.indexOf(primaryOf(b));
    return (pa < 0 ? SEG_LIST.length : pa) - (pb < 0 ? SEG_LIST.length : pb);
  });
  for (const it of sortedForCap) {
    const segs = it.segments && it.segments.length ? it.segments : [OTHER_SEGMENT];
    if (segs.every((s) => (used[s] ?? 0) < (SEG_CAP[s] ?? 1))) {
      segs.forEach((s) => (used[s] = (used[s] ?? 0) + 1));
      selectedInsights.push(it);
    }
  }
  const insightsHtml = selectedInsights.map(renderInsightCard).join("");
  // M 层：风险卡片（与 insights 同样的卡片样式；M 关键特征：红/警示色 + 部门影响拆解）
  const riskCard = (() => {
    const r = report.risk;
    if (!r) return "";
    const srcMarks = sourceMarks(r.sources, "risk-srcs");
    const sourceBadge = r.source
      ? `<span class="risk-source-badge risk-source-${r.source.toLowerCase()}">${r.source === "T1" ? "官方" : r.source === "T1.5" ? "准官方" : "媒体"}</span>`
      : "";
    const fbKey = (r.sources && r.sources[0]?.url) || r.url || `risk:${r.topic}`;
    return `<article class="risk-card" data-audio-section="risk">
        <div class="risk-header">⚠️ 风险预警${sourceBadge}${renderDeltaBadge(r.delta)}${srcMarks}</div>
        <h3>${escapeHtml(r.topic)}</h3>
        ${r.evidence ? `<p><b>依据：</b>${escapeHtml(r.evidence)}</p>` : ""}
        ${r.impact ? `<p><b>影响：</b>${escapeHtml(r.impact)}</p>` : ""}
        ${r.action ? `<p><b>建议：</b>${escapeHtml(r.action)}</p>` : ""}
      </article>`;
  })();
  /**
   * C4（2026-09-17）产品条线覆盖：按揭 / 信用卡 / 代发 三条线各有多少商机。
   *
   * 未命中**显式标「本期无」**而不是留白 —— 让读者（尤其零售信贷部）能区分
   * 「确实没有相关商机」与「系统漏打标」。数据由装配期算出（本层只读，零判定）。
   */
  function renderProductCoverage(cov?: ProductLineCoverage[]): string {
    if (!cov || cov.length === 0) return "";
    const chips = cov
      .map((c) =>
        c.count > 0
          ? `<span class="pc-chip pc-hit" title="${escapeHtml(c.examples.join("；"))}">${escapeHtml(c.line)} ${c.count}</span>`
          : `<span class="pc-chip pc-none" title="本期确无该条线相关商机（不凑数，也不代表系统漏采）">${escapeHtml(c.line)} 本期无</span>`,
      )
      .join("");
    return `<p class="product-coverage"><span class="pc-label">产品条线覆盖</span>${chips}</p>`;
  }

  // 可观测（F2 验收依据）：摘要去重结果逐次打印，PRD 指标「摘要与正文重复项 ≤20%」可据此核对
  if (dedup.mustTotal > 0 || dedup.srcTotal > 0) {
    console.info(
      `[render] 摘要去重（F2）：必读 ${dedup.mustTotal} 条中 ${dedup.mustInBody} 条已在正文（改为「见正文」站内锚点）；` +
        `来源标记 ${dedup.srcTotal} 个中 ${dedup.srcAnchored} 个转为站内锚点（不重复外链，均可溯源）`,
    );
  }
  return `<section class="exec-summary">
    <div class="exec-head">
      <h2 class="exec-title">执行摘要</h2>
      <span class="exec-sub">今日必读 · 商机洞察 · 风险预警（AI 生成）· 广东IPO（交易所/证监会官方源）</span>
    </div>
    ${must ? `<div class="exec-must"><h3 class="exec-col-title">📌 今日必读<span class="must-hint-inline" aria-hidden="true">← 左右滑动查看 →</span></h3><ul class="must-scroller">${must}</ul>${
      report.must_read.length > MUST_HEAD_COUNT
        ? `<button class="expand-btn" type="button">展开其余 ${report.must_read.length - MUST_HEAD_COUNT} 条</button>`
        : ""
    }</div>` : ""}
    ${insightsHtml ? `<div class="exec-insights"><h3 class="exec-col-title">💡 商机洞察<span class="insight-hint-inline" aria-hidden="true">← 左右滑动查看 →</span></h3><div class="insight-scroller">${insightsHtml}</div></div>` : ""}
    ${renderProductCoverage(report.productCoverage)}
    ${riskCard ? `<div class="exec-risk"><h3 class="exec-col-title">⚠️ 风险预警<span class="risk-hint-inline" aria-hidden="true">← 左右滑动查看 →</span></h3><div class="risk-scroller">${riskCard}</div></div>` : ""}
    ${renderGdIpoStrip(report.sections?.ipo ?? [], { section: "must" })}
  </section>`;
}

/**
 * 外地地名锚（广州本地严格过滤用）：标题命中任一外地省/市/地名 → 该条为全国/外地
 * 政策（上海/北京/深圳/江苏/浙江…），即使 category=gz 也不进 gz_local，归政策与市场。
 * 广州本地板块宁缺毋滥：领导冲着「广州」点进来，看到的必须是广州事件本身。
 */
export const FOREIGN_REGION_RE =
  /上海|北京|深圳|江苏|浙江|南京|苏州|杭州|宁波|成都|重庆|天津|武汉|长沙|合肥|青岛|济南|福州|厦门|昆明|西安|郑州|东莞|佛山|珠海|中山|惠州|汕头|湛江|茂名|肇庆|江门|清远|韶关|梅州|河源|阳江|揭阳|汕尾|潮州|云浮|广东/;
