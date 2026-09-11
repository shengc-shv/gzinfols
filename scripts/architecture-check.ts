/**
 * 入口：运行架构门禁（端口/适配器结构约束）。失败时以非零码退出，可挂为 pre-commit / CI。
 */
import { checkArchitecture } from "../lib/architecture/check";

const violations = checkArchitecture();
if (violations.length) {
  console.error("架构门禁失败：");
  for (const v of violations) console.error("  ✗ " + v);
  console.error("\n规则：服务层不得直接依赖适配器/Node；契约层不得依赖服务/适配器。");
  process.exit(1);
}
console.log("架构门禁通过 ✓");
