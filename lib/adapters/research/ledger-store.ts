/**
 * 研报台账读写（`data/research-ledger.json`）。
 *
 * 2026-10-19 sc 口径：主题与研报都是「独立 + 全量」→ **固定路径**、每次并集更新。
 * 与 `data/topics-corpus.json` / `data/redchip/` 同模式：文件入库、随 daily 提交回 main，
 * 不依赖 `history/` 的 7 天保留期。
 *
 * 分层：本文件只做 IO（**绝不抛错阻断管线**）；
 * 合并规则在 `lib/services/research/ledger.ts`（纯函数）。
 *
 * 🔴 2026-10-19 加固（P17 同类：失败必须与「真 0 条」区分）
 * 旧版读失败（文件不存在 / 坏 JSON / 半写截断）一律回落「空台账」，调用方合并后写回 →
 * **历史台账被静默清空**（实测：原 40 条 + 文件截断 → 写回只剩当天 1 条，日志还报「新增 1 条」）。
 * 现在按三态返回，只有 `missing`（真的没有文件）才允许在空台账上合并写回；
 * `corrupt` 由调用方**拒绝写回**，原文件原样保留，等人工处理。
 */
import fs from "node:fs";
import path from "node:path";
import type { ResearchLedger } from "../../contracts/research";

const FILE = path.resolve("data/research-ledger.json");

/** ok = 正常；missing = 文件不存在（首跑）；corrupt = 文件在但读不懂（禁止写回）。 */
export type LedgerState = "ok" | "missing" | "corrupt";

export interface LedgerRead {
  state: LedgerState;
  ledger: ResearchLedger;
  /** 仅 corrupt 时有值，供调用方告警（含文件路径与解析错误）。 */
  error?: string;
}

function empty(): ResearchLedger {
  return { version: 1, updatedAt: "", items: [] };
}

/**
 * 读台账（三态）。
 * @param file 仅测试注入用；生产走 `data/research-ledger.json`。
 */
export function readResearchLedger(file: string = FILE): LedgerRead {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    // 文件不存在 = 首跑，允许在空台账上合并
    return { state: "missing", ledger: empty() };
  }
  try {
    const j = JSON.parse(raw) as Partial<ResearchLedger>;
    if (!Array.isArray(j.items)) {
      return { state: "corrupt", ledger: empty(), error: `${file}：items 不是数组` };
    }
    return { state: "ok", ledger: { version: 1, updatedAt: String(j.updatedAt ?? ""), items: j.items } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { state: "corrupt", ledger: empty(), error: `${file}：${msg}` };
  }
}

/** 写台账（紧凑 JSON，控制仓库体积）。失败由调用方决定是否降级 —— 本函数会抛出。 */
export function writeResearchLedger(ledger: ResearchLedger, file: string = FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ledger), "utf8");
}
