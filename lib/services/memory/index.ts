/**
 * 记忆服务 C5（单一写者）：30 天滚动历史库。
 *
 * 全仓库只有此处向 history 写盘（单一写者，避免多写者静默失效）。
 * 负责：加载历史 → 回放去重（dedupeAgainstHistory）→ 合并本次 → 真 30 天滚动裁剪 → cap 5000 回写。
 * 历史库回放同样经归一化（无 publishedAt 丢弃）。
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
  /** 数据源 id（跨天标题判重的 tier 查询用）。 */
  sourceId?: string;
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
const HISTORY_CAP = 5000;

export async function loadHistory(deps: MemoryDeps): Promise<HistoryStore> {
  return (await deps.fs.readJson<HistoryStore>(HISTORY_PATH)) ?? { date: "", items: [] };
}

/** 30 天滚动窗口判定：按 publishedAt（ISO）；缺省/非法时间戳保守保留（不误删）。 */
function withinRollingWindow(it: HistoryItem, now: Date): boolean {
  if (!it.publishedAt) return true;
  const t = Date.parse(it.publishedAt);
  if (Number.isNaN(t)) return true;
  return now.getTime() - t <= ROLLING_DAYS * 86_400_000;
}

/** 合并本次报告条目进滚动历史：真 30 天滚动裁剪（按 publishedAt）+ cap 5000（单一写者）。 */
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
        sourceId: byUrl.get(it.url)?.sourceId ?? "",
        source: byUrl.get(it.url)?.source ?? "",
        publishedAt: byUrl.get(it.url)?.publishedAt?.toISOString() ?? "",
      })),
  );
  const beforeTrim = [...newItems, ...prev.items];
  const merged = beforeTrim
    .filter((it) => withinRollingWindow(it, ctx.startTime))
    .slice(0, HISTORY_CAP);
  const store: HistoryStore = { date: ctx.date, items: merged };
  await deps.fs.writeJson(HISTORY_PATH, store);
  ctx.log.info(
    "memory",
    `历史库写入 ${merged.length} 条（含本次 ${newItems.length}，滚动裁剪剔除 ${
      beforeTrim.length - merged.length
    } 条）`,
  );
  return store;
}

/**
 * 回放：返回窗口内的历史条目（供「过去 30 天」展示）。
 * 时间取 it.publishedAt ?? it.date；解析为 NaN 的条目（如旧版 "MM/DD" 展示格式）视为窗外。
 */
export function rollingSince(store: HistoryStore, sinceIso: string): HistoryStore["items"] {
  const since = Date.parse(sinceIso);
  if (Number.isNaN(since)) return [];
  return store.items.filter((it) => {
    const t = Date.parse(it.publishedAt ?? it.date);
    if (Number.isNaN(t)) return false;
    return Math.abs(t - since) / 86_400_000 <= ROLLING_DAYS;
  });
}
