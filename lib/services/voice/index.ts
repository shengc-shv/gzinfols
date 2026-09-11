/**
 * 语音服务 C8：生成「口播稿」（纯函数，零副作用、零外部依赖）。
 *
 * 仅负责把 DailyReport 拼成一段可直接念的文稿；真正的 TTS 合成（若启用）
 * 由部署侧调用，不在核心管线内（去掉非必要的外部依赖与网络耦合）。
 */
import type { DailyReport } from "../../contracts/report";
import { SECTION_LABELS, SECTION_ORDER } from "../../contracts/report";

/** 生成口播稿文本。 */
export function buildSpeechScript(report: DailyReport): string {
  const lines: string[] = [];
  lines.push(`招行广州分行每日资信简报，${report.date}。`);
  if (report.hero_line) lines.push(report.hero_line);

  if (report.must_read?.length) {
    lines.push("今日必读。");
    for (const m of report.must_read) lines.push(`${m.title ?? ""}。${m.why}`);
  }
  if (report.insights?.length) {
    for (const ins of report.insights)
      lines.push(`洞察：${ins.topic}。影响，${ins.impact}。建议，${ins.action}。`);
  }
  for (const key of SECTION_ORDER) {
    const items = report.sections[key];
    if (!items?.length) continue;
    lines.push(`${SECTION_LABELS[key]}。`);
    for (const it of items.slice(0, 5)) lines.push(`${it.title_cn}。${it.summary}`);
  }
  if (report.risk) lines.push(`风险提示：${report.risk.topic}。${report.risk.action}`);
  return lines.join("\n");
}
