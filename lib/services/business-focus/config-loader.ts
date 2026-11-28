/**
 * 经营重点配置加载器（二期 WP1 · 规格 9.2 config-loader）。
 *
 * 职责：三类配置 → 校验归一化 → 合并（跨文件 id 去重）→ 按生效窗口筛出当前重点。
 * 输出 `FocusConfigResult`：`items`（全量合法，含未启用/已过期）与 `active`（当前生效）。
 *
 * 分层红线：
 *   - 本文件**不做 IO**（文件读取在 `lib/adapters/business-focus/config-store.ts`），
 *     也不读时钟：`today`（北京时区日期键 YYYY-MM-DD）由调用方注入。
 *   - 任何配置问题只进 `issues`，**绝不抛错**：引擎最高优先级是不拖垮日报（规格 10.2）。
 *
 * 为什么 `items` 和 `active` 都要给：
 *   - `active` 只用于匹配与加权（过期重点不得继续影响排序）；
 *   - `items` 供首页「本期经营重点」模块与配置体检展示「有配置但未启用/已过期」的重点，
 *     避免管理者以为配置没生效。
 */
import { normalizeFocusFile } from "./config-validator";
import {
  type FocusConfigIssue,
  type FocusConfigResult,
  type FocusFileInput,
  type FocusItem,
  type FocusLayer,
} from "./types";

/** 参与合成的三个层级（顺序固定，仅用于稳定输出与版本号计算）。 */
const LAYER_ORDER: readonly FocusLayer[] = ["annual", "quarterly", "temporary"];

/**
 * 稳定哈希（FNV-1a 32 位 → 8 位十六进制）。
 *
 * 为什么不用 crypto：服务层禁止 `node:` 导入（架构门禁），且这里只需「内容变则值变」的
 * 指纹，不需要密码学强度 —— 用途仅是把「当日用的哪份配置」记进日报以便追溯。
 */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * 重点是否落在生效窗口内。
 * 缺 start_date = 不限起点，缺 end_date = 不限终点（年度重点常只写 start）。
 * 日期为 YYYY-MM-DD 字符串，可直接字典序比较，**不构造 Date、不受时区影响**。
 */
export function isFocusInWindow(item: Pick<FocusItem, "start_date" | "end_date">, today: string): boolean {
  if (item.start_date && today < item.start_date) return false;
  if (item.end_date && today > item.end_date) return false;
  return true;
}

/** 该重点当前是否参与匹配与加权。 */
export function isFocusEffective(item: Pick<FocusItem, "status" | "start_date" | "end_date">, today: string): boolean {
  return item.status === "active" && isFocusInWindow(item, today);
}

/** 归一化输出用：字段顺序固定，保证同一份配置任何机器上哈希一致。 */
function canonical(item: FocusItem): string {
  return JSON.stringify([
    item.id,
    item.name,
    item.layer,
    item.grade,
    item.status,
    item.priority,
    item.weight ?? null,
    item.highlight,
    item.start_date,
    item.end_date,
    item.domains,
    item.core_keywords,
    item.keywords,
    item.synonyms,
    item.concepts,
    item.segments,
    item.products,
    item.exclude_keywords,
    item.description,
    item.description_for_ai,
  ]);
}

/**
 * 合成并筛选当前生效的经营重点。
 *
 * @param files 三个配置文件（缺失的层传 `state: "missing"` 即可，不要省略）
 * @param opts.today 北京时区日期键 YYYY-MM-DD（调用方注入，本函数不读时钟）
 */
export function loadFocusConfig(
  files: readonly FocusFileInput[],
  opts: { today: string },
): FocusConfigResult {
  const issues: FocusConfigIssue[] = [];
  const versions: Record<FocusLayer, string> = { annual: "", quarterly: "", temporary: "" };
  const all: FocusItem[] = [];

  // 按固定层级顺序处理，保证版本号与输出顺序稳定（与 files 入参顺序无关）。
  const ordered = [...files].sort((a, b) => LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer));

  // 只归一化一次（重复调用会重复产生 issues，且浪费时间）。
  const normalized = ordered.map((f) => ({ file: f, result: normalizeFocusFile(f) }));
  for (const { file, result } of normalized) {
    issues.push(...result.issues);
    if (result.version) versions[file.layer] = result.version;
  }

  // 跨文件 id 去重：先到先得（层级顺序 annual → quarterly → temporary），后者丢弃并告警。
  // 重复 id 会让「命中记录」无法唯一定位重点，属于必须拦住的配置错误。
  const seen = new Set<string>();
  for (const { result } of normalized) {
    for (const it of result.items) {
      if (seen.has(it.id)) {
        issues.push({
          file: it.config_file,
          id: it.id,
          field: "id",
          message: "跨文件 id 重复，该条已丢弃（保留先出现的层级）",
        });
        continue;
      }
      seen.add(it.id);
      all.push(it);
    }
  }

  const active = all.filter((it) => isFocusEffective(it, opts.today));

  // 配置哈希只覆盖「全量合法条目」，这样启用/停用、改词都会让版本号变化，
  // 而 issues（纯告警）不影响版本——同一份配置重跑不会因告警措辞变化而换版本号。
  const configHash = fnv1a(all.map(canonical).sort().join("\n"));

  return {
    items: all,
    active,
    version: `f-${configHash.slice(0, 8)}`,
    configHash,
    versions,
    issues,
    degraded: files.some((f) => f.state !== "ok"),
  };
}
