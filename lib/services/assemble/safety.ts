/**
 * 渲染前安全过滤（**红线兜底**，2026-09-16；2026-10-03 扩到股市复盘并前移）。
 *
 * 为什么需要：加密资产零容忍（用户 2026-09-12 拍板，永久）——**不移植、不渲染、不进契约**。
 * 但 `stock_news` / `stock_recap`（股市动态与三卡复盘）由 market 服务独立构建，
 * **不经过 enrich 管线的违禁词早筛**，是一条真实的漏网路径：
 *   · 2026-09-16 实证 stock_news 出现「加密货币市场遭遇重大利空」，已渲染到线上页面；
 *   · 2026-10-03 实证 `stock_recap.us.sectors[2]` =「比特币周内小幅上涨…」**同样已渲染上线**
 *     （`stripCryptoNews` 当时只管 stock_news → 完全看不见这条）。
 *
 * 🔴 **为什么必须前移到「旁路汇聚处」而不是留在渲染入口**：音频在 `renderHtml` **之前**装配
 * （`pipeline/index.ts` 先 `assembleBriefingScript` 再渲染）→ 只过滤渲染层时，
 * **口播读的仍是未过滤的 report**。10-03 那条美股板块句没被念出来只是侥幸（美股只取分最高 2 条，它排第 3）。
 * 现由 `pipeline/side-outputs/side-outputs.ts` 在旁路汇聚后统一调用 → 下游
 * （展示限额 → 口播 → 渲染 → 落盘 JSON）全部干净；渲染入口的调用保留为**幂等安全网**
 * （覆盖「已落盘老报告的重渲染」与检索索引链路）。
 *
 * 只拦 `CRYPTO_WORDS`（加密专用词表），**不用** `BANNED_WORDS`：后者含「偏上行/偏下行」
 * 等非加密话术词，拿去过滤股市内容会误伤正常行情表述。
 */
import type { DailyReport, MarketCard } from "../../contracts/report";
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

/** 纯文本是否命中加密词。 */
function textHitsCrypto(text: string): boolean {
  return CRYPTO_WORDS.some((w) => text.includes(w));
}

/** 剔除股市动态中的加密类条目（幂等、不 mutate 入参；无命中则原样返回）。 */
export function stripCryptoNews(report: DailyReport): DailyReport {
  const list = report.stock_news ?? [];
  if (list.length === 0) return report;
  const kept = list.filter((it) => !hitsCrypto(it));
  if (kept.length === list.length) return report;
  return { ...report, stock_news: kept };
}

/**
 * 整句剥离：命中加密词时**只丢命中句**，不整段删除。
 *
 * 为什么不是整段删：`overview` 是一段收评（多句），其中一句提到加密不代表整段作废；
 * 整段删会让卡面莫名空掉（还可能让口播段整段消失）。剥离后若不再命中即返回。
 */
function scrubSentences(text: string): { text: string; dropped: number } {
  if (!text || !textHitsCrypto(text)) return { text, dropped: 0 };
  const sentences = text.split(/(?<=[。！？!?；;])/);
  const kept = sentences.filter((s) => s.trim() && !textHitsCrypto(s));
  return { text: kept.join("").trim(), dropped: sentences.length - kept.length };
}

/** 单张三卡：overview / sectors / spoken / sourceReport.title 逐处清洗。 */
function scrubCard(card: MarketCard): { card: MarketCard; sectors: number; sentences: number } {
  let changed = false;
  let sectors = 0;
  let sentences = 0;

  const ov = scrubSentences(card.overview ?? "");
  if (ov.dropped) {
    changed = true;
    sentences += ov.dropped;
  }

  const keptSectors = (card.sectors ?? []).filter((s) => !textHitsCrypto(s));
  if (keptSectors.length !== (card.sectors ?? []).length) {
    changed = true;
    sectors += (card.sectors ?? []).length - keptSectors.length;
  }

  let spoken = card.spoken;
  if (spoken) {
    const r = scrubSentences(spoken);
    if (r.dropped) {
      changed = true;
      sentences += r.dropped;
      spoken = r.text || undefined; // 清空 → 去掉字段，让口播回落到 overview/sectors 派生
    }
  }

  // 素材来源标题（`sourceReport` 是 MarketCard 的**顶层**字段，不在 meta 里 —— 改前先核对契约）
  let sourceReport = card.sourceReport;
  if (sourceReport?.title && textHitsCrypto(sourceReport.title)) {
    changed = true;
    sentences += 1;
    sourceReport = undefined;
  }

  if (!changed) return { card, sectors: 0, sentences: 0 };
  const next: MarketCard = { ...card, overview: ov.text, sectors: keptSectors };
  // ⚠️ 必须显式 delete：`...card` 会把**原**值带过来，仅靠条件展开会漏掉旧值。
  if (spoken) next.spoken = spoken;
  else delete next.spoken;
  if (sourceReport) next.sourceReport = sourceReport;
  else delete next.sourceReport;
  return { card: next, sectors, sentences };
}

export interface CryptoScrubStats {
  /** 被剔除的股市动态条数。 */
  stockNews: number;
  /** 被剔除的板块句条数。 */
  sectors: number;
  /** 被剥离的整句条数（overview / spoken）。 */
  sentences: number;
}

/**
 * 全报告加密清洗（**红线单一入口**，幂等、不 mutate 入参）。
 *
 * 覆盖两处旁路产物：`stock_news`（整条剔除）与 `stock_recap` 三卡
 * （`overview`/`spoken` 整句剥离 · `sectors` 逐条剔除 · `meta.sourceReport.title` 抹除）。
 * 全部未命中 → 返回**原对象**（引用相等，调用方无需判等）。
 */
export function sanitizeCrypto(report: DailyReport): {
  report: DailyReport;
  stats: CryptoScrubStats;
} {
  const stats: CryptoScrubStats = { stockNews: 0, sectors: 0, sentences: 0 };

  const news = report.stock_news ?? [];
  const keptNews = news.filter((it) => !hitsCrypto(it));
  stats.stockNews = news.length - keptNews.length;

  let recap = report.stock_recap;
  if (recap) {
    const keys = ["us", "aShare", "hk"] as const;
    const next = { ...recap };
    for (const k of keys) {
      const card = recap[k];
      if (!card) continue;
      const r = scrubCard(card);
      if (r.card !== card) {
        next[k] = r.card;
        stats.sectors += r.sectors;
        stats.sentences += r.sentences;
      }
    }
    if (
      stats.sectors + stats.sentences > 0 &&
      (next.us !== recap.us || next.aShare !== recap.aShare || next.hk !== recap.hk)
    ) {
      recap = next;
    }
  }

  if (stats.stockNews === 0 && recap === report.stock_recap) return { report, stats };
  return {
    report: {
      ...report,
      ...(stats.stockNews ? { stock_news: keptNews } : {}),
      ...(recap !== report.stock_recap ? { stock_recap: recap } : {}),
    },
    stats,
  };
}
