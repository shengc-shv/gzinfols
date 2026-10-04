/**
 * 由归一化文章池合成「无 AI」DailyReport（sections 驱动渲染）。
 *
 * 移植自 gzinfo lib/output/report-from-articles.ts（2026-09-13 R2 批次，逐字）。
 *
 * 供 npm run render / dry-run / render-preview 等**不调模型**的重渲染脚本使用：
 * 这些脚本只抓取/读历史，拿不到 AI 成稿的 summary / source_type / importance，
 * 所以用已有 summary（若为 render-preview 的历史库 AI 摘要）或 excerpt 兜底，
 * 并把采集分类映射到新管线的五个渲染板块。与 pipeline.ts 的 categoryToSection 保持一致。
 */
import type { ArticleInput } from "../../contracts/article";
import type { DailyReport, ReportItem } from "../../contracts/report";
import { rollUpTags } from "../enrich/tag-rollup";
import { dedupeSections } from "../enrich/dedupe-sections";
import { isGzLocalCandidate } from "./cards";

/**
 * 旧采集分类 → 新管线渲染板块（无 AI 兜底映射）。
 *
 * **单一真源已回归 `enrich/heuristics#categoryToSection`**（2026-10-04，sc「检查全部归栏逻辑」）：
 * 本文件此前自带一份实现，与 `enrich/pipeline.ts` 的那份**已经漂移**
 * —— 此处多一条 `isGdIpoCandidate → ipo` 判定（即「同一条广东 IPO 媒体报道，
 * `npm run render` 归 IPO 栏目、生产管线归业务启示」）。现统一由 heuristics 提供，
 * 本处保留同名导出以兼容既有 import 路径（`tests/report-from-articles.test.ts` 等）。
 *
 * 无状态源架构红线（2026-08-29 用户）：板块归属一律由**内容判定**，数据源分类只是采集元数据。
 */
import { categoryToSection } from "../enrich/heuristics";
export { categoryToSection };

function mmdd(d: Date | undefined): string {
  if (!d) return "";
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${m}/${dd}`;
}

export function buildNoAiReport(articles: ArticleInput[]): DailyReport {
  const sections: DailyReport["sections"] = {
    gz_local: [],
    biz_insight: [],
    policy_market: [],
    tech: [],
    ipo: [],
  };
  let rank = 0;
  for (const a of articles) {
    // 无状态源架构红线（2026-08-29 用户）：板块归属由内容判定，category 只是采集元数据。
    const sec = categoryToSection(a.category, a.title_cn || a.title || "", a.excerpt || "");
    const d = a.publishedAt ?? a.fetchedAt;
    const summarySrc = a as { summary?: string; excerpt?: string; title: string };
    const summary = (summarySrc.summary || summarySrc.excerpt || summarySrc.title || "").slice(0, 90);
    const item: ReportItem = {
      url: a.url,
      title_cn: (a as { title_cn?: string }).title_cn || a.title,
      source: a.source,
      source_type: "media",
      date: mmdd(d),
      summary,
      importance: 2,
      rank: ++rank,
      tags: rollUpTags(a),
      // 无状态源架构红线：locale 由内容判定（广州锚），不依赖数据源分类。
      locale: isGzLocalCandidate(a.title_cn || a.title || "", a.excerpt || "")
        ? "gz"
        : "national",
    };
    sections[sec].push(item);
  }
  // 扎口：跨板块去重（2026-08-29）——与 AI 路径（pass2）保持同一行为
  dedupeSections(sections);
  return { date: "", hero_line: "", must_read: [], insights: [], sections };
}
