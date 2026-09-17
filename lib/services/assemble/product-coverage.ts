/**
 * 客群商机覆盖统计（C4，2026-09-17）。
 *
 * 产出「按揭 / 信用卡 / 代发」三条产品线在图中的覆盖情况（命中条数 + 示例），
 * 供页面透明展示：**命中有条数，未命中显式标「本期无」**。
 *
 * 统计范围（刻意明确，避免读者误读）：
 *  - 商机洞察（`insights`：AI 产出的可行动商机）；
 *  - 业务启示板块（`sections.biz_insight`：能挂上条线的资讯）。
 *  只统计这两处，因为它们才是「商机覆盖」的语义范围；政策/IPO/股市不参与，
 *  否则「按揭」会被楼市新闻刷成假覆盖。
 *
 * 纯函数、零 LLM、零 token；不做任何「为凑覆盖而补内容」的动作（业务相关性红线）。
 */
import type { DailyReport, ProductLineCoverage } from "../../contracts/report";
import { PRODUCT_LINES, productLinesOf, type ProductLine } from "../classify/product-line";

export type { ProductLineCoverage };

/** 统计三条产品线的覆盖（顺序固定 = PRODUCT_LINES，便于页面稳定展示）。 */
export function productCoverageOf(report: DailyReport): ProductLineCoverage[] {
  const texts: string[] = [];
  for (const it of report.insights ?? []) {
    texts.push(`${it.topic ?? ""} ${it.impact ?? ""} ${it.action ?? ""} ${(it.tags ?? []).join(" ")}`);
  }
  for (const it of report.sections?.biz_insight ?? []) {
    texts.push(`${it.title_cn ?? it.title_orig ?? ""} ${it.summary ?? ""} ${(it.tags ?? []).join(" ")}`);
  }

  const hitsByLine = new Map<ProductLine, string[]>();
  for (const line of PRODUCT_LINES) hitsByLine.set(line, []);
  for (const text of texts) {
    for (const line of productLinesOf(text)) {
      hitsByLine.get(line)?.push(text.split(" ")[0] ?? "");
    }
  }
  return PRODUCT_LINES.map((line) => {
    const hits = hitsByLine.get(line) ?? [];
    return { line, count: hits.length, examples: hits.filter(Boolean).slice(0, 2) };
  });
}

/** 供管线打印一条可观测日志（本期哪几条产品线是空的）。 */
export function productCoverageSummary(coverage: ProductLineCoverage[]): string {
  const hit = coverage.filter((c) => c.count > 0).map((c) => `${c.line} ${c.count}`);
  const miss = coverage.filter((c) => c.count === 0).map((c) => c.line);
  return `${hit.join(" / ") || "（无命中）"}${miss.length ? `；本期无：${miss.join("、")}` : ""}`;
}
