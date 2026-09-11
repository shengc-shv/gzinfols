/**
 * 近 7 天历史滚动并入报告（自 gzinfo lib/output/render.ts mergeRollingIntoReport 移植）。
 *
 * 三态门槛（gzinfo 2026-08-29 方案③ / D-008，放宽覆盖但守业务相关性）：
 *  1. relevant===true → 无条件并入；
 *  2. relevant===false → 排除（AI 明确判无关，始终是硬门槛）；
 *  3. 未打标 → 需过「分行相关性」门槛（scoreBranchRelevance tier!=="drop"）才并入。
 * 背景：历史库 96% 未打标，裸放行会把个股财报/外文股市噪声灌满板块，
 * 违反「宁缺毋滥」与业务相关性红线。
 */

import type { ArticleInput } from "../../contracts/article";
import type { DailyReport, ReportItem, ReportSectionKey } from "../../contracts/report";
import type { SourceTier } from "../../contracts/source";
import {
  isGzLocalCandidate,
  isPolicyMarketCandidate,
  isGdIpoCandidate,
  IPO_CAPITAL_ACT_RE,
  IPO_FLOW_RE,
  FOREIGN_REGION_RE,
} from "../enrich/heuristics";
import { scoreBranchRelevance } from "../select/filters/relevance-score";
import { rollUpTags } from "../enrich/tag-rollup";
import { todayKey } from "../../utils/time";
import { SECTIONS } from "../enrich/validator";

/** 摘要地域一致性兜底（gzinfo 2026-08-23 R3 扩展）：摘要声称「广东/广州…企业」的写法。 */
const GD_ENTERPRISE_RE =
  /(广东|广州)(省|市)?[一-鿿]{0,3}(企业|公司|科技|集团)/;

export function mergeRollingIntoReport(
  report: DailyReport,
  rolling: ArticleInput[],
  tierBySource: Map<string, SourceTier | undefined>,
): DailyReport {
  const sectionOf = (a: ArticleInput): ReportSectionKey | null => {
    const title = a.title_cn || a.title || "";
    // 无状态源架构红线（2026-08-29 用户）：最终板块归属一律由**内容判定**，
    // 数据源的 category/subcategory 只是采集元数据，不得决定渲染分类。
    // tech/ipo 是独立内容栏目（科技前沿/IPO 动态），按内容类别归栏，其余全走内容判定。
    if (a.category === "tech") return "tech";
    if (a.category === "ipo" || a.category === "gd-ipo") {
      // gzinfo 2026-08-23：已上市公司资本运作公告（定增/审核问询/购买资产/解禁等）
      // 不进 IPO 动态，与 PASS1/groupRaw 分流口径一致。
      if (
        IPO_CAPITAL_ACT_RE.test(`${title} ${a.excerpt || ""}`) &&
        !IPO_FLOW_RE.test(`${title} ${a.excerpt || ""}`)
      ) {
        return null;
      }
      return "ipo";
    }
    // gzinfo 2026-08-30：媒体源报道的广东企业 IPO 动态（注册生效/辅导备案/过会等，
    // 东财在审表状态滞后时由媒体报道补位）→ 内容判定归 IPO 动态板块。
    if (isGdIpoCandidate(title, a.excerpt || "")) return "ipo";
    // 广州本地：只看标题内容（广州锚 + 银行业务线），与采集分类无关——
    // 广州市政府批复（SOURCE_ROUTE 归 finance）标题含「广州」→ 进 gz_local。
    // 摘要里的「广州」是 AI 解读视角（「分行应跟踪广州房贷…」），不代表事件在广州。
    if (isGzLocalCandidate(title)) return "gz_local";
    // 政策与市场：内容判定（外地地名/政策动作/全国市场信号）→ 政策与市场；否则业务启示。
    if (isPolicyMarketCandidate(title, a.excerpt || "")) return "policy_market";
    return "biz_insight";
  };
  const seen = new Set<string>();
  for (const sec of SECTIONS) {
    for (const it of report.sections[sec] ?? []) {
      if (it.url) seen.add(it.url);
    }
  }
  const extra: Record<ReportSectionKey, ReportItem[]> = {
    gz_local: [],
    biz_insight: [],
    policy_market: [],
    tech: [],
    ipo: [],
  };
  const rankKey = new Map<string, number>(); // url → 发布时间戳，用于板块内排序
  for (const a of rolling) {
    if (!a.url || seen.has(a.url)) continue; // 今日已展示 → 跳过
    if (a.relevant === false) continue;
    if (a.relevant !== true) {
      const rel = scoreBranchRelevance({
        title: a.title_cn || a.title || "",
        category: a.category,
        subcategory: a.subcategory,
        sourceId: a.sourceId,
        summary: a.summary,
      });
      if (rel.tier === "drop") continue;
    }
    const sec = sectionOf(a);
    if (!sec) continue;
    const d = a.publishedAt ?? a.fetchedAt;
    // 卡片日期与窗口判定同口径（报告时区），避免 UTC 下跨日错位
    // （如北京时间 08-30 02:00 存为 08-29 18:00Z → UTC getDate 误显 08/29）。
    const mmdd = d ? todayKey(d).slice(5).replace("-", "/") : "";
    const tier = a.tier ?? tierBySource.get(a.sourceId);
    // gzinfo 2026-08-23：历史缓存摘要地域一致性兜底（R3 扩展）——标题无粤地名但摘要声称
    // 「广东/广州…企业」（如北交所全国公告被模板标成「广东企业」）→ 摘要疑误，
    // 降级用原文摘录，避免错误地域信息进报告。
    let summary = (a.summary || "").trim();
    if (
      summary &&
      GD_ENTERPRISE_RE.test(summary) &&
      !FOREIGN_REGION_RE.test(a.title_cn || a.title || "")
    ) {
      summary = (a.excerpt || "").slice(0, 90).trim();
    }
    if (!summary) summary = (a.excerpt || "").slice(0, 90).trim();
    if (!summary) continue; // 无摘要且无正文 → 跳过（避免空卡片）
    // 退化卡片守卫（gzinfo 2026-08-29）：有效摘要若与标题**实质相同** → 只是标题复读，跳过。
    // 比较前先剥离开头的【栏目/业务线】标签前缀：历史库里大量条目的 summary 是
    // 「【财富管理】+ 原标题」，若只做严格相等比较会被标签前缀绕过。
    const stripTagPrefix = (s: string) => s.replace(/^(\s*【[^】]*】\s*)+/, "").trim();
    const titleText = stripTagPrefix(a.title_cn || a.title || "");
    const summaryText = stripTagPrefix(summary);
    if (
      titleText &&
      (summaryText === titleText || summaryText === titleText.slice(0, 90))
    )
      continue;
    extra[sec].push({
      url: a.url,
      title_cn: a.title_cn || a.title || "",
      title_orig: a.title_cn ? a.title : undefined,
      source: a.source || "",
      source_type: tier === "T1" || tier === "T1.5" ? "official" : "media",
      tier,
      date: mmdd,
      summary,
      importance: 2,
      rank: 0,
      tags: rollUpTags(a),
      // 无状态源架构红线（2026-08-29 用户）：locale 由内容判定（广州锚），不依赖采集分类。
      locale: isGzLocalCandidate(a.title_cn || a.title || "") ? "gz" : "national",
    });
    rankKey.set(a.url, (a.publishedAt ?? a.fetchedAt)?.getTime() ?? 0);
    seen.add(a.url);
  }
  // 板块内历史条目按发布时间倒序追加（今日 AI 条目已在数组头部保持 rank）
  for (const sec of SECTIONS) {
    extra[sec].sort((x, y) => (rankKey.get(y.url!) ?? 0) - (rankKey.get(x.url!) ?? 0));
    report.sections[sec] = [...(report.sections[sec] ?? []), ...extra[sec]];
    // 重排 rank（今日条目已由 finalizeRanks 生成，历史追加后统一重编号）
    report.sections[sec].forEach((it, i) => (it.rank = i + 1));
  }
  return report;
}
