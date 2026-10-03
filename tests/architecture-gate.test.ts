import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkArchitecture, checkArchitectureDetailed } from "../lib/architecture/check";

test("架构门禁：当前代码库无任何服务层/契约层违规", () => {
  const violations = checkArchitecture();
  if (violations.length) {
    console.error(violations.join("\n"));
  }
  assert.equal(violations.length, 0, `存在 ${violations.length} 处架构违规`);
});

/**
 * 补盲区回归（2026-09-14 P0-4）：门禁此前只看 import，看不见「服务层直读 env」
 * 与「服务层隐式时钟」。实测渲染层真实发生过这类回归，必须被门禁拦住。
 */
test("架构门禁：服务层直读 process.env 被判违规", () => {
  const dir = mkdtempSync(join(tmpdir(), "arch-gate-"));
  try {
    mkdirSync(join(dir, "lib/services/demo"), { recursive: true });
    writeFileSync(
      join(dir, "lib/services/demo/x.ts"),
      'export const base = process.env.REPORT_BASE_URL || "";\n',
      "utf8",
    );
    const v = checkArchitecture(dir);
    assert.equal(v.length, 1, "应报 1 处违规");
    assert.match(v[0], /process\.env/, "应指出 process.env 违规");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("架构门禁：服务层隐式时钟（Date.now / 裸 new Date）被判违规", () => {
  const dir = mkdtempSync(join(tmpdir(), "arch-gate-"));
  try {
    mkdirSync(join(dir, "lib/services/demo"), { recursive: true });
    writeFileSync(
      join(dir, "lib/services/demo/y.ts"),
      "export const nowMs = () => Date.now();\n",
      "utf8",
    );
    const v = checkArchitecture(dir);
    assert.equal(v.length, 1, "Date.now() 应报 1 处");
    assert.match(v[0], /Date\.now/, "应指出 Date.now 违规");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("架构门禁：裸 new Date() 为硬禁（2026-09-14 C-3 后基线归零，棘轮已升为绝对禁止）", () => {
  const dir = mkdtempSync(join(tmpdir(), "arch-gate-"));
  try {
    mkdirSync(join(dir, "lib/services/demo"), { recursive: true });
    // 基线已归零 → 出现 1 处即违规（不再是「只挡增长」的棘轮语义）
    writeFileSync(
      join(dir, "lib/services/demo/z.ts"),
      "export const d = () => new Date();\n",
      "utf8",
    );
    const one = checkArchitectureDetailed(dir);
    assert.equal(one.newDateCount, 1, "应统计到 1 处裸 new Date()");
    assert.equal(one.violations.length, 1, "基线为 0 时出现 1 处即应报违规");
    assert.match(one.violations[0], /基线/, "应提示基线");

    // 多处：仍只报 1 条聚合违规（逐处报会淹没输出）
    const many = Array.from({ length: 12 }, (_, i) => `export const d${i} = () => new Date();`).join(
      "\n",
    );
    writeFileSync(join(dir, "lib/services/demo/z.ts"), many + "\n", "utf8");
    const over = checkArchitectureDetailed(dir);
    assert.equal(over.newDateCount, 12, "应统计到全部 12 处");
    assert.equal(over.violations.length, 1, "应聚合为 1 处违规");

    // 显式注入（参数 / ctx.startTime）不算违规 —— 这正是本规则鼓励的写法
    writeFileSync(
      join(dir, "lib/services/demo/z.ts"),
      "export const d = (now: Date) => new Date(now.getTime());\nexport const t = (ctx: { startTime: Date }) => ctx.startTime;\n",
      "utf8",
    );
    const ok = checkArchitectureDetailed(dir);
    assert.equal(ok.newDateCount, 0, "带参数的 new Date(x) 不是裸调用，不应统计");
    assert.equal(ok.violations.length, 0, "注入式写法不应违规");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("架构门禁：注释里提到 process.env / Date.now 不算违规", () => {
  const dir = mkdtempSync(join(tmpdir(), "arch-gate-"));
  try {
    mkdirSync(join(dir, "lib/services/demo"), { recursive: true });
    writeFileSync(
      join(dir, "lib/services/demo/w.ts"),
      [
        "/**",
        " * 不要写 process.env.REPORT_BASE_URL，也不要用 Date.now()。",
        " */",
        "// process.env 只允许组合根读",
        "export const ok = 1;",
        "",
      ].join("\n"),
      "utf8",
    );
    const v = checkArchitecture(dir);
    assert.equal(v.length, 0, "注释中的敏感词不应被判违规（否则门禁自身噪音过大）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2026-10-03 架构审查 P0-1：门禁此前只管「services → adapters」，
// 看不见 services **内部**的循环依赖与子域依赖方向倒置。
// ---------------------------------------------------------------------------

/** 写一组 fixture 文件，返回临时目录（由调用方 rm）。 */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "arch-cycle-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }
  return dir;
}

test("架构门禁：services 内部循环依赖被判违规（2026-10-03 新增）", () => {
  const dir = fixture({
    "lib/services/memory/a.ts": 'import { b } from "./b";\nexport const a = () => b;\n',
    "lib/services/memory/b.ts": 'import { a } from "./a";\nexport const b = () => a;\n',
  });
  try {
    const r = checkArchitectureDetailed(dir);
    assert.equal(r.cycleCount, 1, "应检出 1 个环");
    assert.equal(r.violations.length, 1, "环应作为违规报出（否则改动无感知）");
    assert.match(r.violations[0], /循环依赖/, "应指出循环依赖");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("架构门禁：类型环（import type）不算循环依赖（编译后擦除）", () => {
  const dir = fixture({
    "lib/services/memory/a.ts": 'import type { B } from "./b";\nexport type A = B;\n',
    "lib/services/memory/b.ts": 'import type { A } from "./a";\nexport type B = A;\n',
  });
  try {
    const r = checkArchitectureDetailed(dir);
    assert.equal(r.cycleCount, 0, "类型层依赖不构成运行时环");
    assert.equal(r.violations.length, 0, "类型环不应报违规");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("架构门禁：子域依赖方向倒置（低层→高层）被判违规", () => {
  // select(层级1) → memory(层级3) = 低层反向依赖高层
  const dir = fixture({
    "lib/services/select/x.ts": 'import { m } from "../memory/m";\nexport const x = m;\n',
    "lib/services/memory/m.ts": "export const m = 1;\n",
  });
  try {
    const v = checkArchitecture(dir);
    assert.equal(v.length, 1, "方向倒置应报 1 处");
    assert.match(v[0], /依赖方向倒置（select → memory）/, "应指出是哪条方向");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("架构门禁：已登记豁免的依赖方向不再报违规，但计入 exemptedCount", () => {
  // 用**真实登记的文件级 key**（enrich/executive-summary → memory/event-types）构造。
  // 注意：豁免必须是文件级 —— 域对级（enrich|->|memory）会让后续新增的同向依赖**搭便车**。
  const dir = fixture({
    "lib/services/enrich/executive-summary.ts":
      'import { m } from "../memory/event-types";\nexport const x = m;\n',
    "lib/services/memory/event-types.ts": "export const m = 1;\n",
  });
  try {
    const r = checkArchitectureDetailed(dir);
    assert.equal(r.violations.length, 0, "已豁免方向不得报违规（否则 CI 永远红）");
    assert.equal(r.exemptedCount, 1, "但要计入观测值，保证豁免不被遗忘");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("架构门禁：豁免只认文件级 —— 同域同向的其他文件不得搭便车", () => {
  // 这是「域对级豁免」的漏洞所在：enrich→memory 已豁免，但换一个文件就不该免。
  const dir = fixture({
    "lib/services/enrich/some-new-file.ts":
      'import { m } from "../memory/event-types";\nexport const x = m;\n',
    "lib/services/memory/event-types.ts": "export const m = 1;\n",
  });
  try {
    const v = checkArchitecture(dir);
    assert.equal(v.length, 1, "未登记的文件应照常报违规");
    assert.equal(checkArchitectureDetailed(dir).exemptedCount, 0, "不得消耗豁免额度");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("架构门禁：正常方向（下游消费上游）不报违规", () => {
  // memory(3) → enrich(2)：判重层消费生成层内容，是正常方向
  const dir = fixture({
    "lib/services/memory/x.ts": 'import { e } from "../enrich/e";\nexport const x = e;\n',
    "lib/services/enrich/e.ts": "export const e = 1;\n",
  });
  try {
    const r = checkArchitectureDetailed(dir);
    assert.equal(r.violations.length, 0, "正常方向不应违规");
    assert.equal(r.exemptedCount, 0, "也不该消耗豁免额度");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2026-10-03 自查：门禁自身的失效模式（「看起来在管、实际没管」最危险）
// ---------------------------------------------------------------------------

test("架构门禁：扫不到源文件时必须报错，不得静默通过（假绿）", () => {
  // 失效场景：CI working-directory 配错 / lib 被改名 / 在子目录里跑脚本。
  // 若不报错，门禁会打印「通过 ✓」但一个文件都没检查 —— 比没有门禁更危险。
  const r = checkArchitectureDetailed(join(tmpdir(), "arch-gate-not-exist-xyz"));
  assert.equal(r.violations.length, 1, "应报「未找到源文件」");
  assert.match(r.violations[0], /未在 .* 下找到任何|门禁未生效/, "应明确指出门禁没生效");
});

test("架构门禁：未登记层级的子域必须报错，不得静默跳过", () => {
  // 「登记过的才管」等于自愿制，而新增子域恰恰是最需要被约束的时刻。
  const dir = fixture({
    "lib/services/brandnew/x.ts": 'import { m } from "../memory/m";\nexport const x = m;\n',
    "lib/services/memory/m.ts": "export const m = 1;\n",
  });
  try {
    const v = checkArchitecture(dir);
    assert.equal(v.length, 1, "未登记子域应报违规");
    assert.match(v[0], /未登记层级/, "应提示去 SERVICE_LAYERS 登记");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("架构门禁：export type { X } from 'y' 不算运行时边（类型 re-export 编译后擦除）", () => {
  // 与 import type 同类：漏剥会误报类型环 → 开发者加豁免绕过 → 豁免名单被污染。
  const dir = fixture({
    "lib/services/memory/a.ts": 'export type { B } from "./b";\n',
    "lib/services/memory/b.ts": 'export type { A } from "./a";\n',
  });
  try {
    const r = checkArchitectureDetailed(dir);
    assert.equal(r.cycleCount, 0, "类型 re-export 不构成运行时环");
    assert.equal(r.violations.length, 0, "类型环不应报违规");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("架构门禁：动态 import() 的依赖同样受限（防条件加载成为后门）", () => {
  const dir = fixture({
    "lib/services/memory/a.ts": 'export const load = () => import("./b");\n',
    "lib/services/memory/b.ts": 'export const load2 = () => import("./a");\n',
  });
  try {
    const r = checkArchitectureDetailed(dir);
    assert.equal(r.cycleCount, 1, "动态 import 互引应被检出（此前是漏检口子）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("架构门禁：依赖方向违规信息里带出可直接复制的豁免 key", () => {
  // 便于「确认保留」时精确登记到文件级，而不是退回域对级（域对级会让新依赖搭便车）。
  const dir = fixture({
    "lib/services/select/x.ts": 'import { m } from "../memory/m";\nexport const x = m;\n',
    "lib/services/memory/m.ts": "export const m = 1;\n",
  });
  try {
    const v = checkArchitecture(dir);
    assert.match(
      v[0],
      /"lib\/services\/select\/x\|->\|lib\/services\/memory\/m"/,
      "应给出文件级豁免 key",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2026-10-03 改用 TS 编译器 API（AST）后的回归守护
// 起因：自写词法在「正则字面量里的引号」上崩掉 → 假阳性 + 行号偏移 + 漏检
// ---------------------------------------------------------------------------

test("架构门禁：类型位置的 import() 不算运行时边（`h?: import(\"y\").T`）", () => {
  // 正则方案会把 `import(...)` 一律当动态 import → 假阳性 → 白登记一条豁免。
  // 这正是「假阳性污染豁免名单」的实例（多一条假豁免，真违规就多一个藏身处）。
  const dir = fixture({
    "lib/services/select/a.ts": 'export interface D {\n  h?: import("../memory/m").M;\n}\n',
    "lib/services/memory/m.ts": "export interface M {\n  x: number;\n}\n",
  });
  try {
    const r = checkArchitectureDetailed(dir);
    assert.equal(r.violations.length, 0, "类型位置的 import 不得报违规");
    assert.equal(r.cycleCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("架构门禁：正则字面量里的引号不会破坏解析（词法方案在此崩掉）", () => {
  const dir = fixture({
    "lib/services/select/a.ts": [
      'const esc = (s: string) => s.replace(/"/g, "&amp;quot;");',
      'import { m } from "../memory/m";',
      "export const a = [esc, m];",
      "",
    ].join("\n"),
    "lib/services/memory/m.ts": "export const m = 1;\n",
  });
  try {
    const v = checkArchitecture(dir);
    assert.equal(v.length, 1, "正则字面量之后的 import 仍须被检出（不得被吞）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("架构门禁：字符串与注释里的 Date.now / process.env / new Date() 不误报", () => {
  const dir = fixture({
    "lib/services/demo/a.ts": [
      'const DOC = "调用 Date.now() 会读隐式时钟";',
      "// 也不要写 process.env.XXX",
      "/* 文档：禁止 new Date() */",
      "export const ok = DOC;",
      "",
    ].join("\n"),
  });
  try {
    const r = checkArchitectureDetailed(dir);
    assert.equal(r.violations.length, 0, "字符串/注释里的敏感词不得误报");
    assert.equal(r.newDateCount, 0, "字符串里的 new Date() 不是裸调用");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("架构门禁：真实 Date.now() 的报错行号必须准确（词法方案会因丢换行而偏移）", () => {
  const dir = fixture({
    "lib/services/demo/a.ts": "const x = 1;\nconst y = 2;\nconst t = () => Date.now();\n",
  });
  try {
    const r = checkArchitectureDetailed(dir);
    assert.equal(r.violations.length, 1);
    assert.match(r.violations[0], /:3:/, "应报第 3 行");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
