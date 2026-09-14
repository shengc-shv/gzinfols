/**
 * 红筹快照与变更日志存储适配器（唯一 IO 出口之一）。
 *
 * 布局：
 *   data/redchip/latest.json          —— 最新快照（展示层直接读）
 *   data/redchip/snapshots/<date>.json—— 按次归档快照
 *   data/redchip/changelog.jsonl      —— append-only 变更日志（可追溯）
 */
import fs from "node:fs";
import path from "node:path";
import type { RedchipChange, RedchipSnapshot } from "../../contracts/redchip";
import { REDCHIP_CHANGELOG_PATH, REDCHIP_DIR, REDCHIP_LATEST_PATH } from "../../contracts/redchip";

let overrideDir: string | undefined;
/** 测试隔离：把仓库根指向临时目录。 */
export function setRedchipBaseDir(dir: string | undefined): void {
  overrideDir = dir;
}
function resolve(p: string): string {
  return path.resolve(overrideDir ?? process.cwd(), p);
}

export function readLatest(): RedchipSnapshot | null {
  const p = resolve(REDCHIP_LATEST_PATH);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as RedchipSnapshot;
  } catch {
    return null;
  }
}

export function writeLatest(snap: RedchipSnapshot): void {
  const dir = resolve(REDCHIP_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolve(REDCHIP_LATEST_PATH), JSON.stringify(snap, null, 2) + "\n", "utf8");
}

export function writeDatedSnapshot(snap: RedchipSnapshot, date: string): void {
  const dir = resolve(path.join(REDCHIP_DIR, "snapshots"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(snap, null, 2) + "\n", "utf8");
}

/** append-only 追加变更（每行一条 JSON）。 */
export function appendChanges(changes: RedchipChange[]): void {
  if (changes.length === 0) return;
  const dir = resolve(REDCHIP_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    resolve(REDCHIP_CHANGELOG_PATH),
    changes.map((c) => JSON.stringify(c)).join("\n") + "\n",
    "utf8",
  );
}

export function readChanges(): RedchipChange[] {
  const p = resolve(REDCHIP_CHANGELOG_PATH);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RedchipChange);
}
