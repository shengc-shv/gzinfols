/**
 * 架构门禁：机器可执行的端口/适配器结构约束。
 *
 * 规则：
 *  - lib/services/** 不得直接 import 适配器（../adapters / ../../adapters）或 node: 内置模块；
 *    服务只允许依赖 lib/contracts（端口）与同服务子模块，副作用一律经端口透传。
 *  - lib/contracts/** 不得依赖 services / adapters（契约层零逻辑、零副作用）。
 *  - lib/orchestrator 与 lib/pipeline 是唯一允许装配适配器的地方（组合根）。
 *
 * 2026-09-14 补盲区（P0-4）：本门禁此前只看 import 说明符，**看不见**两类同样致命的违规：
 *  ① 服务层直读 `process.env` —— 配置必须由组合根读进 `ctx.config`；
 *  ② 服务层隐式时钟 `Date.now()` / `new Date()` —— 时间必须由 `ctx.startTime` / 报告日注入。
 *  实测这两类在渲染层真实发生过回归（`full.ts` 的 REPORT_BASE_URL / WEB_MODE / new Date()）。
 *  其中 `new Date()` 尚有若干「可注入默认参数」存量（`now: Date = new Date()`），
 *  故采用**棘轮**策略：记录基线数量，只禁止增长，不要求一次性清零。
 *
 * 由 scripts/architecture-check.ts 与 tests/architecture-gate.test.ts 调用。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * 服务层裸 `new Date()` 允许量（2026-09-14 C-3 起为 **0 = 绝对禁止**，棘轮已升为硬禁）。
 *
 * 语义：服务层**不得**隐式读系统时钟。时间一律由调用方注入
 * （`ctx.startTime` / 显式参数）；「可注入默认参数」（如 `now: Date = new Date()`）
 * 同样不允许 —— 默认值就是隐式时钟，会让「同一输入跑两次」产出不同结果。
 *
 * 收敛记录（2026-09-14 C-3，原存量 11 处全部归零）：
 *   collect/providers.ts×3（fetchedAt，改由 `collect` 从 `ctx.startTime` 注入）
 *   memory/history.ts×3 · memory/broadcast-time.ts×1 · memory/event-memory.ts×1
 *   （`broadcastAt` 改必填，由 exec-guard 用注入时刻换算）
 *   normalize/crawl.ts×1 · enrich/exec-pool.ts×2 · market/commentary.ts×1
 */
const NEW_DATE_BASELINE = 0;

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

/**
 * 去掉注释，避免「注释里提到 process.env / Date.now()」被误判
 * （实测 `locale.ts` / `gd-ipo-spoken.ts` 的文档注释都提到过这些词）。
 * 先剥块注释（含多行），再剥行注释。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

export interface ArchitectureReport {
  violations: string[];
  /** 服务层裸 new Date() 存量（棘轮观测值，非违规）。 */
  newDateCount: number;
}

export function checkArchitectureDetailed(
  rootDir = process.cwd(),
  libRel = "lib",
): ArchitectureReport {
  const violations: string[] = [];
  let newDateCount = 0;
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
      const code = stripComments(src);
      // 补盲区 ①：服务层直读 env（配置一律经 ctx.config 注入）
      const envLine = code.split("\n").findIndex((l) => /process\.env\b/.test(l)) + 1;
      if (envLine > 0) {
        violations.push(
          `${rel}:${envLine}: 服务层禁止直读 process.env，配置请由组合根读入 ctx.config 后注入`,
        );
      }
      // 补盲区 ②：服务层隐式时钟
      const nowLine = code.split("\n").findIndex((l) => /\bDate\.now\s*\(/.test(l)) + 1;
      if (nowLine > 0) {
        violations.push(`${rel}:${nowLine}: 服务层禁止 Date.now()，时间请由 ctx.startTime / 参数注入`);
      }
      // 裸 new Date()（无参数）——棘轮：只禁止增长
      newDateCount += (code.match(/new Date\(\s*\)/g) ?? []).length;
    }
    if (isContract) {
      for (const s of specs) {
        if (s.includes("/services/") || s.includes("/adapters/")) {
          violations.push(`${rel}: 契约层禁止依赖服务/适配器（${s}）`);
        }
      }
    }
  }

  if (newDateCount > NEW_DATE_BASELINE) {
    violations.push(
      `服务层裸 new Date() 数量 ${newDateCount} 超基线 ${NEW_DATE_BASELINE}：` +
        `新增代码请注入时间（ctx.startTime / 参数），不要增加隐式时钟`,
    );
  }

  return { violations, newDateCount };
}

export function checkArchitecture(rootDir = process.cwd(), libRel = "lib"): string[] {
  return checkArchitectureDetailed(rootDir, libRel).violations;
}
