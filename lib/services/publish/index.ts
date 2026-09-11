/**
 * 发布服务 C9：把渲染产物落盘为「可独立部署的产物包」。
 *
 * 职责边界（端口适配器）：只通过 FileStore 端口写盘，不碰 git / 网络。
 * 实际的 gh-pages 推送、企微/公众号推送由 CI（.github/workflows）或部署脚本负责，
 * 本服务只保证「产物已就位 + 写出 latest 指针」，使项目可独立发布/部署/运行。
 */
import type { DailyReport } from "../../contracts/report";
import type { FileStore, PipelineContext } from "../../contracts/pipeline";

export interface PublishInput {
  report: DailyReport;
  html: string;
  markdown: string;
}

export interface PublishDeps {
  fs: FileStore;
}

/** 把日报产物写入 daily_reports/<date>/ 与站点根（site/）。 */
export async function publishReport(
  input: PublishInput,
  ctx: PipelineContext,
  deps: PublishDeps,
): Promise<{ reportPath: string; htmlPath: string; mdPath: string }> {
  const date = ctx.date;
  const dir = `daily_reports/${date}`;
  const base = `${dir}/${date}`;

  await deps.fs.writeJson(`${base}.json`, input.report);
  await deps.fs.writeText(`${base}.html`, input.html);
  await deps.fs.writeText(`${base}.md`, input.markdown);

  // 站点根：latest 指针 + 复制一份到 site/（供静态托管 / gh-pages 直接发布）。
  await deps.fs.writeText("site/index.html", input.html);
  await deps.fs.writeJson("site/latest.json", { date, report: input.report });
  await deps.fs.writeText(`site/${date}.html`, input.html);

  ctx.log.info("publish", `产物已落盘：${base}.html / .json / .md + site/`);
  return { reportPath: `${base}.json`, htmlPath: `${base}.html`, mdPath: `${base}.md` };
}
