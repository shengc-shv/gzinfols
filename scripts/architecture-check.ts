/**
 * 入口：运行架构门禁（端口/适配器结构约束）。失败时以非零码退出，可挂为 pre-commit / CI。
 *
 * 阻断项：服务层依赖适配器/Node、服务层直读 env 或隐式时钟、契约层依赖实现、
 * 以及服务层裸 new Date() 存量超基线（棘轮）。
 */
import { checkArchitectureDetailed } from "../lib/architecture/check";

const { violations, newDateCount } = checkArchitectureDetailed();
if (violations.length) {
  console.error("架构门禁失败：");
  for (const v of violations) console.error("  ✗ " + v);
  console.error(
    "\n规则：服务层不得依赖适配器/Node，不得直读 process.env 或使用隐式时钟；" +
      "契约层不得依赖服务/适配器。",
  );
  process.exit(1);
}
console.log(`架构门禁通过 ✓（服务层裸 new Date() 存量 ${newDateCount}，棘轮基线内）`);
