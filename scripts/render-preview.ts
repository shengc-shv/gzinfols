/**
 * 预览渲染（移植自 gzinfo scripts/render-preview.ts，2026-09-13 R2 批次）：
 * 完全使用本地历史库（data/article-history.json 中已写入的 AI 摘要）生成报告页面，
 * **不调用任何 AI、不联网抓取**。
 *
 * 用途：把「预加载清单」的效果直接渲染成项目同款 HTML，供预览。
 * 渲染复用 services/render（renderHtml / renderMarkdown），样式与正式 daily 一致。
 */
import "./_env";
import fsSync from "node:fs";
import path from "node:path";
import { loadHistoryStore } from "../lib/adapters/persistence";
import { renderHtml, renderMarkdown, setReportLocale } from "../lib/services/render";
import { renderInjectionFromEnv } from "../lib/orchestrator";
import { buildNoAiReport } from "../lib/services/render/report-from-articles";
import { todayKey } from "../lib/utils/time";
import type { ArticleInput } from "../lib/contracts/article";

const OUTPUT_DIR = "daily_reports";

function main() {
  setReportLocale(process.env.REPORT_LOCALE); // 渲染语言注入（服务层不读 env）
  const date = todayKey();
  const history = loadHistoryStore();
  const today = date;

  // 1) 由本地历史构建文章列表，按「信息发生时间(publishedAt)」拆分时间标签：
  //    gd-ipo 按 publishedAt 拆「当天 / 过去7天」（与正式 daily 一致），
  //    其余分类预览模拟「当日完整抓取」全部计入当天。
  const DAY = 86_400_000;
  const repDayStart = new Date(today + "T00:00:00Z").getTime();
  const startOfDay = (d: Date) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).getTime();
  const articles: ArticleInput[] = [];
  let withSummary = 0;
  for (const e of Object.values(history)) {
    const ref = e.publishedAt
      ? new Date(e.publishedAt)
      : e.lastSeenAt
        ? new Date(e.lastSeenAt)
        : null;
    let fetchedToday: boolean;
    if (e.category === "gd-ipo") {
      if (!ref) {
        fetchedToday = false; // 既无发生时间也无分析时间，归入过去
      } else {
        const ageDays = Math.floor((repDayStart - startOfDay(ref)) / DAY);
        if (ageDays <= 0) fetchedToday = true;
        else if (ageDays >= 1 && ageDays <= 7) fetchedToday = false;
        else continue; // 超出 7 天窗口
      }
    } else {
      fetchedToday = true;
    }
    if (e.summary) withSummary++;
    articles.push({
      sourceId: e.sourceId,
      title: e.title,
      url: e.url,
      excerpt: e.excerpt,
      publishedAt: e.publishedAt ? new Date(e.publishedAt) : undefined,
      category: e.category,
      summary: e.summary,
      source: e.source,
      fetchedToday,
    } as ArticleInput);
  }
  console.log(
    `📊 本地历史 ${Object.keys(history).length} 条 ｜ 其中含 AI 摘要 ${withSummary} 条 ｜ 渲染文章 ${articles.length} 条`,
  );

  // 2) 由本地历史合成「无 AI」报告（sections 驱动渲染，内容判定归属）。
  const report = buildNoAiReport(articles);

  // 3) 渲染 HTML / Markdown（项目同款完整版面）。
  const html = renderHtml(report, renderInjectionFromEnv());
  const md = renderMarkdown(report);

  const dateDir = path.join(OUTPUT_DIR, date);
  fsSync.mkdirSync(dateDir, { recursive: true });
  fsSync.writeFileSync(path.join(dateDir, `${date}.html`), html, "utf8");
  fsSync.writeFileSync(path.join(dateDir, `${date}.md`), md, "utf8");
  console.log(`✅ 报告已生成: ${path.join(dateDir, date)}.html`);
  console.log(`✅ Markdown 摘要已生成: ${path.join(dateDir, date)}.md`);
}

main();
