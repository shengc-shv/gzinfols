/**
 * 红筹报告引用探测（适配器层，**唯一 IO**；plan-redchip-crawl-push §2.3 / T6）。
 *
 * 站点目录约定（站点根 `site/redchip/`）：
 *   `r/<leadId>.html`      —— 会前版本（由 `build-site` 自动生成：零 LLM、100% 覆盖）
 *   `deep/<leadId>.html`   —— L1 深度报告（人工/后续生成，不存在则无）
 *   `manual/<leadId>.html` —— L2 人工报告（同上）
 *
 * 本模块**只报告真实存在**的文件（deep / manual / r 三类分别探测），
 * 「还没有实体文件但本轮会生成」的会前版本由调用方按确定性路径补上
 * —— 探测与「预期产物」两件事不混在一处，避免报告入口指向不存在的文件。
 */
import fs from "node:fs";
import path from "node:path";
import type { RedchipReportRef } from "../../contracts/redchip";

/** 报告类型目录（相对 `site/redchip/`）。 */
export const REDCHIP_REPORT_DIRS: Record<RedchipReportRef["kind"], string> = {
  manual: "manual",
  deep: "deep",
  "pre-meeting": "r",
};

/** 类型展示名（报告页标题；深度/人工版可被人工报告页自带标题覆盖）。 */
const KIND_TITLES: Record<RedchipReportRef["kind"], string> = {
  manual: "穿透分析报告（人工版）",
  deep: "穿透分析报告（深度版）",
  "pre-meeting": "穿透分析报告（会前版本）",
};

export interface ResolveReportsOptions {
  /** 站点根目录（默认 `<cwd>/site`）；测试注入临时目录。 */
  siteRoot?: string;
}

/** 安全的 leadId（防目录穿越：仅允许数字/字母/连字符/下划线）。 */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/**
 * 探测给定线索的可访问报告（按 **manual → deep → pre-meeting** 优先级返回）。
 *
 * @returns Map<leadId, RedchipReportRef[]>；无任何文件的线索**不出现在 map 里**。
 */
export function resolveReports(
  leadIds: string[],
  opts: ResolveReportsOptions = {},
): Map<string, RedchipReportRef[]> {
  const root = path.resolve(opts.siteRoot ?? path.join(process.cwd(), "site"), "redchip");
  const out = new Map<string, RedchipReportRef[]>();
  for (const id of leadIds) {
    if (!isSafeId(id)) continue;
    const refs: RedchipReportRef[] = [];
    for (const kind of ["manual", "deep", "pre-meeting"] as const) {
      const rel = `${REDCHIP_REPORT_DIRS[kind]}/${id}.html`;
      const abs = path.join(root, rel);
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      refs.push({
        kind,
        url: `redchip/${rel}`,
        title: KIND_TITLES[kind],
        generatedAt: st.mtime.toISOString(),
      });
    }
    if (refs.length) out.set(id, refs);
  }
  return out;
}
