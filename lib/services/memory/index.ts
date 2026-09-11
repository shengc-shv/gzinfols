/**
 * 记忆服务 C5（单一写者）：30 天滚动历史库。
 *
 * 全仓库只有此处向 history 写盘（单一写者，避免多写者静默失效）。
 * 负责：加载历史 → 合并本次 → 回写。历史库回放同样经归一化（无 publishedAt 丢弃）。
 */
import type { ArticleInput } from "../../contracts/article";
import type { DailyReport, ReportItem, ReportSectionKey } from "../../contracts/report";
import type { FileStore, PipelineContext } from "../../contracts/pipeline";

export interface HistoryItem {
  url: string;
  title: string;
  summary: string;
  date: string;
  section: string;
  source?: string;
  publishedAt?: string;
}

export interface HistoryStore {
  date: string;
  items: HistoryItem[];
}

export interface MemoryDeps {
  fs: FileStore;
}

const HISTORY_PATH = "data/history.json";
const ROLLING_DAYS = 30;

export async function loadHistory(deps: MemoryDeps): Promise<HistoryStore> {
  return (await deps.fs.readJson<HistoryStore>(HISTORY_PATH)) ?? { date: "", items: [] };
}

function daysBetween(a: string, b: string): number {
  return Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
}

/** 合并本次报告条目进滚动历史（单一写者）。 */
export async function saveHistory(
  report: DailyReport,
  articles: ArticleInput[],
  ctx: PipelineContext,
  deps: MemoryDeps,
): Promise<HistoryStore> {
  const prev = await loadHistory(deps);
  const byUrl = new Map(articles.map((a) => [a.url, a]));
  const newItems = (Object.entries(report.sections) as [ReportSectionKey, ReportItem[]][]).flatMap(
    ([section, items]) =>
      items.map((it) => ({
        url: it.url,
        title: it.title_cn,
        summary: it.summary,
        date: it.date,
        section,
        source: byUrl.get(it.url)?.source ?? "",
        publishedAt: byUrl.get(it.url)?.publishedAt?.toISOString() ?? "",
      })),
  );
  const merged = [...newItems, ...prev.items].slice(0, 5000);
  const store: HistoryStore = { date: ctx.date, items: merged };
  await deps.fs.writeJson(HISTORY_PATH, store);
  ctx.log.info("memory", `历史库写入 ${merged.length} 条（含本次 ${newItems.length}）`);
  return store;
}

/** 回放：返回窗口内的历史条目（供「过去 30 天」展示）。 */
export function rollingSince(store: HistoryStore, sinceIso: string): HistoryStore["items"] {
  return store.items.filter((it) => daysBetween(it.date, sinceIso) <= ROLLING_DAYS);
}
