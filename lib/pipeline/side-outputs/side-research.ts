/**
 * 高客前瞻·研报旁路（side-output，2026-10-19 sc 拍板建模块）。
 *
 * 与红筹同构：**纯函数 `buildResearchPanel`（可单测）+ IO 包装 `buildResearchFromSource`**。
 *
 * 为什么走旁路而不是主采集链路：
 *  - 研报是「观点」，主流水线是「今日事件」；进 sections 会被评分器压低（无地域/可行动性）、
 *    占掉每源 4 条展示配额，还可能被选进必读/商机并进口播；
 *  - 旁路零 LLM：不过漏斗、不过 PASS1、不进 exec 池 → 零 token 成本。
 *
 * P17（失败必须可见）：源不可达时写 ctx.log.warn 并在 panel.note 留痕，
 * 绝不静默返回空面板让读者误以为「今天没有深度研报」。
 *
 * 🔴 2026-10-19 加固：本函数是旁路，**任何异常都不许冒到 runPipeline**（否则当天整天无报告）。
 * 最外层包一层 try 兜底，异常 → 空面板 + note。
 *
 * 🔴 2026-11-28 sc：**台账写入已挪出本文件**（→ `pipeline/research-context.ts`，由
 * `scripts/daily.ts` 消费）。本函数只抓取 + 出面板，**零写盘**；抓到的全量条目挂在
 * `ctx.researchCaptured` 上交给装配层。原因见下方 collectAndMerge 内的注释。
 */
import type { DailyReport } from "../../contracts/report";
import type { PipelineContext } from "../../contracts/pipeline";
import type { ResearchPanel, ResearchPanelItem } from "../../contracts/research";
import { SinaResearchCrawler } from "../../adapters/crawlers/sources/sina-research";

/** 面板最多展示条数（参考区，不做信息轰炸）。 */
export const RESEARCH_PANEL_MAX = 12;

/** 面板窗口天数缺省值（异常兜底时用于 note，正常路径取各爬虫的最大 windowDays）。 */
const DEFAULT_WINDOW_DAYS = 3;

/** excerpt 契约 `机构｜研究员｜行业` 的拆分（见爬虫注释）。 */
function splitExcerpt(excerpt: string): Pick<ResearchPanelItem, "org" | "researchers" | "industry"> {
  const parts = (excerpt ?? "").split("｜");
  return {
    org: parts[0]?.trim() ?? "",
    researchers: parts[1]?.trim() || undefined,
    industry: parts[2]?.trim() || undefined,
  };
}

/**
 * 纯函数：标题归一化去重 → 发布日期降序 → 截断（可离线单测）。
 * 去重键 = 去空白/标点的标题（同一篇研报可能因翻页重复出现）。
 */
export function buildResearchPanel(
  items: ResearchPanelItem[],
  opts: { scanned: number; windowDays: number; now: Date },
): ResearchPanel {
  const seen = new Set<string>();
  const deduped = items.filter((it) => {
    const key = it.title.toLowerCase().replace(/[\s\p{P}]+/gu, "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return {
    items: deduped.slice(0, RESEARCH_PANEL_MAX),
    scanned: opts.scanned,
    windowDays: opts.windowDays,
    capturedAt: opts.now.toISOString(),
  };
}

/** 抓取包装：新浪宏观研报 → 出面板，并把**全量**条目挂到 `ctx.researchCaptured` 交装配层。
 *  任何单源失败不阻断；**本函数零写盘**（台账写入见 `pipeline/research-context.ts`）。 */
export async function buildResearchFromSource(
  report: DailyReport,
  ctx: PipelineContext,
): Promise<DailyReport> {
  const now = new Date();
  try {
    return await collectAndMerge(report, ctx, now);
  } catch (e) {
    // 🔴 旁路兜底：宁可不产出参考区，也绝不拖垮主报告（buildSideOutputs 调用点无 try）。
    const msg = e instanceof Error ? e.message : String(e);
    ctx.log.warn("research", `研报旁路异常（参考区留空，不影响主报告）: ${msg}`);
    return {
      ...report,
      researchPanel: {
        items: [],
        scanned: 0,
        windowDays: DEFAULT_WINDOW_DAYS,
        capturedAt: now.toISOString(),
        note: `本期研报旁路异常：${msg}`,
      },
    };
  }
}

async function collectAndMerge(
  report: DailyReport,
  ctx: PipelineContext,
  now: Date,
): Promise<DailyReport> {
  // 🔴 2026-10-21 sc：**东财源已停用，只留新浪**。
  // 原因（实测）：① 手机浏览器打开东财 PC 详情页会被前端改写到研报中心（infocode 丢失）；
  // ② PDF 直链 pdf.dfcfw.com 在部分网络下被 EdgeOne 安全策略拦截（sc 实测截图）。
  // 新浪源在手机端可达（改写为 paper.php?reportid=...），故保留。
  // `eastmoney-research.ts` 已删除；如需恢复，从 git 历史取回并加回本数组。
  const sources = [new SinaResearchCrawler()];
  const items: ResearchPanelItem[] = [];
  let scanned = 0;
  let okSources = 0;
  let lastErr = "";

  for (const crawler of sources) {
    try {
      await crawler.run();
      okSources++;
      scanned += crawler.results.length;
      for (const r of crawler.results) {
        const it: ResearchPanelItem = {
          title: r.title ?? "",
          url: r.url ?? "",
          publishedAt: r.publishedAt ?? "",
          ...splitExcerpt(r.excerpt ?? ""),
        };
        if (it.title && it.url && it.publishedAt) items.push(it);
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      ctx.log.warn("research", `${crawler.name} 抓取失败（继续其他源）: ${lastErr}`);
    }
  }

  const windowDays = Math.max(DEFAULT_WINDOW_DAYS, ...sources.map((c) => c.windowDays));
  const panel = buildResearchPanel(items, { scanned, windowDays, now });

  // 🔴 2026-11-28 sc：台账写入从本文件**挪到装配层**（`pipeline/research-context.ts`，
  //    由 `scripts/daily.ts` 调用）。原因：`runPipeline` 也被 e2e / replay / 单测直接调用，
  //    写盘写在管线里，等于让「换个 REPORT_DATE 跑一遍」的验证把真实台账灌成假日期
  //    （实测：用 REPORT_DATE=2026-09-11 回跑，新浪首页 22 条研报全被记成 firstSeen=09-11）。
  //    本函数现在只做「抓取 + 面板」（纯内存），全量条目挂到 ctx 交给装配层落盘。
  //    ⚠️ 面板是截断后的（≤RESEARCH_PANEL_MAX），台账要的是**全量**，故此处存 items 而非 panel.items。
  if (items.length) ctx.researchCaptured = items;

  // P17：全部源不可达 ≠ 真 0 命中 —— 前者必须留痕（note + 日志），不能静默空
  if (okSources === 0) {
    ctx.log.warn("research", `研报源全部不可达（${sources.length} 个）: ${lastErr}`);
    return {
      ...report,
      researchPanel: {
        items: [],
        scanned: 0,
        windowDays,
        capturedAt: now.toISOString(),
        note: `本期研报源不可达：${lastErr}`,
      },
    };
  }

  ctx.log.info(
    "research",
    `高客前瞻：扫描 ${scanned} 条 → 命中 ${panel.items.length} 条（${okSources}/${sources.length} 源可用，窗口 ${windowDays} 天）`,
  );
  return { ...report, researchPanel: panel };
}
