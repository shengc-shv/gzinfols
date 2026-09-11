/**
 * 交易面板编排：抓 watchlist 全部标的并逐个做技术面分析。
 *
 * 2.0 适配（架构）：gzinfo 的 `fetchTickerData` 直连 Yahoo（隐式 IO），
 * 2.0 服务层不得持有副作用出口 —— 改由调用方注入抓取函数（组合根装配
 * `lib/adapters/market-yahoo.ts` 的 `fetchTickerData`）。
 *
 * 失败语义与 gzinfo 一致：单标的失败不影响整体（warn 后从结果中剔除）。
 * 返回顺序沿用 WATCHLIST，渲染侧可据此按 AssetGroup 分组而无需再排序。
 */
import { analyzeTicker } from "./signals";
import { WATCHLIST } from "./watchlist";
import type { TickerAnalysis, TickerRawData } from "../../contracts/market";
import type { DisplayLocale } from "./signals";

export type TickerFetcher = (symbol: string) => Promise<TickerRawData | null>;

export async function analyzeWatchlist(
  fetcher: TickerFetcher,
  locale: DisplayLocale = "zh",
): Promise<TickerAnalysis[]> {
  const results = await Promise.all(
    WATCHLIST.map(async (def) => {
      try {
        const raw = await fetcher(def.symbol);
        if (!raw) {
          console.warn(`[trading] ${def.symbol} returned no data`);
          return null;
        }
        return analyzeTicker(def, raw, locale);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[trading] ${def.symbol} failed: ${msg}`);
        return null;
      }
    }),
  );
  return results.filter((x): x is TickerAnalysis => x !== null);
}
