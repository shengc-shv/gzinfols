/**
 * 渲染前安全过滤（**红线兜底**，2026-09-16）。
 *
 * 为什么需要：加密资产零容忍（用户 2026-09-12 拍板，永久）——**不移植、不渲染、不进契约**。
 * 但 `stock_news`（股市动态）由 market 服务独立构建，**不经过 enrich 管线的违禁词早筛**，
 * 是一条真实的漏网路径（实证：2026-09-16 报告 stock_news 出现「加密货币市场遭遇重大利空」，
 * 已被渲染到线上页面）。
 *
 * 放在渲染入口而非源头：可同时覆盖「本次渲染」与「已落盘老报告的重渲染」——
 * 老报告 JSON 里的既有问题条目，重渲染时也会被拦下，不必等下一次抓取。
 *
 * 只拦 `CRYPTO_WORDS`（加密专用词表），**不用** `BANNED_WORDS`：后者含「偏上行/偏下行」
 * 等非加密话术词，拿去过滤股市新闻会误伤正常行情表述。
 */
import type { DailyReport } from "../../contracts/report";
import { CRYPTO_WORDS } from "../enrich/validator";

/** 条目中可能被渲染出的文本（标题 / 摘要 / 正文 / 链接）。 */
function blobOf(it: unknown): string {
  if (!it || typeof it !== "object") return "";
  const o = it as Record<string, unknown>;
  return ["title", "title_cn", "title_orig", "summary", "text", "url"]
    .map((k) => o[k])
    .filter((v): v is string => typeof v === "string")
    .join(" ");
}

/** 命中加密词 → true。 */
export function hitsCrypto(it: unknown): boolean {
  const blob = blobOf(it);
  if (!blob) return false;
  return CRYPTO_WORDS.some((w) => blob.includes(w));
}

/** 剔除股市动态中的加密类条目（幂等、不 mutate 入参；无命中则原样返回）。 */
export function stripCryptoNews(report: DailyReport): DailyReport {
  const list = report.stock_news ?? [];
  if (list.length === 0) return report;
  const kept = list.filter((it) => !hitsCrypto(it));
  if (kept.length === list.length) return report;
  return { ...report, stock_news: kept };
}
