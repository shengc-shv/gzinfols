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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import * as ts from "typescript";

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

/**
 * services 子域的**层级**（数字小 = 更底层、更上游）。用于依赖方向检查。
 *
 * 方向约定：`A → B` 表示 A import B。**允许「上游被下游依赖」**（如 render → classify），
 * **禁止反向**（如 memory → enrich：判重层不得依赖内容生成层）。
 *
 * 分层依据（按「被谁依赖」与「职责稳定性」划定）：
 *  - 0 基础事实层：纯词汇/分类/原始数据整形，改动应波及全仓；
 *  - 1 口径层：评分与去重口径（业务重要性的定义）；
 *  - 2 生成层：把事实加工成内容（LLM 执行摘要、股市解读）；
 *  - 3 判断层：对成品做取舍（事件判重、冷却、新颖度）；
 *  - 4 消费层：拼装与呈现（报告、页面、口播、发布）。
 */
const SERVICE_LAYERS: Record<string, number> = {
  vocab: 0,
  classify: 0,
  collect: 0,
  normalize: 0,
  metrics: 0,
  redchip: 0,
  select: 1,
  enrich: 2,
  market: 2,
  memory: 3,
  assemble: 4,
  render: 4,
  voice: 4,
  publish: 4,
};

/**
 * 依赖方向规则的**已知豁免**（每条写明原因与移除条件；⚠️ 禁止无声堆积）。
 *
 * 语义：key = `<发起文件路径>|->|<目标路径>`（**含** `lib/services/` 前缀、**文件级**、不带 `.ts`），
 * 表示「低层反向依赖高层」。**刻意不用域对**（如 `memory|->|enrich`）—— 域对级会让同方向的
 * **新**依赖搭上既有豁免的便车；文件级则每新增一处都必须显式登记（棘轮）。
 * 正常的「下游消费上游」不在此列（如 `render → enrich` 允许）。
 *
 * 现状 5 条（均为 2026-10-03 架构审查前既有，非新引入），逐条附治理方向：
 */
const DEPENDENCY_EXEMPTIONS = new Set<string>([
  // ① classify → enrich：IPO 启发式判断（`isGdIpoCandidate`）住在 enrich，被分类层复用。
  //    ⛔ 移除条件：启发式下沉到 classify 或 vocab（它本质是分类规则，不是内容生成）。
  "lib/services/classify/gd-ipo-spoken|->|lib/services/enrich/heuristics",
  // ② enrich → render：语言常量 `REPORT_LOCALE` 定义在渲染层，被摘要批量生成读取。
  //    ⛔ 移除条件：迁到 `services/vocab/locale`（该目录已存在，正是收共享词汇的地方）。
  "lib/services/enrich/batch-summaries|->|lib/services/render/locale",
  // ③④ enrich → memory：候选池真源（`MUST_READ/INSIGHT_CANDIDATE_POOL`）住在 memory/event-types，
  //    被生成层读取以决定「要生成多少条」。
  //    ⛔ 移除条件：真源下沉到中立层（`lib/domain/`）。
  "lib/services/enrich/executive-summary|->|lib/services/memory/event-types",
  "lib/services/enrich/pipeline|->|lib/services/memory/event-types",
  // ⑤ enrich → voice：客群口语标签（`segSpeak` / `INSIGHT_OTHER_GROUP`）住在 voice/speech-lines，
  //    被生成层用来给「本地消费场景」这类自拟客群命名。
  //    ⛔ 移除条件：标签迁到 `classify/customer-segment`（客群映射的真源所在）。
  "lib/services/enrich/executive-summary|->|lib/services/voice/speech-lines",
  // ⑥ 曾有第 6 条 `select/index|->|memory/history`，2026-10-03 改用 AST 后**证伪删除**：
  //    源码里是 `history?: import("../memory/history").HistoryStore` —— **类型位置的 import()**，
  //    编译后擦除。正则/词法方案把 `import(...)` 一律当运行时动态 import → 假阳性 → 白登记一条豁免。
  //    （这正是「假阳性会污染豁免名单」的实例：多一条假豁免，真违规就多一个藏身处。）
]);

/**
 * 豁免数量棘轮：**只允许减，不允许增**（新增豁免必须显式改这个数字，逼出一次决策）。
 *
 * 照抄 `NEW_DATE_BASELINE` 的成熟做法 —— 只输出不设限的观测值挡不住名单膨胀。
 * 5 条的历史来源见 `deliverables/architecture-review-2026-10-03/`（含逐条移除条件）。
 */
const EXEMPTION_BASELINE = 5;

/** 循环依赖豁免：key = 环内节点（相对 lib、去扩展名）排序后用 "|" 连接。 */
const CYCLE_EXEMPTIONS = new Set<string>([]);

/** 把 "a|b|c" 规范化成与顺序无关的 key（同一环可能被 DFS 从不同起点多次命中）。 */
function cycleKey(nodes: string[]): string {
  return [...new Set(nodes)].sort().join("|");
}

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

/* ───────── AST 解析（2026-10-03 自查后重写）─────────
 *
 * 为什么放弃正则与自写词法：门禁要正确处理 import、re-export、type-only、动态 import、
 * 注释、字符串、**正则字面量**、模板串 —— 自写词法在「正则字面量里的引号」上直接崩掉：
 * `.replace(/"/g, "&quot;")` 里的引号让状态机错位，导致后续注释没被剥、行号也偏移，
 * 实测把注释里的 `Date.now()` 报成违规、位置还指到无关行（假阳性）。
 * 项目已有 `typescript` 依赖，用编译器 API 拿 AST 是**精确且无需维护词法**的做法。
 */

interface ImportRef {
  spec: string;
  /** `import type` / `export type` —— 编译后擦除，不构成运行时依赖。 */
  typeOnly: boolean;
}

/** 提取全部模块引用：import / re-export / 动态 import()。 */
function collectImports(sf: ts.SourceFile): ImportRef[] {
  const out: ImportRef[] = [];
  const push = (spec: string, typeOnly: boolean): void => {
    if (spec) out.push({ spec, typeOnly });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (ts.isStringLiteral(spec)) push(spec.text, node.importClause?.isTypeOnly === true);
    } else if (ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) push(spec.text, node.isTypeOnly);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      // 动态 import() 同样产生运行时依赖，漏掉会让「条件加载」成为绕过后门
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) push(arg.text, false);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** 服务层禁止的隐式依赖（AST 判定：注释与字符串天然不参与匹配）。 */
interface ForbiddenHit {
  kind: "env" | "date-now" | "new-date";
  line: number;
}

function collectForbidden(sf: ts.SourceFile): ForbiddenHit[] {
  const out: ForbiddenHit[] = [];
  const lineOf = (node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      node.name.text === "env"
    ) {
      out.push({ kind: "env", line: lineOf(node) });
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Date" &&
      node.expression.name.text === "now"
    ) {
      out.push({ kind: "date-now", line: lineOf(node) });
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Date" &&
      (node.arguments?.length ?? 0) === 0
    ) {
      out.push({ kind: "new-date", line: lineOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** services 子目录名（`lib/services/<dir>/…` → `<dir>`；services 顶层文件返回 null）。 */
function serviceDomainOf(rel: string): string | null {
  const m = /^lib\/services\/([^/]+)\//.exec(rel);
  return m ? (m[1] as string) : null;
}

/** 解析相对 import 到仓库内真实文件；非本地或不存在返回 null。 */
function resolveLocalImport(fromFile: string, spec: string, rootDir: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = join(dirname(fromFile), spec);
  // 兼容 TS 的 ESM 风格显式扩展：`./x.js` 在 TS 源码里实际指向 `./x.ts`。
  // 不补这一条的话，`import x from "./y.js"` 会被静默忽略 —— 又一个漏检口子（变异测试抓出）。
  const noJs = base.replace(/\.js$/, "");
  for (const cand of [base + ".ts", join(base, "index.ts"), noJs + ".ts", join(noJs, "index.ts")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return relative(rootDir, cand);
  }
  return null;
}

/** 去掉 `.ts` 扩展名，便于环 key 跨文件形态稳定。 */
function stripTs(rel: string): string {
  return rel.replace(/\.ts$/, "");
}

/**
 * 找出 services 内部的**循环依赖**（模块级 DFS 回边法）。
 *
 * 为什么必须查（2026-10-03 架构审查 P0-1）：本门禁此前只管「services → adapters」，
 * 完全看不见 services 内部，于是 `memory/exec-guard → enrich/executive-summary`
 * 与 `enrich → memory/event-types` 组成的**双向循环**能长期存在。
 *
 * 同一环可能被 DFS 从不同起点多次命中，故按「节点集合」去重。
 */
function findServiceCycles(edges: Map<string, string[]>): string[][] {
  const UNVISITED = 0;
  const ON_STACK = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  const stack: string[] = [];
  const cycles = new Map<string, string[]>();
  const visit = (n: string): void => {
    state.set(n, ON_STACK);
    stack.push(n);
    for (const m of edges.get(n) ?? []) {
      const s = state.get(m) ?? UNVISITED;
      if (s === UNVISITED) visit(m);
      else if (s === ON_STACK) {
        const i = stack.indexOf(m);
        if (i >= 0) {
          const nodes = [...stack.slice(i), m];
          cycles.set(cycleKey(nodes), nodes);
        }
      }
    }
    stack.pop();
    state.set(n, DONE);
  };
  for (const n of edges.keys()) if ((state.get(n) ?? UNVISITED) === UNVISITED) visit(n);
  return [...cycles.values()];
}


export interface ArchitectureReport {
  violations: string[];
  /** 服务层裸 new Date() 存量（棘轮观测值，非违规）。 */
  newDateCount: number;
  /** services 内部循环依赖（已扣豁免），观测值便于治理追踪。 */
  cycleCount: number;
  /** 依赖方向违规中「已豁免」的数量（非违规，但要求写明理由）。 */
  exemptedCount: number;
}

export function checkArchitectureDetailed(
  rootDir = process.cwd(),
  libRel = "lib",
): ArchitectureReport {
  const violations: string[] = [];
  let newDateCount = 0;
  let exemptedCount = 0;
  /** services 模块级依赖图（仅 services 内部的边），供循环检测使用。 */
  const edges = new Map<string, string[]>();
  const libRoot = join(rootDir, libRel);
  // 自证：门禁必须能说出「我检查了几个文件」。扫不到文件时若静默继续，
  // cwd 配错 / lib 改名 / 在子目录里跑脚本，都会得到「门禁通过 ✓」的**假绿** —— 比没有门禁更危险。
  const files = walk(libRoot);
  if (files.length === 0) {
    violations.push(
      `未在 ${libRel}/ 下找到任何 .ts 源文件（rootDir=${rootDir}）—— 门禁未生效，请检查工作目录`,
    );
  }
  for (const f of files) {
    const rel = relative(rootDir, f);
    const isService = rel.startsWith("lib/services/");
    const isContract = rel.startsWith("lib/contracts/");
    // 只解析门禁**真正管辖**的两类目录：services（规则 1~3/6/7）与 contracts（规则 5）。
    // 其余目录（utils / adapters / pipeline / orchestrator…）不适用这些规则，
    // 解析 AST 纯属浪费 —— 实测全量解析 183 个文件要 8.6s，跳过无关目录后降到 ~1s。
    if (!isService && !isContract) continue;
    const src = readFileSync(f, "utf8");
    // setParentNodes=false：本门禁只用 `forEachChild` 向下遍历，不需要向上 parent 指针，
    // 关掉可显著省时（开启时需回填每个节点的 parent）。
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, false);
    const imports = collectImports(sf);

    if (isService) {
      const fromDomain = serviceDomainOf(rel);
      const outs: string[] = [];
      for (const { spec, typeOnly } of imports) {
        // 依赖图与方向检查只看**运行时**依赖（type-only 编译后擦除，不构成环）
        if (!typeOnly) {
          const to = resolveLocalImport(f, spec, rootDir);
          if (to && to.startsWith("lib/services/")) {
            outs.push(stripTs(to));
            const toDomain = serviceDomainOf(to);
            if (fromDomain && toDomain && fromDomain !== toDomain) {
              const selfL = SERVICE_LAYERS[fromDomain];
              const depL = SERVICE_LAYERS[toDomain];
              if (selfL === undefined || depL === undefined) {
                // 未登记的子域**必须报错而不是静默跳过**：「登记过的才管」等于自愿制，
                // 而新增子域恰恰是最需要被约束的时刻（2026-10-03 自查实测：新建域可完全绕过）。
                violations.push(
                  `${rel}: 子域未登记层级（${fromDomain} → ${toDomain}）—— 请在 SERVICE_LAYERS 登记后再提交`,
                );
              } else if (selfL < depL) {
                // 违规 = **低层（层级数字小）反向依赖高层**
                const key = `${stripTs(rel)}|->|${stripTs(to)}`;
                if (DEPENDENCY_EXEMPTIONS.has(key)) exemptedCount++;
                else {
                  violations.push(
                    `${rel}: 依赖方向倒置（${fromDomain} → ${toDomain}）→ ${stripTs(to)}：` +
                      `低层不得反向依赖高层。若确认保留，请把 "${key}" 加入 DEPENDENCY_EXEMPTIONS 并写明成因与移除条件`,
                  );
                }
              }
            }
          }
        }
        if (
          spec === "../adapters" ||
          spec.endsWith("/adapters") ||
          spec.startsWith("../adapters/") ||
          spec.startsWith("../../adapters") ||
          spec.startsWith("node:")
        ) {
          violations.push(`${rel}: 服务层禁止直接依赖副作用实现（${spec}），请改用契约端口`);
        }
      }
      // 补盲区 ① 直读 env / ② 隐式时钟 / ③ 裸 new Date()
      // —— AST 判定，注释与字符串天然不参与，不会再出现「注释里提到 Date.now 就报违规」的假阳性。
      for (const hit of collectForbidden(sf)) {
        if (hit.kind === "env") {
          violations.push(
            `${rel}:${hit.line}: 服务层禁止直读 process.env，配置请由组合根读入 ctx.config 后注入`,
          );
        } else if (hit.kind === "date-now") {
          violations.push(
            `${rel}:${hit.line}: 服务层禁止 Date.now()，时间请由 ctx.startTime / 参数注入`,
          );
        } else {
          newDateCount++;
        }
      }
      edges.set(stripTs(rel), outs);
    }
    if (isContract) {
      for (const { spec } of imports) {
        if (spec.includes("/services/") || spec.includes("/adapters/")) {
          violations.push(`${rel}: 契约层禁止依赖服务/适配器（${spec}）`);
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

  // 豁免棘轮：只允许减，不允许增（否则名单会静默膨胀到失去意义）
  if (exemptedCount > EXEMPTION_BASELINE) {
    violations.push(
      `依赖方向豁免数 ${exemptedCount} 超基线 ${EXEMPTION_BASELINE}：` +
        `新增豁免必须显式上调 EXEMPTION_BASELINE，并写明成因与移除条件`,
    );
  }

  // 规则 6：services 内部循环依赖（2026-10-03 新增）
  let cycleCount = 0;
  for (const cycle of findServiceCycles(edges)) {
    const key = cycleKey(cycle.map(stripTs));
    if (CYCLE_EXEMPTIONS.has(key)) continue;
    cycleCount++;
    violations.push(
      `services 内部循环依赖：${cycle.join(" → ")}` +
        ` —— 环上任一边都会连带改到另一侧（改 A 悄悄坏 B），请抽出中立层打断环`,
    );
  }

  return { violations, newDateCount, cycleCount, exemptedCount };
}

export function checkArchitecture(rootDir = process.cwd(), libRel = "lib"): string[] {
  return checkArchitectureDetailed(rootDir, libRel).violations;
}
