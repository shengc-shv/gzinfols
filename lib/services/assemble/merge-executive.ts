/**
 * 执行摘要回填（自 gzinfo lib/output/render.ts mergeStoredExecutive 移植）。
 *
 * 把 store 的 ExecutiveSummary（AI/SKIP_AI 双模式产物）适配为 report schema：
 * - must_read：url 缺失时按标题在 report.sections 回匹配（前缀包含 + Dice≥0.4），
 *   仍无则丢弃（宁缺毋滥，避免空链接卡片）；why 保留
 * - insights：tag[] → tags[]，topic/impact/action 照搬；sources 原样透传（生成时已回链）
 * - M 层风险回填（SKIP_AI 复用 store 路径必走）；evidence/impact/action 任一违禁 → 整条丢弃
 * - 违禁词过滤：命中 BANNED_WORDS 的 must_read/insights 丢弃（P0 合规，
 *   store 里「加密资产疯涨」这类旧产物不回流）
 */

import type { DailyReport, ReportInsight, ReportItem, ReportMustRead } from "../../contracts/report";
import { BANNED_WORDS, SECTIONS } from "../enrich/validator";
import { titleSimilarityDice } from "../select/filters/dedup-similar";

/** 商机洞察来源回链在 AI 生成阶段完成（executive-summary.resolveInsightSources）；本函数仅透传。 */
export function mergeStoredExecutive(
  report: DailyReport,
  exec: {
    hero_line?: string;
    must_read: Array<{ title: string; why: string; url?: string }>;
    insights: Array<{
      topic: string;
      impact: string;
      action: string;
      tag?: string[];
      segments?: string[];
      sources?: Array<{ title: string; url: string }>;
    }>;
    // M 层：风险（M 阶段 SKIP_AI 复用 store 时透传）
    risk?: {
      topic: string;
      evidence: string;
      impact: string;
      action: string;
      url?: string;
      source?: "T1" | "T1.5" | "T2";
      sources?: Array<{ title: string; url: string }>;
    };
  },
): DailyReport {
  const banned = new Set(BANNED_WORDS);
  const bannedIn = (s: string): boolean => banned.has(s) || BANNED_WORDS.some((w) => s.includes(w));

  // 标题 → url 回匹配：先宽松前缀包含（store 标题常是 sections 标题的精简版，
  // 如「8月LPR不变，房贷或续降」⊂「8月LPR保持不变，今年房贷还能否下调？」），
  // 再 Dice≥0.4 兜底（措辞改写宽容）。
  // 不可变：复制入参，全程只改 out，最后返回 out（不污染调用方的 report）
  const out: DailyReport = { ...report };
  const allItems: ReportItem[] = SECTIONS.flatMap((s) => report.sections[s] ?? []);
  const matchUrl = (title: string): string | undefined => {
    if (!title) return undefined;
    const norm = (s: string): string => s.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
    const nt = norm(title);
    if (!nt) return undefined;
    let best: { url: string; score: number } | undefined;
    for (const it of allItems) {
      const t = it.title_cn || it.title_orig || "";
      if (!t) continue;
      const nti = norm(t);
      if (nti.includes(nt) || nt.includes(nti)) return it.url; // 包含关系直接命中
      const score = titleSimilarityDice(title, t);
      if (score >= 0.4 && (!best || score > best.score)) best = { url: it.url, score };
    }
    return best?.url;
  };

  // must_read 回填（保留 url 显式携带的，其余按标题回匹配，无匹配丢弃）
  const must: ReportMustRead[] = [];
  for (const m of exec.must_read ?? []) {
    if (!m || !m.why || bannedIn(`${m.title} ${m.why}`)) continue;
    const url = m.url || matchUrl(m.title);
    if (!url) continue; // 无法定位到报告内条目 → 丢弃（宁缺毋滥）
    must.push({ url, why: m.why, ...(m.title ? { title: m.title } : {}) });
  }
  if (must.length > 0) out.must_read = must;

  // insights 回填（tag[] → tags[]，违禁过滤；sources：store 已含（生成时回链），原样透传）
  const insights: ReportInsight[] = [];
  for (const it of exec.insights ?? []) {
    if (!it || !it.topic || bannedIn(JSON.stringify(it))) continue;
    const sources =
      Array.isArray(it.sources) && it.sources.length > 0
        ? it.sources.slice(0, 3).filter((s) => s && s.url).map((s) => ({ title: s.title || "", url: s.url }))
        : [];
    insights.push({
      topic: it.topic,
      tags: Array.isArray(it.tag) ? it.tag.slice(0, 6) : [],
      impact: it.impact || "",
      action: it.action || "",
      ...(Array.isArray(it.segments) && it.segments.length ? { segments: it.segments } : {}),
      ...(sources.length > 0 ? { sources } : {}),
    });
  }
  if (insights.length > 0) out.insights = insights;

  // M 层：风险回填（store.json 复用路径，SKIP_AI 必走此处）。evidence/impact/action 任一违禁 → 整条丢弃。
  if (exec.risk && exec.risk.topic) {
    const r = exec.risk;
    const corpus = `${r.topic} ${r.evidence} ${r.impact} ${r.action}`;
    if (!bannedIn(corpus)) {
      const sources =
        Array.isArray(r.sources) && r.sources.length > 0
          ? r.sources.slice(0, 3).filter((s) => s && s.url).map((s) => ({ title: s.title || "", url: s.url }))
          : [];
      out.risk = {
        topic: r.topic,
        evidence: r.evidence || "",
        impact: r.impact || "",
        action: r.action || "",
        ...(r.url ? { url: r.url } : {}),
        ...(r.source ? { source: r.source } : {}),
        ...(sources.length > 0 ? { sources } : {}),
      };
    }
  }

  // hero_line 回填：SKIP_AI 的弱兜底非空但无定调价值 → 视为缺省，用 store 的 hero_line
  //（真实 AI 当日定调）或回填成功的 must_read 首条生成「今日关注：xxx」覆盖（gzinfo 2026-08-21 用户反馈）。
  // 弱兜底两种形态：pipeline.ts 的「今日更新 N 条资讯：<PASS2首条>」+ degrade ⑦ 的
  // HERO_FALLBACK「今日暂无可推送重点」（SKIP_AI 下 PASS2 必读为空触发 R12 → 降级）。
  const heroIsWeakFallback =
    !report.hero_line ||
    /^今日更新\s*\d+\s*条资讯/.test(report.hero_line) ||
    /今日暂无可推送重点/.test(report.hero_line);
  if (heroIsWeakFallback) {
    if (exec.hero_line) {
      out.hero_line = exec.hero_line;
    } else if (must.length > 0) {
      const it = allItems.find((x) => x.url === must[0].url);
      if (it) out.hero_line = `今日关注：${it.title_cn || it.title_orig || ""}`.slice(0, 70);
    }
  }
  return out;
}
