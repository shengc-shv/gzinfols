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
