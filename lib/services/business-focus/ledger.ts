/**
 * 经营重点台账合并（二期 WP7 · 纯函数，零 IO、零时钟 —— 可单测）。
 *
 * 与 `services/research/ledger.ts` 同构：读旧台账 → 并集/覆盖 → 写回；差别只有两点：
 *  1. **粒度是天，不是条**：日报重跑是常态，同一天重跑必须**整天替换**，否则立刻出现
 *     「同一天两份命中」的假增长（研报台账按 url 合并，天然幂等，这里没有那个性质）；
 *  2. **不裁旧**：研报按发布日滚 90 天是因为研报是时效观点；年度重点台账的价值恰恰在
 *     「今年这几个方向到底热过几次、什么时候热」—— 按 90 天裁掉，年底就回答不了年初的事，
 *     与主题语料「跟着 history 裁会越跟越短」是同一类错误。
 *     体积可控：一天通常 0~10 行命中，一行约 120 字节 → 一年约 200KB，与 `research-ledger`
 *     同量级。
 *
 * ⚠️ 本文件只做合并，**不做 IO、不判「该不该写」**（三态读取与拒写回在
 * `adapters/business-focus/ledger-store.ts`，装配在 `pipeline/focus-context.ts`）。
 */
import type { FocusItem } from "./types";
import type {
  FocusLedger,
  FocusLedgerDay,
  FocusVersionArchive,
  FocusVersionDefinition,
} from "../../contracts/focus-ledger";

/** 版本归档最多保留多少个版本（配置改得再勤，一年也就十几版；留 60 足够回溯）。 */
export const MAX_FOCUS_VERSIONS = 60;

export function emptyFocusLedger(): FocusLedger {
  return { version: 1, updatedAt: "", days: [] };
}

export function emptyVersionArchive(): FocusVersionArchive {
  return { version: 1, updatedAt: "", versions: [] };
}

/**
 * 写入/替换某一天的台账（不 mutate 入参）。
 *
 * 覆盖口径：**同 date 整体替换**（不是字段级合并）——命中集合是当天计算的产物，
 * 留一半旧的一半新的会得到一批从未真实存在过的组合。
 */
export function mergeFocusDay(ledger: FocusLedger, day: FocusLedgerDay): FocusLedger {
  const byDate = new Map<string, FocusLedgerDay>();
  for (const d of ledger.days ?? []) {
    if (!d?.date) continue;
    byDate.set(d.date, d);
  }
  byDate.set(day.date, day);
  const days = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
  return { version: 1, updatedAt: days[0]?.date ?? ledger.updatedAt, days };
}

/** 把一条重点定义压成归档需要的字段（去掉权重等派生值，改配置时权重会重算）。 */
export function definitionOf(item: FocusItem): FocusVersionDefinition {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    layer: item.layer,
    grade: item.grade,
    status: item.status,
    start_date: item.start_date,
    end_date: item.end_date,
    domains: [...item.domains],
    core_keywords: [...item.core_keywords],
    keywords: [...item.keywords],
    concepts: [...item.concepts],
    exclude_keywords: [...item.exclude_keywords],
    source: item.source,
  };
}

/**
 * 归档一个配置版本（不 mutate 入参）。
 *
 * 幂等：同一版本重复运行只更新 `lastSeen`，**定义保持首见那一份** ——
 * 版本号是内容指纹，同版本号必然同内容；若哪天出现不同内容（哈希碰撞或手改），
 * 以首见为准比「静默覆盖历史口径」安全得多。
 */
export function archiveFocusVersion(
  archive: FocusVersionArchive,
  opts: { version: string; date: string; focuses: readonly FocusItem[] },
): FocusVersionArchive {
  const { version, date } = opts;
  if (!version) return archive;
  const list = (archive.versions ?? []).filter((v) => v?.version);
  const idx = list.findIndex((v) => v.version === version);

  if (idx >= 0) {
    const prev = list[idx] as FocusVersionArchive["versions"][number];
    // lastSeen 只增不减：补跑更早批次不应把「最近使用日」往回拨
    const lastSeen = date > prev.lastSeen ? date : prev.lastSeen;
    const firstSeen = date < prev.firstSeen ? date : prev.firstSeen;
    if (lastSeen === prev.lastSeen && firstSeen === prev.firstSeen) return archive;
    const next = list.slice();
    next[idx] = { ...prev, firstSeen, lastSeen };
    return { version: 1, updatedAt: latestOf(next, date), versions: next };
  }

  const entry = {
    version,
    firstSeen: date,
    lastSeen: date,
    focuses: opts.focuses.map(definitionOf),
  };
  const next = [...list, entry].slice(-MAX_FOCUS_VERSIONS);
  return { version: 1, updatedAt: latestOf(next, date), versions: next };
}

function latestOf(versions: FocusVersionArchive["versions"], fallback: string): string {
  let max = fallback;
  for (const v of versions) if (v.lastSeen > max) max = v.lastSeen;
  return max;
}

/** 台账健康度（供日志一行说清：几天、几条命中、最近一天）。 */
export function focusLedgerSummary(ledger: FocusLedger): {
  days: number;
  hits: number;
  latest: string;
} {
  const days = ledger.days ?? [];
  return {
    days: days.length,
    hits: days.reduce((n, d) => n + (d.hits?.length ?? 0), 0),
    latest: days[0]?.date ?? "",
  };
}
