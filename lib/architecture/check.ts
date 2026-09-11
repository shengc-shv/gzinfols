/**
 * 架构门禁：机器可执行的端口/适配器结构约束。
 *
 * 规则：
 *  - lib/services/** 不得直接 import 适配器（../adapters / ../../adapters）或 node: 内置模块；
 *    服务只允许依赖 lib/contracts（端口）与同服务子模块，副作用一律经端口透传。
 *  - lib/contracts/** 不得依赖 services / adapters（契约层零逻辑、零副作用）。
 *  - lib/orchestrator 与 lib/pipeline 是唯一允许装配适配器的地方（组合根）。
 *
 * 由 scripts/architecture-check.ts 与 tests/architecture-gate.test.ts 调用。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (e.endsWith(".ts")) out.push(full);
  }
  return out;
}

function importSpecifiers(src: string): string[] {
  const specs: string[] = [];
  const fromRe = /from\s+["']([^"']+)["']/g;
  const sideRe = /import\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(src))) specs.push(m[1]);
  while ((m = sideRe.exec(src))) specs.push(m[1]);
  return specs;
}

export function checkArchitecture(rootDir = process.cwd(), libRel = "lib"): string[] {
  const violations: string[] = [];
  const libRoot = join(rootDir, libRel);
  for (const f of walk(libRoot)) {
    const rel = relative(rootDir, f);
    const src = readFileSync(f, "utf8");
    const specs = importSpecifiers(src);
    const isService = rel.startsWith("lib/services/");
    const isContract = rel.startsWith("lib/contracts/");

    if (isService) {
      for (const s of specs) {
        if (
          s === "../adapters" ||
          s.endsWith("/adapters") ||
          s.startsWith("../adapters/") ||
          s.startsWith("../../adapters") ||
          s.startsWith("node:")
        ) {
          violations.push(`${rel}: 服务层禁止直接依赖副作用实现（${s}），请改用契约端口`);
        }
      }
    }
    if (isContract) {
      for (const s of specs) {
        if (s.includes("/services/") || s.includes("/adapters/")) {
          violations.push(`${rel}: 契约层禁止依赖服务/适配器（${s}）`);
        }
      }
    }
  }
  return violations;
}
