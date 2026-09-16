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
import { assignItemIds } from "../lib/services/assemble/item-id";
import { detailPagesOf } from "../lib/services/render/detail";

async function main() {
  const clock = new SystemClock();
  const date = process.env.REPORT_DATE || clock.todayKey();
  const fs = new NodeFsAdapter();
  const report = await fs.readJson<DailyReport>(`daily_reports/${date}/${date}.json`);
  if (!report) {
    console.error(`未找到 ${date} 的报告 JSON（请先运行 npm run daily）`);
    process.exit(1);
  }
  // A2：先补齐条目 ID（幂等；老报告重渲染不重新编号），卡片才能链到站内详情页
  const withIds = assignItemIds(report);
  // 渲染注入（P0-4）：脚本属允许直读 env 的边界，集中由组合根 helper 解析。
  const html = renderHtml(withIds, renderInjectionFromEnv());
  const md = renderMarkdown(withIds);
  await fs.writeText(`daily_reports/${date}/${date}.html`, html);
  await fs.writeText(`daily_reports/${date}/${date}.md`, md);
  // 站点目录（B-3 子目录布局）：与 build-site 的 `<date>/<date>.html` 一致。
  await fs.writeText(`site/${date}/${date}.html`, html);

  // A2 站内详情页：每条一页 → <date>/i/<itemId>.html（零 LLM）
  const pages = detailPagesOf(withIds);
  for (const p of pages) {
    await fs.writeText(`daily_reports/${date}/i/${p.id}.html`, p.html);
    await fs.writeText(`site/${date}/i/${p.id}.html`, p.html);
  }
  console.log(
    `已重渲染 ${date} → daily_reports/${date}/{${date}.html,${date}.md} + site/${date}/${date}.html` +
      (pages.length ? `（含 ${pages.length} 份站内详情页 i/）` : ""),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
