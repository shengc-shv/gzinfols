/**
 * 持久化适配器（唯一磁盘出口之一）：滚动历史库 / 内容记忆库 / 执行摘要归档。
 *
 * gzinfo 对应物：lib/output/history.ts（loadHistory/saveHistory 的 fs 部分）、
 * lib/memory/store.ts（loadEventMemory/saveEventMemory）、
 * lib/ai/executive-summary.ts（writeStore/loadStore）。
 *
 * 与 FileStore 端口（异步、注入式）并存的原因：gzinfo 上述模块为同步 API 且被
 * 同步纯函数链消费（exec-guard / history-step），改异步会波及行为等价性；
 * 本文件集中在 adapters 层，服务层经 lib/pipeline 编排调用（不违反门禁）。
 */

import fs from "node:fs";
import path from "node:path";

import type { HistoryStore } from "../services/memory/history";
import { reviveEventMemory, prepareEventMemory, MEMORY_RETAIN_DAYS } from "../services/memory/store";
import { emptyMemory, type EventMemoryStore } from "../services/memory/event-memory";
import { REPORT_TZ } from "../utils/time";
import type { ExecutiveSummary } from "../services/enrich/executive-summary";
import type { StockRecap, StockNewsItem } from "../contracts/report";
import { emptyPublishState, type PublishState } from "../services/publish/publish-state";

/**
 * 根目录覆盖（测试隔离用）：默认 process.cwd()（与 gzinfo 行为一致）；
 * e2e 测试注入临时目录，避免污染真实 data/。
 */
let baseDirOverride: string | undefined;
export function setPersistenceBaseDir(dir: string | undefined): void {
  baseDirOverride = dir;
}
function root(): string {
  return baseDirOverride ?? process.cwd();
}

// ---------- 通用同步 JSON IO ----------

function readJsonSync(p: string): unknown | undefined {
  try {
    if (!fs.existsSync(p)) return undefined;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJsonSync(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

// ---------- 滚动历史库（data/article-history.json） ----------

const historyPath = (): string => path.resolve(root(), "data/article-history.json");

/**
 * 读取历史库；文件缺失/损坏/形状不符返回空库（不打断主流程）。
 */
export function loadHistoryStore(): HistoryStore {
  const raw = readJsonSync(historyPath());
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as HistoryStore;
  }
  return {};
}

/** 写入历史库（写盘失败静默忽略——归档失败不打断主流程，与 gzinfo 同策略）。 */
export function persistHistoryStore(store: HistoryStore): void {
  try {
    writeJsonSync(historyPath(), store);
  } catch {
    // ignore
  }
}

// ---------- 发布来源记账（data/publish-state.json） ----------

export interface PublishStateOpts {
  /** 便于单测隔离；默认 process.cwd()。 */
  baseDir?: string;
}

function publishStatePath(opts: PublishStateOpts): string {
  return path.resolve(opts.baseDir ?? root(), "data/publish-state.json");
}

/**
 * 读取发布来源记账；文件缺失/损坏/结构不符一律返回空库（不打断主流程）。
 * 容错口径与 gzinfo `scripts/record-publish-state.ts` 的 loadState 一致：
 * reports 缺失/非对象 → 空库重建；updatedAt 非字符串 → 空串。
 */
export function loadPublishState(opts: PublishStateOpts = {}): PublishState {
  const raw = readJsonSync(publishStatePath(opts));
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Partial<PublishState>;
    if (r.reports && typeof r.reports === "object" && !Array.isArray(r.reports)) {
      return {
        version: 1,
        updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
        reports: r.reports as PublishState["reports"],
      };
    }
  }
  return emptyPublishState();
}

/**
 * 写入发布来源记账（2 空格缩进 + 结尾换行，与 gzinfo record-publish-state 落盘格式一致）。
 * 写盘失败静默忽略——记账失败不阻断主流程（随后 git 提交会显式失败）。
 */
export function persistPublishState(state: PublishState, opts: PublishStateOpts = {}): void {
  try {
    const p = publishStatePath(opts);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch {
    // ignore
  }
}

// ---------- 内容记忆库（data/event-memory.json） ----------

export interface EventMemoryStoreOpts {
  /** 便于单测隔离；默认 process.cwd()。 */
  baseDir?: string;
  /** 清理时参照的「今天」YYYY-MM-DD；默认取当前日期。 */
  today?: string;
}

function resolveMemoryPath(opts: EventMemoryStoreOpts): string {
  return path.resolve(opts.baseDir ?? root(), "data/event-memory.json");
}

/**
 * 读取记忆库；文件缺失/损坏/版本不符一律返回空库（不打断主流程）。
 * 绝不因读取失败而抛错——记忆层是**增强**，不是主链路。
 */
export function loadEventMemory(opts: EventMemoryStoreOpts = {}): EventMemoryStore {
  const raw = readJsonSync(resolveMemoryPath(opts));
  return reviveEventMemory(raw);
}

/**
 * ipoVoicing「并集写」防丢更新（2026-09-16）。
 *
 * 背景：`ipoVoicing`（企业 → 已口播日期数组）是**只增日志**（超期项由 recordIpoVoicing 按
 * IPO_VOICE_PRUNE_DAYS 裁剪），但写盘是「读旧文件 → 内存里追加 → 整体覆盖」。
 * 在「同一天有多个 run 写同一份记忆」时，后写的会抹掉先写的（实证：09-15 20:32 记录的
 * 优邦科技 09-15，37 秒后被另一条线覆盖成缺失，仅靠 git 合并侥幸救回；后续该企业的
 * 窗口计数从 2 掉到 1 → 本该跳过却重复口播）。
 *
 * 修法：落盘前把**磁盘上已有的日期做并集**再写 —— 任何写者都不可能再抹掉别人记录的日期。
 * 并集对「只增日志」语义完全等价（幂等、与写入顺序无关），且不需要额外裁剪：
 * 超窗日期不参与 `ipoShouldSkip` 判定，且会在该企业下次 recordIpoVoicing 时被正常裁掉。
 * 注意：`events`（最新状态语义）/`today`（本次运行真相）/`deliveries`（按日唯一）**不参与**并集。
 */
function unionIpoVoicingWithDisk(store: EventMemoryStore, memoryPath: string): EventMemoryStore {
  const onDisk = reviveEventMemory(readJsonSync(memoryPath)).ipoVoicing ?? {};
  const companies = Object.keys(onDisk);
  if (companies.length === 0) return store;
  const merged: Record<string, string[]> = { ...(store.ipoVoicing ?? {}) };
  for (const company of companies) {
    merged[company] = [...new Set([...(merged[company] ?? []), ...onDisk[company]])].sort();
  }
  return { ...store, ipoVoicing: merged };
}

/** 写入记忆库（先并集 ipoVoicing、再清理、后落盘；写盘失败静默忽略）。 */
export function saveEventMemory(
  store: EventMemoryStore,
  opts: EventMemoryStoreOpts = {},
): void {
  try {
    const memoryPath = resolveMemoryPath(opts);
    const today =
      opts.today ??
      new Intl.DateTimeFormat("en-CA", {
        timeZone: REPORT_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
    const unioned = unionIpoVoicingWithDisk(store, memoryPath);
    const cleaned = prepareEventMemory(unioned, today, MEMORY_RETAIN_DAYS);
    writeJsonSync(memoryPath, cleaned);
  } catch {
    // 归档失败不打断主流程
  }
}

// ---------- 执行摘要归档（history/<date>/store.json） ----------

/**
 * 执行摘要跨运行归档（gzinfo 2026-08-20；文件名 2026-08-20 改 store.json）。
 *
 * 背景：data/ai-assets/store.json 被 .gitignore 排除、CI 不提交，SKIP_AI 复用
 * 在 CI 里每次 runner 都是空 {}。解法：当天生成的执行摘要归档到 history/<date>/store.json
 * （随报告一起提交进 main），SKIP_AI / 正常模式重跑时优先从该文件复用，
 * 实现真正的零 LLM 成本重跑。baseDir 参数便于单测隔离（默认 process.cwd()）。
 */
export function writeExecStore(
  date: string,
  exec: ExecutiveSummary,
  opts: { baseDir?: string } = {},
): void {
  try {
    const dir = path.resolve(opts.baseDir ?? root(), "history", date);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "store.json"),
      JSON.stringify({ date, updatedAt: new Date().toISOString(), executive: exec }, null, 2),
      "utf8",
    );
  } catch {
    // 归档失败不打断主流程
  }
}

/**
 * 读取 history/<date>/store.json；缺失或损坏返回 undefined。
 * 过渡兼容：若 store.json 不存在，再尝试读旧的 executive.json（一次性迁移后即可删）。
 */
export function loadExecStore(
  date: string,
  opts: { baseDir?: string } = {},
): ExecutiveSummary | undefined {
  const dir2 = path.resolve(opts.baseDir ?? root(), "history", date);
  for (const name of ["store.json", "executive.json"]) {
    try {
      const p = path.join(dir2, name);
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      const exec = raw?.executive;
      if (exec && Array.isArray(exec.must_read) && Array.isArray(exec.insights))
        return exec as ExecutiveSummary;
    } catch {
      // 尝试下一个候选文件名
    }
  }
  return undefined;
}

// ---------- 股市复盘 / 股市清单归档（history/<date>/store.json 的字段级读写） ----------

/**
 * 读改写 history/<date>/store.json：保留 executive 等既有字段，写入 stock_recap。
 * 与 writeExecStore 互补——两者都对该文件做 read-modify-write，调用顺序无关
 * （谁先谁后都不会覆盖对方的字段）。gzinfo ai/stock-recap.ts 同款。
 */
export function writeStockRecapStore(
  date: string,
  recap: StockRecap,
  opts: { baseDir?: string } = {},
): void {
  modifyStoreField(date, "stock_recap", recap, opts);
}

/** 读取 history/<date>/store.json 的 stock_recap 字段；缺失或损坏返回 undefined。 */
export function loadStockRecapStore(
  date: string,
  opts: { baseDir?: string } = {},
): StockRecap | undefined {
  const obj = readStoreObject(date, opts);
  const r = obj?.stock_recap as StockRecap | undefined;
  if (r && r.us && r.aShare && r.hk) return r;
  return undefined;
}

/** 读改写 store.json：写入 stock_news（AI 归纳结果），随 SKIP_AI 复用。 */
export function writeStockNewsStore(
  date: string,
  items: StockNewsItem[],
  opts: { baseDir?: string } = {},
): void {
  modifyStoreField(date, "stock_news", items, opts);
}

/** 读取 history/<date>/store.json 的 stock_news；缺失/损坏返回 undefined。 */
export function loadStockNewsStore(
  date: string,
  opts: { baseDir?: string } = {},
): StockNewsItem[] | undefined {
  const obj = readStoreObject(date, opts);
  const arr = obj?.stock_news;
  if (Array.isArray(arr) && arr.length > 0) return arr as StockNewsItem[];
  return undefined;
}

function storeJsonPath(date: string, opts: { baseDir?: string }): string {
  return path.resolve(opts.baseDir ?? root(), "history", date, "store.json");
}

/** 读取 store.json 为对象（缺失/损坏 → undefined）；不抛错（归档层不阻断主流程）。 */
function readStoreObject(date: string, opts: { baseDir?: string }): Record<string, unknown> | undefined {
  try {
    const raw = readJsonSync(storeJsonPath(date, opts));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  } catch {
    // 忽略损坏
  }
  return undefined;
}

/** 字段级写回（read-modify-write；写盘失败静默忽略）。 */
function modifyStoreField(
  date: string,
  key: string,
  value: unknown,
  opts: { baseDir?: string },
): void {
  try {
    const obj: Record<string, unknown> = readStoreObject(date, opts) ?? {};
    obj.date = date;
    obj.updatedAt = new Date().toISOString();
    obj[key] = value;
    writeJsonSync(storeJsonPath(date, opts), obj);
  } catch {
    // 归档失败不打断主流程
  }
}

/** 测试/工具用：确保空库形状可得（与 gzinfo emptyMemory 对齐的导出转发）。 */
export { emptyMemory };
