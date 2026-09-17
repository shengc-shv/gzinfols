/**
 * 本地专供「上市字典」冻结快照（仿 `lib/adapters/local-ipo.ts`，2026-09-17）。
 *
 * 要解决的问题：`listed-check`（候选复核 / 广东已上市发现）依赖三所上市列表接口，
 * 其中**深交所 `www.szse.cn` 在 GitHub 海外 runner 上 `fetch failed`**（2026-09-17 实测：
 * 本机国内直连 200 且数据完整，CI 恒失败），导致线上字典长期为空 →
 * 「广东候选升级为已上市」能力静默失效 + 每日一条新鲜度告警刷屏。
 *
 * 方案（用户待办 T1-B 方案①）：本地每日抓一次 → 产出 `data/local-listed.json`（入库）→
 * 远端读取与在线结果合并（在线优先）。文件只是**兜底**，在线可用时完全不依赖它。
 *
 * 红线遵守：
 *  - 时间真实性：快照里的每条记录都必须自带官方 `listedDate`（无日期的条目在采集端
 *    就被丢弃），本模块**不做任何「用抓取日兜底」**；
 *  - 时区：窗口比较一律用 YYYY-MM-DD 字符串比大小（cutoff 由调用方按北京时间算出），
 *    本模块不引入任何时钟读取；
 *  - 只做「文件读写 + 合并 + 可观测性」，不含自有过滤规则（与 local-ipo 同纪律）。
 */
import fs from "node:fs";
import path from "node:path";

/** 快照文件路径（相对仓库根，随代码提交；CI checkout 后可直接读到）。 */
export const LOCAL_LISTED_PATH = path.resolve(process.cwd(), "data/local-listed.json");

/** 文件格式版本（结构变更时递增，读取端据此拒绝不兼容文件）。 */
export const LOCAL_LISTED_VERSION = 1;

/** 文件产出者标识（写入端固定填此值，便于排查文件来源）。 */
export const LOCAL_LISTED_GENERATOR = "local-listed-sync";

/** 超过此天数未更新 → 告警「本地同步可能已中断」（条目仍按窗口使用）。 */
export const LOCAL_LISTED_STALE_DAYS = 3;

export type ListingExchange = "SSE" | "SZSE" | "BSE";

/** 与 `lib/adapters/crawlers/sources/listed-check.ts` 的 Listing 结构等价（刻意不 import，避免耦合）。 */
export interface StoredListing {
  code: string;
  name: string;
  /** 官方上市日期 YYYY-MM-DD（无日期的条目在采集端已丢弃）。 */
  listedDate: string;
  exchange: ListingExchange;
  area?: string;
}

export interface LocalListedFile {
  version: number;
  /** 本地抓取完成时刻（ISO 8601 含时区）。 */
  fetchedAt: string;
  generator: string;
  /** 写入时使用的窗口口径（天），供读取端自证两边口径一致。 */
  windowDays: number;
  /** 按交易所统计条数（确定性输出，便于 git diff 稳定）。 */
  counts: Record<string, number>;
  listings: StoredListing[];
}

export interface ReadLocalListedResult {
  file: LocalListedFile | null;
  reason?: string;
}

/** 读取快照文件（容错）：不存在 / JSON 坏 / 版本不符 / 结构非法 → { file: null, reason }。 */
export function readLocalListedFile(filePath: string = LOCAL_LISTED_PATH): ReadLocalListedResult {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { file: null, reason: "文件不存在" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { file: null, reason: "JSON 解析失败" };
  }
  const f = parsed as Partial<LocalListedFile>;
  if (!f || typeof f !== "object") return { file: null, reason: "顶层不是对象" };
  if (f.version !== LOCAL_LISTED_VERSION) {
    return {
      file: null,
      reason: `格式版本不符（文件 ${String(f.version)} ≠ 期望 ${LOCAL_LISTED_VERSION}）`,
    };
  }
  if (!Array.isArray(f.listings)) return { file: null, reason: "listings 不是数组" };
  return {
    file: {
      version: LOCAL_LISTED_VERSION,
      fetchedAt: typeof f.fetchedAt === "string" ? f.fetchedAt : "",
      generator: typeof f.generator === "string" ? f.generator : "",
      windowDays: typeof f.windowDays === "number" ? f.windowDays : 0,
      counts: (f.counts && typeof f.counts === "object" ? f.counts : {}) as Record<string, number>,
      listings: f.listings as StoredListing[],
    },
  };
}

/** 原子写（先写 .tmp 再 rename）：避免 CI 读到半截文件。 */
export function writeLocalListedFile(
  file: LocalListedFile,
  filePath: string = LOCAL_LISTED_PATH,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

/** 文件新鲜度（天）；fetchedAt 缺失/非法 → null。 */
export function localListedStalenessDays(fetchedAt: string, now: Date): number | null {
  const t = Date.parse(fetchedAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

/** 按交易所统计（确定性输出）。 */
export function countByExchange(items: StoredListing[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) out[it.exchange] = (out[it.exchange] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** 合法记录判定：代码/名称/官方上市日期三者齐备（时间真实性红线）。 */
export function isValidListing(it: Partial<StoredListing>): it is StoredListing {
  return Boolean(
    it &&
      typeof it.code === "string" &&
      it.code.trim() !== "" &&
      typeof it.name === "string" &&
      it.name.trim() !== "" &&
      typeof it.listedDate === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(it.listedDate),
  );
}

/**
 * 本地写入端：把本轮抓到的记录与文件里**仍在窗口内**的旧记录合并成快照。
 *
 * 保留旧记录（而非每轮覆盖）= 给「本地抓取抖动」加缓冲；同代码冲突取上市日期较新者；
 * 确定性排序（listedDate 倒序 → code）使每日 commit 的 diff 只含真实增量。
 */
export function buildLocalListedSnapshot(
  crawled: StoredListing[],
  opts: {
    prev?: LocalListedFile | null;
    windowDays?: number;
    cutoff?: string;
    fetchedAt?: string;
    generator?: string;
  } = {},
): { file: LocalListedFile; stats: { newValid: number; newInvalid: number; prevUsed: number; total: number } } {
  const windowDays = opts.windowDays ?? 0;
  const cutoff = opts.cutoff ?? "";
  const fresh = crawled.filter(isValidListing);
  const prev = (opts.prev?.listings ?? []).filter(isValidListing);

  const byCode = new Map<string, StoredListing>();
  let prevUsed = 0;
  for (const it of [...prev, ...fresh]) {
    if (cutoff && it.listedDate < cutoff) continue; // 超窗不入库（窗口由调用方按北京时间给出）
    const old = byCode.get(it.code);
    if (!old) {
      byCode.set(it.code, it);
      if (prev.includes(it)) prevUsed++;
      continue;
    }
    if (it.listedDate >= old.listedDate) byCode.set(it.code, it);
  }

  const listings = [...byCode.values()].sort((a, b) => {
    if (a.listedDate !== b.listedDate) return b.listedDate.localeCompare(a.listedDate);
    return a.code.localeCompare(b.code);
  });

  const file: LocalListedFile = {
    version: LOCAL_LISTED_VERSION,
    fetchedAt: opts.fetchedAt ?? "",
    generator: opts.generator ?? LOCAL_LISTED_GENERATOR,
    windowDays,
    counts: countByExchange(listings),
    listings,
  };
  return {
    file,
    stats: {
      newValid: fresh.length,
      newInvalid: crawled.length - fresh.length,
      prevUsed,
      total: listings.length,
    },
  };
}

/**
 * 远端接入端：把快照中仍在窗口内的记录**补进**在线字典（在线优先）。
 *
 * @returns 本地补位的条数，以及文件是否过期（供调用方决定告警级别）。
 */
export function mergeLocalListings(
  into: Map<string, StoredListing>,
  opts: { filePath?: string; cutoff?: string; now: Date },
): { added: number; staleDays: number | null; reason?: string } {
  const cutoff = opts.cutoff ?? "";
  const { file, reason } = readLocalListedFile(opts.filePath);
  if (!file) return { added: 0, staleDays: null, reason };
  const staleDays = localListedStalenessDays(file.fetchedAt, opts.now);
  let added = 0;
  for (const it of file.listings) {
    if (!isValidListing(it)) continue;
    if (cutoff && it.listedDate < cutoff) continue;
    if (into.has(it.code)) continue; // 在线优先
    into.set(it.code, it);
    added++;
  }
  return { added, staleDays };
}
