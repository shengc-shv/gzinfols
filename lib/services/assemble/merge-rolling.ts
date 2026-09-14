/**
 * 近 7 天历史滚动并入报告（自 gzinfo lib/output/render.ts mergeRollingIntoReport 移植）。
 *
 * 三态门槛（gzinfo 2026-08-29 方案③ / D-008，放宽覆盖但守业务相关性）：
 *  1. relevant===true → 无条件并入；
 *  2. relevant===false → 排除（AI 明确判无关，始终是硬门槛）；
 *  3. 未打标 → 需过「分行相关性」门槛（scoreBranchRelevance tier!=="drop"）才并入。
 * 背景：历史库 96% 未打标，裸放行会把个股财报/外文股市噪声灌满板块，
 * 违反「宁缺毋滥」与业务相关性红线。
 *
 * 2026-09-14（P0-3 收敛）：本函数此前在 `services/render/full.ts` 另有一份**逐字副本**
 * （生产走本文件、测试走那份）——两份同时存在，改一处不生效，属「单一真源」失效的典型。
 * 现 render 侧副本已删除，本文件为**唯一实现**；`full.ts` 不再导出该函数。
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

/**
 * 滚动并入的逐闸门统计（2026-09-14 B-1 新增）。
 *
 * 背景：本函数有多道「宁缺毋滥」闸门，任何一道过严都会让主板块**静默变空**
 * （实测归档某期 114 条滚动池仅并入 1 条：**63 条卡在「摘要≠标题复读」守卫**上，
 *  因为历史库无 AI 摘要时 `excerpt` 回退成了标题 → summary 与 title 相同）。
 *
 * 处置口径（用户 2026-09-14 拍板）：**守卫不放宽**（信息密度原则），
 * 但必须把每条被丢弃的原因计数暴露给调用方打日志 —— 空板块不能再静默。
 */
export interface MergeRollingStats {
  /** 滚动池总数 */
  considered: number;
  /** 实际并入条数 */
  merged: number;
  /** 无 url */
  droppedNoUrl: number;
  /** 今日已展示（url 去重） */
  droppedSeen: number;
  /** AI 显式判无关（relevant === false） */
  droppedRelevantFalse: number;
  /** 未打标且相关性评分判 drop */
  droppedByScore: number;
  /** 内容判定无板块归属（或命中资本运作公告分流） */
  droppedNoSection: number;
  /** 无摘要可用 */
  droppedNoSummary: number;
  /** 「摘要 ≠ 标题复读」守卫 */
  droppedDegenerate: number;
}

/** 归零的滚动并入统计（调用方构造后传入本函数的 stats 参数）。 */
export function makeMergeRollingStats(): MergeRollingStats {
  return {
    considered: 0,
    merged: 0,
    droppedNoUrl: 0,
    droppedSeen: 0,
    droppedRelevantFalse: 0,
    droppedByScore: 0,
    droppedNoSection: 0,
    droppedNoSummary: 0,
    droppedDegenerate: 0,
  };
}

export function mergeRollingIntoReport(
  report: DailyReport,
  rolling: ArticleInput[],
  tierBySource: Map<string, SourceTier | undefined>,
  stats?: MergeRollingStats,
): DailyReport {
  const bump = (k: keyof MergeRollingStats): void => {
    if (stats) stats[k] += 1;
  };
  const sectionOf = (a: ArticleInput): ReportSectionKey | null => {
    const title = a.title_cn || a.title || "";
    // 无状态源架构红线（2026-08-29 用户）：最终板块归属一律由**内容判定**，
    // 数据源的 category/subcategory 只是采集元数据，不得决定渲染分类。
    // tech/ipo 是独立内容栏目（科技前沿/IPO 动态），按内容类别归栏，其余全走内容判定。
    if (a.category === "tech") return "tech";
    // IPO：结构化 IPO 记录（爬虫透传 ipoStage/gdBasis）+ 结构化发出源类目
    // （category ∈ {ipo, gd-ipo} 仅允许给结构化 IPO 采集源使用——不变量由
    //  tests/source-category-invariant.test.ts 机械校验；通用 RSS 配成这两类会绕过
    //  内容判定直通本板块，2026-09-14 crunchbase 事故即此）。
    // 历史库不保留 ipoStage/gdBasis，故滚动并入的条目仍主要靠 category 识别。
    if (
      a.category === "ipo" ||
      a.category === "gd-ipo" ||
      a.ipoStage ||
      a.gdBasis
    ) {
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
  if (stats) stats.considered = rolling.length;
  for (const a of rolling) {
    if (!a.url) {
      bump("droppedNoUrl");
      continue;
    }
    if (seen.has(a.url)) {
      bump("droppedSeen"); // 今日已展示 → 跳过
      continue;
    }
    if (a.relevant === false) {
      bump("droppedRelevantFalse");
      continue;
    }
    if (a.relevant !== true) {
      const rel = scoreBranchRelevance({
        title: a.title_cn || a.title || "",
        category: a.category,
        subcategory: a.subcategory,
        sourceId: a.sourceId,
        summary: a.summary,
      });
      if (rel.tier === "drop") {
        bump("droppedByScore");
        continue;
      }
    }
    const sec = sectionOf(a);
    if (!sec) {
      bump("droppedNoSection");
      continue;
    }
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
    if (!summary) {
      bump("droppedNoSummary"); // 无摘要且无正文 → 跳过（避免空卡片）
      continue;
    }
    // 退化卡片守卫（gzinfo 2026-08-29）：有效摘要若与标题**实质相同** → 只是标题复读，跳过。
    // 比较前先剥离开头的【栏目/业务线】标签前缀：历史库里大量条目的 summary 是
    // 「【财富管理】+ 原标题」，若只做严格相等比较会被标签前缀绕过。
    //
    // B-1（2026-09-14）：本守卫**刻意保留**（信息密度原则，用户拍板不放宽），
    // 但必须计数——历史库无 AI 摘要时 excerpt 回退成标题，会让这里成批吞掉条目
    // （实测某期 114 条滚动池在此丢掉 63 条 → 主板块近乎全空）。计数交由调用方打日志。
    const stripTagPrefix = (s: string) => s.replace(/^(\s*【[^】]*】\s*)+/, "").trim();
    const titleText = stripTagPrefix(a.title_cn || a.title || "");
    const summaryText = stripTagPrefix(summary);
    if (
      titleText &&
      (summaryText === titleText || summaryText === titleText.slice(0, 90))
    ) {
      bump("droppedDegenerate");
      continue;
    }
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
    bump("merged");
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
