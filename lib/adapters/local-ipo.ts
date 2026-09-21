/**
 * 本地专供 IPO 补数桥（自 gzinfo lib/sources/local-ipo.ts 逐字移植，2026-09-11 方案）。
 *
 * 要解决的问题：csrcfd（证监会辅导）与深交所 www.szse.cn 被 CDN/WAF 拦 GitHub runner
 * 海外出口 IP（CI 恒 405 / fetch failed），只能本地抓。本地每日跑 `npm run ipo:local`
 * 产出 data/local-ipo.json（入库）→ 远端 cron 读取补数，与在线抓取拼成完整全貌。
 *
 * 统一处理（关键红线）：「丢无日期 / 裁窗口 / 按 URL 去重」只有一份实现
 * normalizeLocalIpoItems()（lib/services/normalize/crawl.ts）——本地写入与远端读取都调它，
 * 两边逻辑不可能漂移。本模块只负责「文件读写 + 合并 + 可观测性」，不含自有过滤规则。
 *
 * 安全边界：sourceId 必须 ∈ LOCAL_ONLY_IPO_SOURCE_IDS 白名单，否则丢弃并告警；
 * 文件 fetchedAt 超 LOCAL_IPO_STALE_DAYS 天打告警（本地同步可能中断），条目仍按窗口使用。
 */
import fs from "node:fs";
import path from "node:path";
import type { CrawledArticle } from "../contracts/article";
import { normalizeLocalIpoItems } from "../services/normalize/crawl";
import { IPO_SOURCE_WINDOW_DAYS } from "../ipo-config";

/** 补数文件路径（相对仓库根，随代码提交；CI checkout 后可直接读到）。 */
export const LOCAL_IPO_PATH = path.resolve(process.cwd(), "data/local-ipo.json");

/** 文件格式版本（结构变更时递增，读取端据此拒绝不兼容文件）。 */
export const LOCAL_IPO_VERSION = 1;

/** 文件产出者标识（写入端固定填此值，便于排查文件来源）。 */
export const LOCAL_IPO_GENERATOR = "local-ipo-sync";

/** 超过此天数未更新 → 告警「本地同步可能已中断」。 */
export const LOCAL_IPO_STALE_DAYS = 2;

/** 只能本地抓到的 IPO 源 sourceId 白名单（唯一权威清单），与 buildLocalOnlyIpoCrawlers 一一对应。
 *  2026-09-21 新增 `gd-sse-audit`（上交所审核项目动态）：CI 2026-09-21 起全挂
 *  （`query.sse.com.cn` 全部 market/status 组合 × 4 次重试均 fetch failed），而本机 curl 200/0.3s
 *  —— 与深交所/证监会同因（地域 CDN/WAF），故并入本地补数。 */
export const LOCAL_ONLY_IPO_SOURCE_IDS = ["gd-csrc-tutoring", "gd-szse-audit", "gd-sse-audit"] as const;

export interface LocalIpoFile {
  version: number;
  /** 本地抓取完成时刻（ISO 8601 含时区）。 */
  fetchedAt: string;
  generator: string;
  /** 写入时使用的窗口口径（天），供读取端自证两边口径一致。 */
  windowDays: number;
  sourceCounts: Record<string, number>;
  items: CrawledArticle[];
}

export interface ReadLocalIpoResult {
  file: LocalIpoFile | null;
  reason?: string;
}

/** 读取补数文件（容错）：不存在 / JSON 坏 / 版本不符 / 结构非法 → { file: null, reason }。 */
export function readLocalIpoFile(filePath: string = LOCAL_IPO_PATH): ReadLocalIpoResult {
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
  const f = parsed as Partial<LocalIpoFile>;
  if (!f || typeof f !== "object") return { file: null, reason: "顶层不是对象" };
  if (f.version !== LOCAL_IPO_VERSION) {
    return { file: null, reason: `格式版本不符（文件 ${String(f.version)} ≠ 期望 ${LOCAL_IPO_VERSION}）` };
  }
  if (!Array.isArray(f.items)) return { file: null, reason: "items 不是数组" };
  return {
    file: {
      version: LOCAL_IPO_VERSION,
      fetchedAt: typeof f.fetchedAt === "string" ? f.fetchedAt : "",
      generator: typeof f.generator === "string" ? f.generator : "",
      windowDays: typeof f.windowDays === "number" ? f.windowDays : IPO_SOURCE_WINDOW_DAYS,
      sourceCounts: (f.sourceCounts && typeof f.sourceCounts === "object" ? f.sourceCounts : {}) as Record<string, number>,
      items: f.items as CrawledArticle[],
    },
  };
}

/** 原子写（先写 .tmp 再 rename）：避免 CI 读到半截文件。 */
export function writeLocalIpoFile(file: LocalIpoFile, filePath: string = LOCAL_IPO_PATH): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

/** 文件新鲜度（天）；fetchedAt 缺失/非法 → null。 */
export function localIpoStalenessDays(fetchedAt: string, now: Date = new Date()): number | null {
  const t = Date.parse(fetchedAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

/** 按 sourceId 统计条目数（确定性输出，便于 git diff 稳定）。 */
export function countBySource(items: CrawledArticle[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = it.sourceId || "(无 sourceId)";
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * 本地写入端：把本轮新抓的条目与文件里仍在窗口内的旧条目合并成快照。
 * 保留旧条目（而非每轮覆盖）= 给「本地抓取抖动」加缓冲；冲突取 publishedAt 较新者；
 * 确定性排序（publishedAt 倒序 → sourceId → url）使每日 commit 的 diff 只含真实增量。
 */
export function buildLocalIpoSnapshot(
  crawled: CrawledArticle[],
  opts: {
    prev?: LocalIpoFile | null;
    now?: Date;
    windowDays?: number;
    fetchedAt?: string;
    generator?: string;
  } = {},
): {
  file: LocalIpoFile;
  stats: {
    newRaw: number;
    newNormalized: number;
    prevUsed: number;
    total: number;
    droppedNoDate: number;
    droppedOutOfWindow: number;
    droppedDuplicate: number;
  };
} {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? IPO_SOURCE_WINDOW_DAYS;

  const fresh = normalizeLocalIpoItems(crawled, { windowDays, now });
  const prev = normalizeLocalIpoItems(opts.prev?.items ?? [], { windowDays, now });

  const byKey = new Map<string, CrawledArticle>();
  const keyOf = (it: CrawledArticle) =>
    it.url?.trim() || `${it.sourceId ?? ""}|${it.title ?? ""}`;
  for (const it of [...prev.items, ...fresh.items]) {
    const k = keyOf(it);
    const old = byKey.get(k);
    if (!old) {
      byKey.set(k, it);
      continue;
    }
    const a = Date.parse(old.publishedAt || "") || 0;
    const b = Date.parse(it.publishedAt || "") || 0;
    if (b >= a) byKey.set(k, it);
  }

  const items = [...byKey.values()].sort((x, y) => {
    if ((y.publishedAt || "") !== (x.publishedAt || "")) {
      return (y.publishedAt || "").localeCompare(x.publishedAt || "");
    }
    if ((x.sourceId || "") !== (y.sourceId || "")) {
      return (x.sourceId || "").localeCompare(y.sourceId || "");
    }
    return (x.url || "").localeCompare(y.url || "");
  });

  const file: LocalIpoFile = {
    version: LOCAL_IPO_VERSION,
    fetchedAt: opts.fetchedAt ?? new Date(now.getTime()).toISOString(),
    generator: opts.generator ?? LOCAL_IPO_GENERATOR,
    windowDays,
    sourceCounts: countBySource(items),
    items,
  };

  return {
    file,
    stats: {
      newRaw: crawled.length,
      newNormalized: fresh.items.length,
      prevUsed: prev.items.length,
      total: items.length,
      droppedNoDate: fresh.droppedNoDate,
      droppedOutOfWindow: fresh.droppedOutOfWindow,
      droppedDuplicate: fresh.droppedDuplicate,
    },
  };
}

/**
 * 远端接入端：读取补数文件 → 共享归一化 → 与在线条目去重 → 返回「要补充的」条目。
 * 在线优先：同一 URL 若在线也抓到了，用在线的那条（更新鲜）。
 */
export function selectLocalIpoItems(
  online: CrawledArticle[],
  opts: { filePath?: string; windowDays?: number; now?: Date } = {},
): CrawledArticle[] {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? IPO_SOURCE_WINDOW_DAYS;
  const { file, reason } = readLocalIpoFile(opts.filePath);
  if (!file) {
    console.warn(
      `[local-ipo] ⚠️ 本地 IPO 补数不可用（${reason}）→ 本次深交所/上交所/证监会辅导源为 0 条。` +
        `请本地跑 \`npm run ipo:local\` 补数并推送 data/local-ipo.json。`,
    );
    return [];
  }

  const stale = localIpoStalenessDays(file.fetchedAt, now);
  if (stale !== null && stale > LOCAL_IPO_STALE_DAYS) {
    console.warn(
      `[local-ipo] ⚠️ 补数文件已 ${stale} 天未更新（>${LOCAL_IPO_STALE_DAYS} 天）→ 本地定时同步可能已中断；` +
        `本次仍使用窗口内条目。`,
    );
  }

  const allowed = new Set<string>(LOCAL_ONLY_IPO_SOURCE_IDS as readonly string[]);
  const rejected: string[] = [];
  const candidates = file.items.filter((it) => {
    const id = it.sourceId ?? "";
    if (allowed.has(id)) return true;
    rejected.push(id || "(空 sourceId)");
    return false;
  });
  if (rejected.length > 0) {
    console.warn(
      `[local-ipo] ⚠️ 丢弃 ${rejected.length} 条非白名单条目（sourceId: ${[...new Set(rejected)].join(", ")}）`,
    );
  }

  const norm = normalizeLocalIpoItems(candidates, { windowDays, now });
  const onlineUrls = new Set(online.map((it) => it.url?.trim()).filter(Boolean) as string[]);
  const additions = norm.items.filter((it) => !onlineUrls.has(it.url?.trim() ?? ""));

  const counts = countBySource(additions);
  const detail = Object.entries(counts)
    .map(([k, v]) => `${k} ${v}`)
    .join(" / ");
  console.log(
    `[local-ipo] ✅ 本地补数：文件 ${file.items.length} 条 → 窗口内 ${norm.items.length} 条 → ` +
      `新增 ${additions.length} 条${detail ? `（${detail}）` : ""}；文件抓取于 ${file.fetchedAt || "未知"}`,
  );
  if (norm.droppedNoDate || norm.droppedOutOfWindow || norm.droppedDuplicate) {
    console.log(
      `[local-ipo]    └ 裁剪：无日期 ${norm.droppedNoDate} / 超窗 ${norm.droppedOutOfWindow} / 重复 ${norm.droppedDuplicate}`,
    );
  }
  return additions;
}
