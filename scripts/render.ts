/**
 * 入口：从已落盘的 daily_reports/<date>/<date>.json 重新渲染 HTML / MD。
 * 不重抓、不调 LLM —— 仅消费已生成的报告 JSON（修复纯展示问题用）。
 */
import "./_env";
import { NodeFsAdapter, SystemClock } from "../lib/adapters";
import { renderHtml, renderMarkdown } from "../lib/services/render";
import { renderInjectionFromEnv } from "../lib/orchestrator";
import type { DailyReport } from "../lib/contracts/report";
import { setReportLocale } from "../lib/services/render/locale";

async function main() {
  const clock = new SystemClock();
  const date = process.env.REPORT_DATE || clock.todayKey();
  const fs = new NodeFsAdapter();
  const report = await fs.readJson<DailyReport>(`daily_reports/${date}/${date}.json`);
  if (!report) {
    console.error(`未找到 ${date} 的报告 JSON（请先运行 npm run daily）`);
    process.exit(1);
  }
  // 渲染注入（P0-4）：脚本属允许直读 env 的边界，集中由组合根 helper 解析。
  const html = renderHtml(report, renderInjectionFromEnv());
  const md = renderMarkdown(report);
  await fs.writeText(`daily_reports/${date}/${date}.html`, html);
  await fs.writeText(`daily_reports/${date}/${date}.md`, md);
  // 站点目录（B-3 子目录布局）：与 build-site 的 `<date>/<date>.html` 一致。
  await fs.writeText(`site/${date}/${date}.html`, html);
  console.log(`已重渲染 ${date} → daily_reports/${date}/${date}.html + site/${date}/${date}.html`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
