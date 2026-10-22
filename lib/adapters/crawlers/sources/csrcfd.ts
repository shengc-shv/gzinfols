import { BaseCrawler, CrawlerResult } from "../base-crawler";
import { warnIfStale, STALE_LAG_DAYS_IPO } from "./staleness";
// P2-3 收敛（2026-09-10）：早停窗口改引全链路唯一来源 lib/ipo-config.ts。
import { IPO_SOURCE_WINDOW_DAYS } from "../../../ipo-config";
// 2026-09-11：阶段枚举单一真源在服务层（adapters→services 方向被架构门禁允许；本 import 为
// type-only，运行期无依赖、无环）。csrcfd 按列4「辅导状态」映射阶段，不再硬编码 stage-tutoring。
import type { GdStage } from "../../../services/classify/gd-ipo";

/**
 * 证监会资本市场电子化信息披露平台 —— 辅导企业（csrcfd）爬虫
 *
 * 数据价值：唯一权威辅导数据源，覆盖「拟上市企业 earliest 信号」（辅导备案/进展报告）。
 * 参考文件《IPO数据源规格说明_每日监测.md》源 1（2026-09-09 实测）：
 *   - 服务端渲染 HTML，分页 `index.html` / `index_2.html` …，每页约 211 条，共 63 页（全量 ~13,300）。
 *   - 列表按**披露时间倒序**，同一企业多行，首次出现 = 最新状态。
 *   - 8 列表格：序号 / 辅导对象 / 辅导机构 / 备案时间 / 辅导状态 / 派出机构 / 报告类型 / 报告标题。
 *   - 报告披露日期需从行内 `downloadPdf1('.../pre_ipo/YYYY/M/D/xxx.pdf')` 路径提取。
 *
 * 增量策略（2026-09-09 用户设计 + 修正；2026-09-10 窗口由「今昨」放宽到近 7 天）：**倒序早停**——
 *   逐页抓（整页 HTML 为最小粒度，非单条），看页内最早一条的披露日期：
 *     早于「今天-7 天」→ 越过 7 天展示窗口，停止抓取；
 *     否则 → 再抓下一页（后面可能还有窗口内披露）；
 *   取到的全国数据再过滤广东（派出机构广东/深圳证监局 + 企业名/备案时间含广东城市）。
 *
 * ⚠️ 窗口修正动机（2026-09-10 用户拍板）：口播/今日必读 = 2 天窗、底部「广东IPO动态」
 *   列表 = 7 天窗。原「今昨」早停会让列表只有 1 天量，与 7 天展示窗脱节。
 * ⚠️ 与全量 diff 的取舍：本策略只能捕获「窗口内新披露」事件，捕获不了「老企业近期状态变更」
 * （如某企 3 天前改聘保荐人，披露日期老会被早停跳过）。如需状态变更，需全量快照 diff（另建）。
 *
 * 红线：本文件非红线 7 文件；接入点 `lib/sources/crawlers/index.ts`（非红线）已注册本爬虫。
 */

const SOURCE_BASE = "http://eid.csrc.gov.cn/csrcfd";
// 2026-10-22：10 → 20。源站按「报告更新日期」排序，存量库中大量企业的报告期集中在近几日，
// 每页都混入约 20 行窗内记录；实测（2026-10-22）翻到第 16 页仍见 10-16 的记录，10 页兜底会截断数据。
// 20 页 ≈ 8MB/次，单次抓取约 40 秒，可接受；仍保留防死循环语义。
const MAX_PAGES = 20; // 兜底：最多抓 20 页，防死循环
const CONSECUTIVE_STALE_LIMIT = 2; // 兜底：连续 2 页无有效披露日期即停
/** 早停窗口（日差，含今天）：与底部「广东IPO动态」7 天展示窗对齐（2026-09-10 用户拍板）。 */
const CSRC_WINDOW_DAYS = IPO_SOURCE_WINDOW_DAYS;

// 广东口径（参考文件第五节）：派出机构单列深圳证监局，必须合并统计
const GD_DISPATCH_ORGS = ["广东证监局", "深圳证监局"];
const GD_CITIES = [
  "广州", "深圳", "东莞", "佛山", "珠海", "中山", "惠州", "江门", "汕头",
  "湛江", "肇庆", "梅州", "汕尾", "河源", "阳江", "清远", "潮州", "揭阳", "云浮", "顺德",
];

export interface CoachRow {
  company: string; // 列1 辅导对象
  tutorOrg: string; // 列2 辅导机构
  recordDate: string; // 列3 备案时间
  status: string; // 列4 辅导状态
  dispatchOrg: string; // 列5 派出机构
  reportType: string; // 列6 报告类型
  reportTitle: string; // 列7 报告标题
  pdfPath: string; // downloadPdf1 路径（提取披露日期用）
}

/** 解析单页 8 列表格（服务端渲染，正则即可，无需 JS）。 */
export function parseCoachRows(html: string): CoachRow[] {
  const table = html.match(/<table class="m-table2[^"]*">([\s\S]*?)<\/table>/);
  if (!table) return [];
  const trs = table[1].match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  const rows: CoachRow[] = [];
  for (const tr of trs) {
    const tds = tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [];
    if (tds.length < 8) continue;
    const clean = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const cols = tds.map(clean);
    const pdf = tr.match(/downloadPdf1\('([^']+)'/);
    rows.push({
      company: cols[1] || "",
      tutorOrg: cols[2] || "",
      recordDate: cols[3] || "",
      status: cols[4] || "",
      dispatchOrg: cols[5] || "",
      reportType: cols[6] || "",
      reportTitle: cols[7] || "",
      pdfPath: pdf ? pdf[1] : "",
    });
  }
  return rows;
}

/** 从行内 PDF 路径提取报告披露日期：`/pre_ipo/2026/8/28/xxx.pdf` → `2026-08-28`。 */
export function extractDisclosureDate(row: CoachRow): string | null {
  const m = row.pdfPath.match(/\/pre_ipo\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//);
  if (!m) return null;
  return `${m[1]}-${String(+m[2]).padStart(2, "0")}-${String(+m[3]).padStart(2, "0")}`;
}

/**
 * 从 PDF 文件名提取公司名：`/.../关于广东东阳光药业股份有限公司首次公开发行股票...（第十二期）.pdf` → `广东东阳光药业股份有限公司`。
 *
 * 用途（2026-10-11 方案B）：源站对同一企业历史期次行做「合并单元格」——辅导对象列置空，
 * 只有最新一期显示企业名。company 为空的行须从文件名补出公司名，作为「同日同公司去重」的键。
 * 提取失败返回空串（调用方保守处理，不误删）。
 */
export function extractCompanyFromPdfPath(pdfPath: string): string {
  const m = pdfPath.match(/关于([^/]+?)(?:首次公开发行|公开发行)/);
  return m ? m[1].trim() : "";
}

/** 广东判定：派出机构 ∈ {广东/深圳证监局}，或 企业名/备案时间 含广东城市。 */
export function isGuangdong(row: CoachRow): boolean {
  if (GD_DISPATCH_ORGS.includes(row.dispatchOrg)) return true;
  const text = `${row.company} ${row.recordDate}`;
  return GD_CITIES.some((c) => text.includes(c));
}

/**
 * 辅导状态（列4）→ 上市阶段。
 *
 * ⚠️ 列4 是**企业当前状态**（同一企业所有报告行同值），列6 才是「本份报告类型」——
 * 二者不可混用。实测「辅导验收 / 辅导工作完成」恒与列6「辅导工作完成报告」同现，
 * 故用列4 判断企业处在辅导期哪个节点更准。
 *
 * 实测枚举（2026-09-11 采样 120 行）：辅导备案 101 / 撤回辅导备案 17 /
 * 辅导验收 1 / 辅导工作完成 1。未知状态回退 stage-tutoring（保守，不丢条目）。
 */
const COACH_STAGE_BY_STATUS: Record<string, GdStage> = {
  辅导备案: "stage-tutoring",
  辅导验收: "stage-coach-done",
  辅导工作完成: "stage-coach-done",
};

/** 是否已撤回辅导备案：企业终止本次 IPO 进程，不再具备商机（实测约占 14%，须丢弃）。 */
export function isWithdrawn(row: CoachRow): boolean {
  return (row.status || "").includes("撤回");
}

/**
 * 是否阶段性报告（2026-10-22 用户拍板剔除）：报告类型为「辅导进展情况报告」（第N期）——
 * 同一企业的周期性进展披露，不产生新商机，纯噪音（实测窗口内广东企业 667 条中 91% 是此类）。
 * 保留：辅导备案报告（新进入辅导）、辅导工作完成报告（完成辅导=即将申报，重大节点）。
 */
export function isProgressReport(row: CoachRow): boolean {
  return (row.reportType || "").includes("进展");
}

/** 阶段：已知状态按表映射，未知回退 stage-tutoring。 */
export function coachStageOf(row: CoachRow): GdStage {
  return COACH_STAGE_BY_STATUS[row.status] ?? "stage-tutoring";
}

/**
 * 单页早停决策（纯函数，便于测试）：
 *   - 取页内**最后一个有效披露日期**作为该页最早边界（倒序，最后一行最早；容忍末几行无 PDF 路径）。
 *   - 早于 floor（近 7 天窗下界）→ 停止；无有效日期 → 记一次 stale（交由连续 stale 计数兜底）；否则继续。
 */
export function decidePage(
  rows: CoachRow[],
  floor: string,
): { stop: boolean; staleHit: boolean } {
  // 2026-10-22 修复：排序键是「报告更新日期」（PDF 路径日期），不是备案时间列——
  // 源站按「最近有报告更新的企业」倒序，2022 年备案但今日有进展报告的企业排在页首
  // （实测：备案 2022-08-02 / PDF 更新 2026-10-22 排第 2 行）。
  // 旧逻辑取「页内从后往前第一条有日期的行」当页内最早，会被穿插的历史期次合并行 / 老报告行带偏：
  // 实测第 1 页末条为 2026-04-08 更新的老记录 → 误判早停 → 第 2 页起的广东数据全漏
  // （漏掉广东奔达 10-20、深圳微见 10-19 等，豆包侧台账有、本地补数 0 条）。
  // 新判据：整页最大更新日期仍 ≥ 窗口下界 → 后续页仍可能有窗内记录，继续翻；整页都早于下界才停。
  const dates = rows
    .map((r) => extractDisclosureDate(r))
    .filter((d): d is string => d !== null);
  if (dates.length === 0) return { stop: false, staleHit: true };
  const pageNewest = dates.reduce((a, b) => (b > a ? b : a));
  if (pageNewest < floor) return { stop: true, staleHit: false };
  return { stop: false, staleHit: false };
}

/**
 * 早停窗口下界 = 今天 - 7 天（Asia/Shanghai，即近 7 天 = 日差 ≤ 7），
 * 与底部「广东IPO动态」7 天展示窗一致（2026-09-10 用户拍板：口播 2 天 / 列表 7 天）。
 */
function windowFloorStr(): string {
  const parts = new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }).split(", ");
  const [mdy] = parts;
  const [m, d, y] = mdy.split("/").map(Number);
  const dt = new Date(y, m - 1, d - CSRC_WINDOW_DAYS);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export class CsrcCoachCrawler extends BaseCrawler {
  /** 产出 sourceId（P1-6 注册一致性测试遍历本字段）。 */
  override sourceIds = ["gd-csrc-tutoring"];

  constructor() {
    super({ name: "证监会辅导企业(csrcfd)", timeout: 20000, retries: 3 });
  }

  /** 单页抓取（含重试 + 退避，复用基类 userAgent/_backoff）。protected 便于测试 mock。 */
  protected async fetchPage(page: number): Promise<string> {
    const url = page === 1 ? `${SOURCE_BASE}/index.html` : `${SOURCE_BASE}/index_${page}.html`;
    const headers = {
      "User-Agent": this.userAgent,
      Referer: `${SOURCE_BASE}/index.html`,
    };
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.retries + 1; attempt++) {
      try {
        const resp = await fetch(url, { headers, signal: AbortSignal.timeout(this.timeout) });
        if (!resp.ok) {
          const retriable = resp.status >= 500 || resp.status === 429 || resp.status === 403;
          console.warn(
            `[${this.name}] ${url} 返回 ${resp.status}（尝试 ${attempt}/${this.retries + 1}）${retriable ? "，将重试" : "，放弃"}`,
          );
          if (retriable && attempt < this.retries + 1) {
            await this._backoff(attempt);
            continue;
          }
          break;
        }
        return await resp.text();
      } catch (err) {
        lastErr = err;
        console.warn(`[${this.name}] ${url} 抓取失败（尝试 ${attempt}/${this.retries + 1}）: ${(err as Error).message}`);
        if (attempt < this.retries + 1) await this._backoff(attempt);
      }
    }
    throw new Error(`fetch csrcfd page ${page} failed: ${String(lastErr)}`);
  }

  /** override 基类 run：倒序早停多页抓取 + 广东过滤，结果写入 this.results。 */
  override async run(): Promise<CrawlerResult[]> {
    const floor = windowFloorStr();
    let page = 1;
    let consecutiveStale = 0;
    let withdrawn = 0; // 「撤回辅导备案」计数（非商机，丢弃后仅进日志，便于观测）
    let progressDropped = 0; // 「辅导进展情况报告」计数（阶段性报告，2026-10-22 用户拍板剔除）
    let sameDayDropped = 0; // 方案B「同日同公司重复披露」丢弃计数（2026-10-11）
    const allDates: string[] = []; // 新鲜度哨兵输入（含窗口外日期）
    // 方案B（2026-10-11 用户拍板）：同日同公司仅保留最新一期。
    // 成因：csrcfd 源站对同一企业历史期次行做「合并单元格」——辅导对象列置空，只有最新一期显示企业名
    // （实测 2026-10-11 东阳光同日披露第十二/十三期：第十三期行有名字，第十二期起辅导对象列为空）。
    // 列表按披露时间倒序 → 首次出现即最新一期；company 为空的行用 PDF 文件名提取公司名作去重键。
    // 命中已见键 → 该行是同日历史期次，丢弃（避免「同日同公司重复披露 + 空标题」污染日报）。
    const seenCompanyDay = new Set<string>();

    while (page <= MAX_PAGES) {
      let html = "";
      try {
        html = await this.fetchPage(page);
      } catch (err) {
        console.warn(`[${this.name}] 第 ${page} 页抓取失败，停止翻页: ${(err as Error).message}`);
        break;
      }

      const rows = parseCoachRows(html);
      if (rows.length === 0) break;

      // 先收集当前页广东企业（整页粒度抓取：早于 7 天窗口的条目由下游展示窗口控制，
      // 不在此处硬性丢弃，避免漏掉"页内前段新披露 + 末段旧披露"混合页的有效企业）。
      for (const r of rows) {
        const rowDate = extractDisclosureDate(r) || r.recordDate;
        if (rowDate) allDates.push(rowDate);
        if (!isGuangdong(r)) continue;
        // 已撤回辅导备案 = 企业终止本次 IPO 进程，推给业务方是负价值 → 丢弃。
        // 实测占比约 14%（120 行采样 17 条），不过滤会持续污染商机列表。
        if (isWithdrawn(r)) {
          withdrawn++;
          continue;
        }
        // 阶段性报告剔除（2026-10-22 用户拍板）：辅导进展情况报告（第N期）不产生新商机，
        // 667 条窗口内广东企业里 91% 是此类；保留备案（新入辅导）与完成（即将申报）两类节点事件。
        if (isProgressReport(r)) {
          progressDropped++;
          continue;
        }
        // 时间真实性红线：优先披露日期，次选备案时间（源真实字段，非伪造）；皆无则废弃。
        const disclosure = extractDisclosureDate(r) || r.recordDate;
        if (!disclosure) continue;
        // 方案B 去重：同日同公司仅保留最新一期（company 为空时用 PDF 文件名补键）。
        const companyKey = r.company || extractCompanyFromPdfPath(r.pdfPath);
        const dedupKey = companyKey ? `${companyKey}|${disclosure}` : "";
        if (dedupKey && seenCompanyDay.has(dedupKey)) {
          sameDayDropped++;
          continue;
        }
        if (dedupKey) seenCompanyDay.add(dedupKey);
        this.results.push({
          title: `${r.company}${r.status ? ` (${r.status})` : ""}${r.dispatchOrg ? ` [${r.dispatchOrg}]` : ""}`,
          // PDF 存储根在 http://eid.csrc.gov.cn/mnt/storage/...（不含 /csrcfd 路径段）；
          // SOURCE_BASE 的 /csrcfd 仅用于列表页抓取，拼接 PDF 路径会 404，故此处直连根域。
          url: r.pdfPath ? `http://eid.csrc.gov.cn${r.pdfPath}` : "",
          excerpt: [
            "IPO辅导备案",
            r.tutorOrg ? `辅导机构: ${r.tutorOrg}` : "",
            `备案时间: ${r.recordDate}`,
            `状态: ${r.status}`,
            `报告: ${r.reportType}`,
            `披露: ${disclosure}`,
          ].filter(Boolean).join(" | "),
          publishedAt: disclosure,
          sourceId: "gd-csrc-tutoring", // IPO 体系重设计（2026-09-09）：官方辅导源专用 id；
          // 弃用 em-ipo（config 未注册 em-ipo → render knownSourceIds 白名单静默丢弃 → 历史 em-ipo=0 条铁证）。
          region: "gd",
          registeredProvince: "广东",
          // 阶段按列4「辅导状态」映射（2026-09-11 修正）：辅导备案→stage-tutoring、
          // 辅导验收 / 辅导工作完成→stage-coach-done。此前无条件写死 stage-tutoring，
          // 把「刚起步」与「已完成辅导」抹成同一栏，商机分级失真（二者距上市差约 12 个月）。
          ipoStage: coachStageOf(r),
        });
      }

      // 再判是否继续翻页（更新日期早停：整页最大报告更新日期越过 7 天窗口才不再抓下一页；当前页已收）。
      // 注意不能用「页内末条」判定——源站穿插历史期次合并行 / 老报告行，会把末条带到窗口外（2026-10-22 修复）。
      const dec = decidePage(rows, floor);
      if (dec.stop) {
        console.log(`[${this.name}] 第 ${page} 页整页最大更新日期已越过 7 天窗口（${floor}），早停（不再翻页）`);
        break;
      }
      if (dec.staleHit) {
        if (++consecutiveStale >= CONSECUTIVE_STALE_LIMIT) {
          console.log(`[${this.name}] 连续 ${CONSECUTIVE_STALE_LIMIT} 页无有效披露日期，兜底停止`);
          break;
        }
      } else {
        consecutiveStale = 0;
      }
      page++;
    }

    warnIfStale(this, allDates, STALE_LAG_DAYS_IPO);
    console.log(`[${this.name}] 完成，抓取 ${page - 1} 页，广东企业 ${this.results.length} 条`);
    if (withdrawn > 0) {
      console.log(
        `[${this.name}] 已丢弃「撤回辅导备案」${withdrawn} 条（企业终止本次 IPO，非商机）`,
      );
    }
    if (progressDropped > 0) {
      console.log(
        `[${this.name}] 已丢弃「辅导进展情况报告」${progressDropped} 条（阶段性报告无新商机，2026-10-22 用户拍板剔除）`,
      );
    }
    if (sameDayDropped > 0) {
      console.log(
        `[${this.name}] 已丢弃同日同公司重复披露 ${sameDayDropped} 条（方案B：仅保留最新一期）`,
      );
    }
    return this.results;
  }
}

export function createCrawler(): CsrcCoachCrawler {
  return new CsrcCoachCrawler();
}
