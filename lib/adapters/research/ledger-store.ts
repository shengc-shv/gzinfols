/**
 * 研报台账读写（`data/research-ledger.json`）。
 *
 * 2026-10-19 sc 口径：主题与研报都是「独立 + 全量」→ **固定路径**、每次并集更新。
 * 与 `data/topics-corpus.json` / `data/redchip/` 同模式：文件入库、随 daily 提交回 main，
 * 不依赖 `history/` 的 7 天保留期。
 *
 * 分层：本文件只做 IO（read 失败回落空台账，绝不抛错阻断管线）；
 * 合并规则在 `lib/services/research/ledger.ts`（纯函数）。
 */
import fs from "node:fs";
import path from "node:path";
import type { ResearchLedger } from "../../contracts/research";

const FILE = path.resolve("data/research-ledger.json");

function empty(): ResearchLedger {
  return { version: 1, updatedAt: "", items: [] };
}

/** 读台账：文件不存在 / 坏 JSON / 结构不符 → 空台账（首次运行、本地干净环境）。 */
export function readResearchLedger(): ResearchLedger {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8")) as Partial<ResearchLedger>;
    if (!Array.isArray(j.items)) return empty();
    return { version: 1, updatedAt: String(j.updatedAt ?? ""), items: j.items };
  } catch {
    return empty();
  }
}

/** 写台账（紧凑 JSON，控制仓库体积）。失败由调用方决定是否降级 —— 本函数会抛出。 */
export function writeResearchLedger(ledger: ResearchLedger): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(ledger), "utf8");
}
