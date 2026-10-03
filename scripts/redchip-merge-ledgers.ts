#!/usr/bin/env tsx
/**
 * 红筹台账合并 CLI —— 按 `appId` **逐条并集**（不是整文件覆盖）。
 *
 * 用法：
 *   tsx scripts/redchip-merge-ledgers.ts [--out <path>] <file...>
 *
 * 缺省 `--out` = **第一个输入文件**（原地更新）；不存在的文件自动跳过
 * （CI 首次运行、远端尚无该文件是正常情况）。
 *
 * 🔴 为什么需要它（2026-10-03）：台账有两个写入者 —— 线下爬虫（每轮 `git add data/redchip/`）
 * 与 CI 归档。归档原先用 `git merge -X ours` 做**整文件级**冲突处理，冲突时保住 CI 侧
 * → 爬虫刚提交的新数据会被**整份覆盖**（实测 10-03 06:34 爬虫提交、06:38 CI 归档，仅差 4 分钟）。
 * 逐条合并把冲突下沉到条目粒度：每个 `appId` 各自取新者（`lastChangedAt` → `discoveredAt`），
 * 新者缺的字段用旧者补，`discoveredAt` 取最早 —— 两边的新增都不会丢。
 *
 * 只做文件读写与调用纯函数（合并规则在 `lib/services/redchip/leads.ts#mergeLeadSets`，可单测）。
 */
import "./_env";
import fs from "node:fs";
import path from "node:path";
import type { RedchipLead } from "../lib/contracts/redchip";
import { mergeLeadSets } from "../lib/services/redchip/leads";

/** 读一份台账（数组或 `{leads: [...]}` 两种形态都接受）。 */
function readLedger(file: string): RedchipLead[] | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) return parsed as RedchipLead[];
    const wrapped = (parsed as { leads?: unknown } | null)?.leads;
    return Array.isArray(wrapped) ? (wrapped as RedchipLead[]) : undefined;
  } catch {
    return undefined;
  }
}

function main(): void {
  const args = process.argv.slice(2);
  let out: string | undefined;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") {
      out = args[++i];
      continue;
    }
    files.push(args[i]);
  }
  if (files.length === 0) {
    console.error("用法：tsx scripts/redchip-merge-ledgers.ts [--out <path>] <file...>");
    process.exit(2);
  }

  const target = out ?? files[0];
  const sets: RedchipLead[][] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const led = readLedger(f);
    if (led) sets.push(led);
    else skipped.push(fs.existsSync(f) ? `${f}（结构不符或解析失败）` : `${f}（不存在）`);
  }

  const merged = mergeLeadSets(sets);
  const maxIn = Math.max(0, ...sets.map((s) => s.length));
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(path.resolve(target), JSON.stringify(merged, null, 2) + "\n", "utf8");

  console.log(
    `[redchip-merge] 输入 ${files.length} 份（读入 ${sets.length} 份，合计最多 ${maxIn} 条）` +
      ` → 并集 ${merged.length} 条 → 写出 ${target}`,
  );
  if (skipped.length) console.log(`[redchip-merge] ℹ️ 跳过：${skipped.join("；")}`);
  // 并集不可能少于任一输入；若少了，说明有 appId 丢失 —— 必须喊出来（本脚本存在的意义就是防丢数据）。
  if (merged.length < maxIn) {
    console.log(
      `::warning::[redchip-merge] 合并后条数（${merged.length}）少于最大输入（${maxIn}）—— 可能有 appId 丢失，请核对`,
    );
  }
}

main();
