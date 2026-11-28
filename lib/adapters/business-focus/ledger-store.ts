/**
 * 经营重点台账 / 版本归档读写（二期 WP7）。
 *
 * 两个文件，都是**固定路径 + 入库 + 随 daily 提交回 main**（与 `data/research-ledger.json`
 * 同模式）：
 *   `data/focus-ledger.json`   每日命中（专题页跨期聚合的唯一数据源）
 *   `data/focus/versions.json` 配置版本归档（追溯「当时那条重点是怎么定义的」）
 *
 * 分层：本文件只做 IO（**绝不抛错阻断管线**）；合并规则在
 * `services/business-focus/ledger.ts`（纯函数）。
 *
 * 🔴 三态口径（P17 同类教训，`research/ledger-store` 实锤过一次静默清空）：
 *   ok      = 能读能解析，在其基础上合并；
 *   missing = 文件不存在（首跑），允许在空台账上合并写回；
 *   corrupt = 文件在但读不懂 → 调用方**必须拒绝写回**，原文件原样保留等人工处理。
 * 早版本的经验：读失败一律回落空台账再写回 = 历史被静默清空，日志还会报「新增 N 条」。
 *
 * 路径参数化：所有函数都收 `file`，因为 `path.resolve` 在 import 时求值，
 * 测试里改 cwd 也来不及（`research/ledger-store` 踩过同一个坑）。
 */
import fs from "node:fs";
import path from "node:path";
import type { FocusLedger, FocusVersionArchive } from "../../contracts/focus-ledger";

const LEDGER_FILE = path.resolve("data/focus-ledger.json");
const VERSIONS_FILE = path.resolve("data/focus/versions.json");

/** ok = 正常；missing = 文件不存在（首跑）；corrupt = 文件在但读不懂（禁止写回）。 */
export type FocusLedgerState = "ok" | "missing" | "corrupt";

export interface FocusLedgerRead<T> {
  state: FocusLedgerState;
  data: T;
  /** 仅 corrupt 时有值（含文件路径与解析错误），供调用方告警。 */
  error?: string;
}

function readJson<T extends { version: 1; updatedAt: string }>(
  file: string,
  empty: () => T,
  /** 结构校验：拿不到应有关键数组即视为 corrupt（半写截断常表现为字段缺失）。 */
  check: (j: Partial<T>) => boolean,
): FocusLedgerRead<T> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { state: "missing", data: empty() };
  }
  try {
    const j = JSON.parse(raw) as Partial<T>;
    if (!check(j)) {
      return { state: "corrupt", data: empty(), error: `${file}：结构不完整（缺少关键数组）` };
    }
    return { state: "ok", data: { ...(j as T), version: 1, updatedAt: String(j.updatedAt ?? "") } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { state: "corrupt", data: empty(), error: `${file}：${msg}` };
  }
}

/** 读命中台账（三态）。 */
export function readFocusLedger(file: string = LEDGER_FILE): FocusLedgerRead<FocusLedger> {
  return readJson<FocusLedger>(file, () => ({ version: 1, updatedAt: "", days: [] }), (j) =>
    Array.isArray(j.days),
  );
}

/** 写命中台账（紧凑 JSON 控体积）。失败由调用方决定降级 —— 本函数会抛出。 */
export function writeFocusLedger(ledger: FocusLedger, file: string = LEDGER_FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ledger), "utf8");
}

/** 读版本归档（三态）。 */
export function readVersionArchive(file: string = VERSIONS_FILE): FocusLedgerRead<FocusVersionArchive> {
  return readJson<FocusVersionArchive>(
    file,
    () => ({ version: 1, updatedAt: "", versions: [] }),
    (j) => Array.isArray(j.versions),
  );
}

export function writeVersionArchive(archive: FocusVersionArchive, file: string = VERSIONS_FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(archive), "utf8");
}
