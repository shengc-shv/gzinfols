/**
 * Markdown 归档渲染（纯文本，供 md 产物与口播稿复用）。
 *
 * 2026-09-14（C-1 Phase1）：自 `full.ts` **纯搬移**（行为零变化）。
 */
import { STR } from "./i18n";
import { SECTION_LABELS, type DailyReport, type ReportSectionKey } from "../../contracts/report";

// ----- trading panel -----

export const SIGNAL_TONE: Record<string, "bull" | "bear" | "caution"> = {
  "golden-cross": "bull",
  "macd-bull-cross": "bull",
  "above-sma50-sma200": "bull",
  "near-52w-high": "bull",
  "death-cross": "bear",
  "macd-bear-cross": "bear",
  "below-sma50-sma200": "bear",
  "near-52w-low": "bear",
  "rsi-overbought": "caution",
  "rsi-oversold": "caution",
};

// ----- markdown（新管线 schema: report.sections）-----

export function renderMarkdown(report: DailyReport, date: string): string {
  const blocks: string[] = [];
  blocks.push(`# ${STR.siteTitle} · ${date}\n`);
  if (report.hero_line) blocks.push(`> ${report.hero_line}\n`);

  const secMap: [string, ReportSectionKey][] = [
    ["广州本地", "gz_local"],
    ["业务启示", "biz_insight"],
    ["政策与市场", "policy_market"],
    ["科技前沿", "tech"],
    ["广东IPO动态", "ipo"],
  ];
  for (const [label, key] of secMap) {
    const items = report.sections?.[key] ?? [];
    if (items.length === 0) {
      if (key === "gz_local") blocks.push(`## 广州本地\n\n（今日无广州本地要闻）\n`);
      continue;
    }
    const body = items
      .map(
        (it) =>
          `### [${it.title_cn || it.title_orig || ""}](${it.url})\n${it.source} · ${it.source_type === "official" ? "官方" : "媒体"} · 重要度 ${it.importance}/3\n\n${it.summary}\n`,
      )
      .join("\n");
    blocks.push(`## ${label}\n\n${body}\n`);
  }

  if (report.must_read.length > 0) {
    blocks.push(
      `## 今日必读\n\n${report.must_read
        .map((m, i) => `${i + 1}. ${m.url}${m.why ? ` — ${m.why}` : ""}`)
        .join("\n")}\n`,
    );
  }
  if (report.insights.length > 0) {
    blocks.push(
      `## 商机洞察\n\n${report.insights
        .map((it) => `- **${it.topic}**${it.impact ? `：影响 ${it.impact}` : ""}${it.action ? ` → 动作 ${it.action}` : ""}`)
        .join("\n")}\n`,
    );
  }
  return blocks.filter(Boolean).join("\n");
}
