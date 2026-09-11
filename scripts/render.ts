/**
 * 入口：从已落盘的 daily_reports/<date>/<date>.json 重新渲染 HTML / MD。
 * 不重抓、不调 LLM —— 仅消费已生成的报告 JSON（修复纯展示问题用）。
 */
import "./_env";
import { NodeFsAdapter, SystemClock } from "../lib/adapters";
import { renderHtml, renderMarkdown } from "../lib/services/render";
import type { DailyReport } from "../lib/contracts/report";

async function main() {
  const clock = new SystemClock();
  const date = process.env.REPORT_DATE || clock.todayKey(process.env.REPORT_TZ);
  const fs = new NodeFsAdapter();
  const report = await fs.readJson<DailyReport>(`daily_reports/${date}/${date}.json`);
  if (!report) {
    console.error(`未找到 ${date} 的报告 JSON（请先运行 npm run daily）`);
    process.exit(1);
  }
  const html = renderHtml(report);
  const md = renderMarkdown(report);
  await fs.writeText(`daily_reports/${date}/${date}.html`, html);
  await fs.writeText(`daily_reports/${date}/${date}.md`, md);
  await fs.writeText("site/index.html", html);
  console.log(`已重渲染 ${date} → daily_reports/${date}/${date}.html`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
