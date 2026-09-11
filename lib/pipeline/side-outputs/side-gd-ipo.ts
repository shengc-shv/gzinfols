/**
 * 广东地区IPO 板块（side-output，绕过相关性 LLM）。
 *
 * 背景（2026-08-30 实跑结论，CI run 33315502473 日志 line 828-829 证实）：
 *   gd-ipo 文章穿过 9 道过滤后，会被 runAiPipeline（相关性 LLM）整体丢弃——
 *   LLM 不把「ipo」当作有效 section 输出，导致线上 sections['ipo'] 恒为 0、
 *   口播「广东IPO=无」、页面 IPO 动态 tab 空。
 *
 * 修复：IPO 是「参考/结构板块」，应仿 buildStockRecap 直接从 filteredArticles
 * （gd-ipo / ipo 类目，已在 filter 阶段豁免跨天去重）构建 report.sections['ipo']，
 * 完全绕过相关性 LLM。与渲染侧 isGdIpoCandidate / 三道闸内容判定口径一致。
 *
 * 同时导出 buildGdIpoSpoken：确定性拼出口播稿（免 LLM，AI/SKIP_AI 双模式可用）。
 */

import type { ArticleInput } from "../../contracts/article";
import type { DailyReport, ReportItem } from "../../contracts/report";
import type { PipelineContext } from "../../contracts/pipeline";
// 复用渲染侧广东IPO 内容判定（单一口径，避免两套正则漂移）
import { isGdIpoCandidate, IPO_CAPITAL_ACT_RE, IPO_FLOW_RE } from "../../services/enrich/heuristics";
import { inferStage, isGdStage, type GdStage } from "../../services/classify/gd-ipo";
import { todayKey } from "../../utils/time";
// P2-3 收敛（2026-09-10）：窗口常量统一来自 lib/ipo-config.ts（此前本文件与
// memory/event-memory.ts 各定义一份 IPO_VOICE_WINDOW_DAYS，改一处不生效）。
import { IPO_VOICE_WINDOW_DAYS, IPO_LIST_WINDOW_DAYS } from "../../ipo-config";

/** IPO 类目（结构化爬虫产物：东财在审表 → gd-ipo；辅导备案/交易所权威源 → ipo）。 */
const IPO_CAT = new Set(["gd-ipo", "ipo"]);

/**
 * 是否属于「广东 IPO 事件」——本板块的**内容判定**入口（无状态源红线）：
 *  ① 结构化类目命中（官方爬虫产物）；或
 *  ② 内容判定命中（媒体源即时报道的「证监会同意粤芯半导体IPO注册」等，官方源漏抓时补位）。
 * 两种来源都必须排除「已上市公司资本运作公告」（定增/解禁/回购…），否则会污染 IPO 板块。
 */
function isIpoArticle(a: ArticleInput): boolean {
  const title = a.title_cn || a.title || "";
  const text = `${title} ${a.excerpt || ""}`;
  if (IPO_CAPITAL_ACT_RE.test(text) && !IPO_FLOW_RE.test(text)) return false;
  if (IPO_CAT.has(a.category ?? "")) return true;
  return isGdIpoCandidate(title, a.excerpt || "");
}

/** 本条是否应打「粤」标（广东商机身份；口播识别与横滑候选依赖它）。 */
function isGdIpoArticle(a: ArticleInput): boolean {
  if (a.category === "gd-ipo") return true; // 官方广东源（region=gd 路由产物）
  return isGdIpoCandidate(a.title_cn || a.title || "", a.excerpt || "");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 展示/口播窗口（日差，含今天）——2026-09-10 用户拍板口径：
 *   - **口播 + 今日必读横滑 = 2 天**（`IPO_VOICE_WINDOW_DAYS`）：只播最新动向；
 *   - **底部「广东IPO动态」列表 = 7 天**（`IPO_LIST_WINDOW_DAYS`）：与源层 7 天窗对齐
 *     （szse-audit.IPO_SOURCE_WINDOW_DAYS / csrcfd.CSRC_WINDOW_DAYS / sse-audit）。
 *
 * 口径 = **日差 ≤ N**（今天往前 N 天，即今天-N ~ 今天）。用户实锤：上交所主板
 * 「广东龙行天下」（updateDate 09-03，相对 09-10 日差恰为 7）必须在列表内 —— 旧的
 * 「含今天共 N 个日历日」（今天-N+1 起）会把它卡在窗外。
 */
// 常量定义已迁至 lib/ipo-config.ts（P2-3 收敛）；此处 re-export 保持既有 import 路径可用。
export { IPO_VOICE_WINDOW_DAYS, IPO_LIST_WINDOW_DAYS };

/**
 * 近 N 天（日差 ≤ N，含今天，按报告时区 REPORT_TZ）的 MM/DD 集合 → N+1 个日历日。
 * ReportItem.date 只有 MM/DD（无年份），故按 MM/DD 判定；跨元旦的边界日可能多算 1 天，
 * 属可接受近似（与既有 dateValue 排序同源口径）。
 */
function recentMmddSet(days: number): Set<string> {
  const out = new Set<string>();
  const base = new Date(`${todayKey()}T00:00:00Z`);
  for (let i = 0; i <= days; i++) {
    const d = new Date(base.getTime() - i * 86_400_000);
    out.add(`${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`);
  }
  return out;
}

/**
 * IPO 卡结构化副信息（P2-5）：保荐 / 拟上市板块 / 受理日。
 *
 * 动机：`summary` 走板块卡通用 90 字截断（渲染再截到 50 字），而爬虫 excerpt 是
 * 「注册地｜保荐｜受理｜状态｜更新｜行业」的长串 → **更新日与后段字段必被吞掉**
 * （实测：钶锐锶卡片看不到「更新：2026-09-07」）。故把需要展示的字段单独拎出来，
 * 不依赖截断；`summary` 保持原样（口播的 `parseRegisteredProvince`/`progressOf` 依赖它）。
 */
export function buildIpoMeta(title: string, excerpt: string): string {
  const parts: string[] = [];
  const sponsor = excerpt.match(/保荐[:：]\s*([^｜|]+)/)?.[1]?.trim();
  if (sponsor) parts.push(`保荐 ${sponsor}`);
  const board = parseBoard(title);
  if (board) parts.push(`拟上市${board}`);
  const accept = excerpt.match(/受理[:：]\s*([^｜|]+)/)?.[1]?.trim();
  if (accept) parts.push(`受理 ${accept}`);
  return parts.join(" ｜ ");
}

/** ArticleInput（gd-ipo/ipo）→ ReportItem（字段对齐板块卡渲染）。 */
function toReportItem(a: ArticleInput): ReportItem {
  const pub = a.publishedAt ? new Date(a.publishedAt) : undefined;
  const mmdd = pub ? `${pad(pub.getMonth() + 1)}/${pad(pub.getDate())}` : "";
  const title = a.title_cn || a.title || "无标题";
  // IPO 是事实参考：summary 取爬虫 excerpt（已带「注册地/保荐/更新」）或标题占位
  const source = a.summary || a.excerpt || title;
  const summary = source.slice(0, 90).trim() || title;
  const tier = a.tier;
  return {
    url: a.url || "",
    title_cn: title,
    title_orig: a.title_cn ? a.title : undefined,
    source: a.source || "",
    source_type: tier === "T1" || tier === "T1.5" ? "official" : "media",
    tier,
    date: mmdd,
    summary,
    // P0-1 结构透传（此前在 side-output 边界丢失 → 渲染退回标题正则，同卡自相矛盾）
    ...(isGdStage(a.ipoStage) ? { ipoStage: a.ipoStage } : {}),
    ...(a.listedDate ? { listedDate: a.listedDate } : {}),
    ...(a.officialUrl ? { officialUrl: a.officialUrl } : {}),
    ...(a.officialLabel ? { officialLabel: a.officialLabel } : {}),
    ...(a.gdBasis ? { gdBasis: a.gdBasis } : {}),
    ...(a.excerpt ? { ipoMeta: buildIpoMeta(title, a.excerpt) } : {}),
    // IPO 卡片地域标记：注册城市（替代「粤」展示，不影响 tags）
    ...(isGdIpoArticle(a) ? { ipoCity: ipoCityOf(a) } : {}),
    importance: 2,
    rank: 0,
    // 广东 IPO 打「粤」标（渲染徽章；口播识别用），全国 ipo 不打
    tags: isGdIpoArticle(a) ? ["粤"] : [],
    locale: "national",
  };
}

/** MM/DD → 可比数值（越新越大），用于板块内按时间倒序。 */
function dateValue(it: ReportItem): number {
  const m = it.date.match(/^(\d{2})\/(\d{2})$/);
  return m ? Number(m[1]) * 100 + Number(m[2]) : 0;
}

/**
 * IPO 阶段**进度**排序权重（P4-④）：越接近上市越靠前（与 BIZ_VALUE_RANK 的商机优先序相反）。
 * 阶段值一律经 `gdIpoStageOf` / `inferStage` 单一判定取得，本表只做权重映射。
 */
const STAGE_RANK: Record<string, number> = {
  "stage-listed": 4,
  "stage-registered": 3,
  "stage-reviewing": 2,
  "stage-tutoring": 1,
};

/** ArticleInput 的阶段进度权重（结构化字段优先，回退 inferStage 单一词表）。 */
function stageRankOfArticle(a: ArticleInput): number {
  const stage = isGdStage(a.ipoStage)
    ? a.ipoStage
    : inferStage(a.title_cn || a.title || "", a.excerpt || "");
  return STAGE_RANK[stage] ?? 0;
}

/** ReportItem 的阶段进度权重（经 gdIpoStageOf，与分栏/徽章同一判定）。 */
function stageRankOfItem(it: ReportItem): number {
  return STAGE_RANK[gdIpoStageOf(it)] ?? 0;
}

/**
 * 把今日 filteredArticles 中的广东 IPO 文章直接构建进 report.sections['ipo']，
 * 与 mergeRollingIntoReport 已并入的滚动历史 IPO 条目按 url 去重合并且今日优先。
 * 返回新 report（不 mutate）。无当日 IPO 命中 → 原样返回（保留滚动并入的）。
 *
 * 入池口径（P1-3 修复，2026-09-10 回检）：**不再只看 category**——媒体源即时报道的
 * 「证监会同意粤芯半导体IPO注册」这类事件走 `isGdIpoCandidate` 内容判定补位
 * （东财/交易所状态滞后时的官方漏抓兜底）。已上市公司资本运作公告仍被排除。
 *
 * P4-④ 企业级去重：今日多源（如 SSE 审核 + 辅导备案）可能报同一家企业，按「归一化企业名」
 * 归并，保留阶段最靠前（最该跟进）或最新的一条，避免一家企业重复占卡。
 * P4-① 结构化阶段：排序优先按阶段进度（gdIpoStageOf 单一判定），其次按日期。
 */
export function buildGdIpo(
  report: DailyReport,
  filteredArticles: ArticleInput[],
  ctx: PipelineContext,
): DailyReport {
  const today = filteredArticles.filter(isIpoArticle);
  if (today.length === 0) {
    ctx.log.info("gd-ipo", "ℹ️ 今日 filteredArticles 无 gd-ipo/ipo 命中，保留滚动并入的 IPO 板块");
    return report;
  }

  // 企业级去重：归一化企业名 → 保留阶段最前 / 最新的一条
  const byCompany = new Map<string, ArticleInput>();
  for (const a of today) {
    const key = companyNameOf(a.title_cn || a.title || "") || a.url || "";
    const prev = byCompany.get(key);
    if (
      !prev ||
      stageRankOfArticle(a) > stageRankOfArticle(prev) ||
      (stageRankOfArticle(a) === stageRankOfArticle(prev) &&
        dateValue(toReportItem(a)) > dateValue(toReportItem(prev)))
    ) {
      byCompany.set(key, a);
    }
  }

  const newItems = [...byCompany.values()]
    .map(toReportItem)
    .sort((x, y) => dateValue(y) - dateValue(x));

  const existing = report.sections?.ipo ?? [];
  const seen = new Set(existing.map((i) => i.url));
  const merged: ReportItem[] = [...existing];
  for (const it of newItems) {
    if (!it.url || !seen.has(it.url)) {
      merged.push(it);
      if (it.url) seen.add(it.url);
    }
  }
  // P4-① 阶段进度优先 + 日期倒序：同一企业不同阶段（url 含 @状态）均保留且最前阶段置顶
  merged.sort((x, y) => {
    const rx = stageRankOfItem(x) - stageRankOfItem(y);
    return rx !== 0 ? rx : dateValue(y) - dateValue(x);
  });
  merged.forEach((it, i) => (it.rank = i + 1));
  ctx.log.info(
    "gd-ipo",
    `🏦 广东IPO板块构建：${newItems.length} 条今日(去重前${today.length}) + ${existing.length} 条滚动 = ${merged.length} 条（绕过相关性 LLM）`,
  );
  return { ...report, sections: { ...report.sections, ipo: merged } };
}

/**
 * 口播稿需要的广东 IPO 企业属性提取（全部确定性、免 LLM）：
 *  - 注册地：从 summary「注册地：XX」抽取（东财在审表 excerpt 已带，如「注册地：广东」）
 *  - 上市地：从 title「（拟XX板块）」抽板块名 → 映射为 深交所/北交所/上交所/境外
 *  - 行业：公司名关键词推断（东财接口无行业字段，且本环境被 WAF 拦截无法补采；
 *          关键词推断确定性、永不缺，契合 side-output 免 LLM 设计）
 *  - 进展：title「：」后 / summary「状态：」后（IPO已受理 / 问询中 / 注册生效 …）
 */

/** 公司名（去掉「（拟XX）」「[派出机构]」等修饰）。导出供口播去重按企业归并。 */
import {
  companyNameOf,
  parseBoard,
  ipoCityOf,
  gdIpoStageOf,
} from "../../services/classify/gd-ipo-spoken";

export { buildGdIpoSpoken, pickGdIpoCompanies } from "../../services/classify/gd-ipo-spoken";
