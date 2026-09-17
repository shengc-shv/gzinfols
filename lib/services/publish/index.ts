/**
 * 发布服务 C9：把渲染产物落盘为「可独立部署的产物包」。
 *
 * 职责边界（端口适配器）：只通过 FileStore 端口写盘，不碰 git / 网络。
 * 实际的 gh-pages 推送、企微群机器人推送由 CI（.github/workflows）或部署脚本负责，
 * 本服务只保证「产物已就位 + 写出 latest 指针」，使项目可独立发布/部署/运行。
 */
import type { DailyReport } from "../../contracts/report";
import type { ArticleInput } from "../../contracts/article";
import type { FileStore, PipelineContext } from "../../contracts/pipeline";
import { assignItemIds } from "../assemble/item-id";
import { detailPagesOf } from "../render/detail";

export interface PublishInput {
  report: DailyReport;
  html: string;
  markdown: string;
  /**
   * 滚动列表（today + past-30d，history-step 的 buildRolling 产物）。
   * 写 sidecar `<date>-articles.json`：scripts/render 可用它重建 HTML/MD，
   * 无需重抓或重调 LLM（gzinfo render-and-write ② 同款）。
   */
  rolling?: ArticleInput[];
  /**
   * 归一化+漏斗后的全量文章池（select 产物）。
   * 导出 `data/fetched-articles.json`，供预分析任务或人工核查比对
   * （gzinfo render-and-write ③ 同款）。
   */
  pool?: ArticleInput[];
}

export interface PublishDeps {
  fs: FileStore;
}

/** 把日报产物写入 daily_reports/<date>/ 与站点目录（site/<date>/，2026-09-14 B-3 子目录布局）。 */
export async function publishReport(
  input: PublishInput,
  ctx: PipelineContext,
  deps: PublishDeps,
): Promise<{ reportPath: string; htmlPath: string; mdPath: string }> {
  const date = ctx.date;
  const dir = `daily_reports/${date}`;
  const base = `${dir}/${date}`;

  // 原子写（可选能力）：报告与 sidecar 用 tmp+rename，防「半个报告」；MemFs 无此能力则回退
  const writeJson = (p: string, data: unknown) =>
    deps.fs.writeJsonAtomic ? deps.fs.writeJsonAtomic(p, data) : deps.fs.writeJson(p, data);

  await writeJson(`${base}.json`, input.report);
  await deps.fs.writeText(`${base}.html`, input.html);
  await deps.fs.writeText(`${base}.md`, input.markdown);

  // Sidecar：滚动列表（today + past-30d）+ AI 摘要，供重渲染/人工核查（gzinfo 同款）
  if (input.rolling) {
    await writeJson(`${base}-articles.json`, { date, articles: input.rolling });
    ctx.log.info("publish", `sidecar 已写：${base}-articles.json（${input.rolling.length} 条滚动列表）`);
  }
  // 全量池导出：漏斗后条目（gzinfo data/fetched-articles.json 同位）
  if (input.pool) {
    await writeJson("data/fetched-articles.json", input.pool);
    ctx.log.info("publish", `📤 归一化全量池导出: ${input.pool.length} 条 → data/fetched-articles.json`);
  }

  // 站点产物（2026-09-14 B-3）：改**子目录布局** `site/<date>/<date>.html`。
  // 原扁平 `site/<date>.html` 与归档页 `../archive.html`、音频相对路径、
  // 以及 scripts/build-site.mjs 假设的 `<date>/<date>.html` 结构互不兼容。
  // `site/index.html`（最新一期）与 `archive.html` / `.nojekyll` / `og-image.png`
  // 由 build-site 生成（它是发布根的唯一写者）；此处只落当期的报告页，
  // 使本地「只跑 daily」时也能直接从 site/<date>/ 打开报告。
  await deps.fs.writeText(`site/${date}/${date}.html`, input.html);
  await deps.fs.writeJson("site/latest.json", { date, report: input.report });

  // A2（2026-09-16）站内详情页：每条条目一页 `i/<itemId>.html`（零 LLM、纯字符串）。
  // 与报告页卡片链接同源（卡片 → i/<id>.html → 原文外链），外链因此降为次级出口。
  // 站点目录同时落一份，使本地「只跑 daily」也能点开；build-site 会再搬运一次（幂等）。
  const withIds = assignItemIds(input.report);
  const detailPages = detailPagesOf(withIds);
  for (const p of detailPages) {
    await deps.fs.writeText(`${dir}/i/${p.id}.html`, p.html);
    await deps.fs.writeText(`site/${date}/i/${p.id}.html`, p.html);
  }

  ctx.log.info(
    "publish",
    `产物已落盘：${base}.html / .json / .md + site/${date}/` +
      (detailPages.length ? `（含站内详情页 ${detailPages.length} 份 → i/）` : ""),
  );
  return { reportPath: `${base}.json`, htmlPath: `${base}.html`, mdPath: `${base}.md` };
}
