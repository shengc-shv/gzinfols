/**
 * 本地预览渲染（临时工具，不参与构建）：用真实报告 JSON 渲染决策视角，
 * 带二期经营重点打标，产物写到 site/preview/decision-<date>.html。
 *
 * 用法：npx tsx scripts/render-preview-focus.ts 2026-11-28 /tmp/latest-1128.json
 */
import fs from "node:fs";
import path from "node:path";
import { renderHtml } from "../lib/services/render";
import { annotateFocus } from "../lib/services/assemble/focus-metadata";
import { loadFocusForRun } from "../lib/pipeline/focus-context";
import { classifyBusinessDomain } from "../lib/services/vocab/business-domains";
import { todayKey } from "../lib/utils/time";
import type { DailyReport, ReportItem } from "../lib/contracts/report";

const date = process.argv[2] ?? "2026-11-28";
const file = process.argv[3] ?? `/tmp/latest-${date.slice(5).replace("-", "")}.json`;
const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { report?: DailyReport } & Partial<DailyReport>;
const report = (raw.report ?? raw) as DailyReport;

// 历史报告没有 primary_domain（第一期字段后加）→ 渲染前按同一词表回填，模拟生产 annotateItemMetadata
const sections = Object.fromEntries(
  Object.entries(report.sections ?? {}).map(([k, list]) => [
    k,
    (list as ReportItem[]).map((it) => {
      if (it.primary_domain) return it;
      const d = classifyBusinessDomain({ title: it.title_cn, summary: it.summary });
      return d ? { ...it, primary_domain: d.primary_domain, related_domains: d.related_domains } : it;
    }),
  ]),
) as unknown as DailyReport["sections"];

const fc = loadFocusForRun(date, true);
// 与生产管线同一口径：只给年度三大重点打标（季度/临时只参与排序加权，不展示）
const displayFocus = fc.items.filter((f) => f.layer === "annual");
const withFocus = annotateFocus({ ...report, sections }, displayFocus, fc.version);

const html = renderHtml(withFocus);
const out = path.resolve("site/preview", `decision-${date}.html`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html, "utf8");

const items = Object.values(withFocus.sections ?? {}).flat() as ReportItem[];
const tagged = items.filter((it) => (it.focus_hits?.length ?? 0) > 0);
console.log(`→ ${out}`);
console.log(
  `  今日 ${todayKey()}｜报告日 ${date}｜条目 ${items.length}｜带重点标签 ${tagged.length}｜生效重点 ${fc.items.length}（${fc.version}）`,
);
for (const it of tagged) {
  const tags = (it.focus_hits ?? []).map((h) => `${h.level}「${h.name}」+${h.bonus}`).join(" / ");
  console.log(`  · ${tags}  ← ${it.title_cn.slice(0, 40)}`);
}
console.log(
  "  汇总：" +
    (withFocus.focus?.items ?? []).map((f) => `${f.name} ${f.count}${f.high ? `(实质${f.high})` : ""}`).join("｜"),
);
