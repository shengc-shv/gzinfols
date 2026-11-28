/**
 * 经营重点配置文件读取（二期 WP1）。
 *
 * 分层：本文件只做 IO（**绝不抛错阻断管线**），归一化/合并规则在
 * `lib/services/business-focus/config-loader.ts`（纯函数）。
 *
 * 三态口径沿 `adapters/research/ledger-store.ts`（P17 同类教训）：
 *   ok      = 文件在且能解析
 *   missing = 文件不存在（首跑或该层未启用）
 *   corrupt = 文件在但读不懂（**必须与「该层没配置」区分开**，否则管理者会把
 *             一个坏 JSON 当成「这季度没重点」而永远查不出来）
 */
import fs from "node:fs";
import path from "node:path";
import type { FocusFileInput, FocusLayer } from "../../services/business-focus/types";

/** 三类配置的默认路径（相对仓库根）。 */
export const FOCUS_CONFIG_FILES: ReadonlyArray<{ layer: FocusLayer; file: string }> = [
  { layer: "annual", file: "config/annual-focus.json" },
  { layer: "quarterly", file: "config/quarterly-focus.json" },
  { layer: "temporary", file: "config/temporary-focus.json" },
];

/**
 * 读取三类经营重点配置。
 * @param root 仓库根目录（仅测试注入用，生产走 process.cwd()）
 */
export function readFocusConfigFiles(root: string = process.cwd()): FocusFileInput[] {
  return FOCUS_CONFIG_FILES.map(({ layer, file }) => {
    const abs = path.resolve(root, file);
    let raw: string;
    try {
      raw = fs.readFileSync(abs, "utf8");
    } catch {
      return { file, layer, state: "missing" as const };
    }
    try {
      return { file, layer, state: "ok" as const, data: JSON.parse(raw) as unknown };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { file, layer, state: "corrupt" as const, error: msg };
    }
  });
}
