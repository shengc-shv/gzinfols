/**
 * 广东IPO 确定性拼装层（自 gzinfo lib/pipeline/side-outputs/gd-ipo.ts 下沉）。
 *
 * 口播与横滑卡共用的候选池 / 排序 / 企业级去重 / 口播句拼装——「展示卡片」与
 * 「口播」完全一致由构造保证（gzinfo P1-3 口径统一）。纯函数、零 IO；
 * services/voice 与 pipeline/side-outputs 两处消费，避免跨层依赖。
 */

import type { ArticleInput } from "../../contracts/article";
import type { ReportItem } from "../../contracts/report";
import { inferStage, isGdStage, type GdStage } from "./gd-ipo";
import { hkexAppIdOf } from "./redchip";
import { isGdIpoCandidate } from "../enrich/heuristics";
import { recentMmddSet, todayKey } from "../../utils/time";
import {
  IPO_VOICE_WINDOW_DAYS,
  REDCHIP_VOICE_BOOST,
  REDCHIP_VOICE_WINDOW_DAYS,
} from "../../ipo-config";

// 窗口口径（近 N 天的 MM/DD 集合）已下沉到 `utils/time.ts`——口播/横滑与 exec 的
// guangdong_ipo 池必须共用同一实现，否则「要变成口播的内容」窗口口径会漂移
// （用户 2026-09-16 口径：所有进播报的 = 2 天窗；仅底部信息清单的 IPO = 7 天）。

/** ReportItem 发布时间戳（排序用；缺失排最后）。 */
function dateValue(it: ReportItem): number {
  // gzinfo 逐字（lib/pipeline/side-outputs/gd-ipo.ts）：MM/DD → MM*100+DD。
  // 此前误写为不存在的 it.published_at → 恒 0 → 同阶段排序退化为原序（官方测试 gd-ipo-side-output 抓出）。
  const m = it.date.match(/^(\d{2})\/(\d{2})$/);
  return m ? Number(m[1]) * 100 + Number(m[2]) : 0;
}

export function companyNameOf(title: string): string {
  const head = title.split("：")[0] || title;
  return head
    .replace(/[（(][^）)]*[)）]/g, "")
    .replace(/[【\[][^】\]]*[\]】]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 注册地：summary「注册地：广东」→ "广东"。 */
function parseRegisteredProvince(summary: string): string {
  const m = summary.match(/注册地[:：]\s*([^｜|]+)/);
  return m ? m[1].trim() : "";
}

/**
 * 注册城市：从 excerpt/summary 的「注册地：XX」提取城市（如 深圳市 / 广州市），
 * 供 IPO 卡片地域标记替代「粤」展示（2026-09-11）。
 *  - 全地址「注册地：广东深圳市」→ 深圳市；「注册地：广东省广州市番禺区」→ 广州市；
 *  - 仅省名（无城市）或缺失 → 回退「广东」。
 * 注意：只取展示用城市文案，不动 `tags:["粤"]`（音频识别 / 过滤 / exec-pool 仍依赖它）。
 */
export function ipoCityOf(a: ArticleInput): string {
  const registered = parseRegisteredProvince(a.excerpt || a.summary || "");
  if (registered) {
    // 先去掉省前缀（「广东深圳市」→「深圳市」），避免贪心把「广东深圳」一并吞入
    const cleaned = registered.replace(/^广东省?/, "");
    const city = cleaned.match(/([\u4e00-\u9fa5]{2,4}市)/);
    if (city) return city[1];
    if (registered.includes("广东")) return "广东";
  }
  return "广东";
}

/** 拟上市板块：title「（拟创业板）」→ "创业板"。 */
export function parseBoard(title: string): string {
  const m = title.match(/拟\s*([^）)]+?)\s*[）)]/);
  return m ? m[1].trim() : "";
}

/** 板块 → 交易所（用户口径：深交/北交/上交/境外）。 */
function mapBoardToExchange(board: string): string {
  if (/北交|新三板/.test(board)) return "北交所";
  if (/创业|深主|深市|中小/.test(board)) return "深交所";
  if (/科创|沪主|沪市/.test(board)) return "上交所";
  if (/港|H股|红筹|HK/i.test(board)) return "境外（港股）";
  if (/美|NASDAQ|NYSE/i.test(board)) return "境外（美股）";
  if (/A股|主板/.test(board)) return "A股";
  return "";
}

/** 行业：公司名关键词推断（优先级从高到低）。 */
const INDUSTRY_RULES: Array<[RegExp, string]> = [
  [/半导体|芯片|集成电路|IC/i, "半导体"],
  [/生物|医药|制药|医疗|基因|疫苗|器械/i, "医药生物"],
  [/新材料|化工|化学|高分子/i, "化工新材料"],
  [/新能|锂电|光伏|储能|电池|电气|充电|电力/i, "新能源"],
  [/智能|机器人|自动化|人工|软件|数据|云|信息|网络|科技|电子|光电|通信|计算/i, "科技"],
  [/汽车|轮胎|零部件/i, "汽车"],
  [/装备|机械|重工|机床/i, "装备制造"],
  [/食品|饮料|农|牧|渔|酒|乳|糖/i, "食品饮料"],
  [/金融|证券|银行|保险|基金|资本|投资/i, "金融"],
  [/传媒|文化|影|视|游戏|出版|教育/i, "文化传媒"],
  [/地产|置业|建|筑|装饰|物业|园林/i, "房地产建筑"],
  [/物流|运|航|港|铁路|交通/i, "物流运输"],
  [/纺|服|鞋|皮革/i, "纺织服装"],
  [/钢铁|金属|矿|有色/i, "金属冶炼"],
];

function inferIndustry(company: string): string {
  for (const [re, name] of INDUSTRY_RULES) {
    if (re.test(company)) return name;
  }
  return "";
}

/** 进展：title「：」后（至括号前）/ summary「状态：」后。 */
function progressOf(title: string, summary: string): string {
  const t = title.match(/：\s*([^（(]+)/);
  if (t) return t[1].trim();
  const s = summary.match(/状态[:：]\s*([^｜|]+)/);
  return s ? s[1].trim() : "";
}

/** 常规 IPO 口播句（原 buildGdIpoSpoken 内联逻辑抽出，逐字保留口径）。 */function regularClauseOf(it: ReportItem): string {
  const title = it.title_cn || "";
  const summary = it.summary || "";
  const company = companyNameOf(title);
  const prov = parseRegisteredProvince(summary);
  const exchange = mapBoardToExchange(parseBoard(title));
  const industry = inferIndustry(company);
  const progress = progressOf(title, summary);
  const parts = [company];
  if (prov) parts.push(`注册地${prov}`);
  if (industry) parts.push(`${industry}行业`);
  if (exchange) parts.push(`拟在${exchange}IPO`);
  if (progress) parts.push(`目前${progress}`);
  return parts.join("，");
}

/** 是否港交所条目（URL 含申请编号）：红筹线索恒来自披露易，据此兜底交易所名。 */
function isHkexItem(it: ReportItem): boolean {
  return hkexAppIdOf(it) !== undefined;
}

/**
 * 「单纯赴港上市」条目（2026-09-16 用户口径）：港交所递表/上市（URL 带申请编号）
 * 且**不是红筹线索**。
 *
 * 为什么排除：港股通道已由红筹对接（红筹线索另有徽章 + 穿透报告页 + 播报提权），
 * 非红筹的港股递表对分行零售条线没有可执行价值 → **不进口播与顶部横滑**。
 * 底部「广东IPO动态」完整列表**不受影响**（仍保留 7 天窗全量，供参考与红筹页回溯）。
 */
export function isPlainHkListing(it: ReportItem): boolean {
  return hkexAppIdOf(it) !== undefined && it.redchip?.verdict !== "redchip";
}

/**
 * 红筹线索句（T3，确定性、免 LLM；§5.2 模板）。
 *
 * ⚠️ 与方案模板的**一处刻意偏差**：模板写「广东运营<N>处」，但 `gdCityHits` 是
 * **实体语境提及次数**、不等于实体个数（同一主体可能被多次提及）→ 口播说「N 处」会失真。
 * 故口播只说「含广东运营实体」，**计数只在卡片/报告页出现**（那里配原文可核对）。
 */
function redchipClauseOf(it: ReportItem): string {
  const rc = it.redchip;
  if (!rc) return "";
  const title = it.title_cn || "";
  const company = companyNameOf(title);
  if (rc.changeSummary) return `${company}红筹线索有更新：${rc.changeSummary}`;
  const marks: string[] = [];
  if (rc.domicile) marks.push(`${rc.domicile}注册`);
  if ((rc.gdCityHits ?? 0) > 0) marks.push("含广东运营实体");
  const inner = marks.length ? `（${marks.join("、")}）` : "";
  // 交易所：优先沿用标题「（拟XX）」推导；港交所条目标题里没有该字样（只有「主板递表」），
  // 故用申请编号判定来源为港交所 —— 红筹线索恒来自披露易，这一路兜底更准。
  const exchange = mapBoardToExchange(parseBoard(title)) || (isHkexItem(it) ? "港交所" : "");
  const progress = progressOf(title, it.summary || "");
  const tail = [exchange ? `拟在${exchange}IPO` : "", progress ? `目前${progress}` : ""].filter(Boolean);
  const prefix = rc.isNew ? "新增红筹线索：" : "";
  return `${prefix}${company}为红筹线索${inner}${tail.length ? "，" + tail.join("，") : ""}`;
}

/**
 * 红筹口播候选（T3）：`verdict=redchip` ∧ 口播窗内 ∧ 未被跨天去重（`skipCompanies`）。
 *
 * 窗口取 `REDCHIP_VOICE_WINDOW_DAYS`（独立常量，§2.4）；`recentMmddSet`（已下沉到
 * `utils/time.ts`）是「含今天共 N 个日历日」口径，而**红筹**常量语义是「日差 ≤ N」
 * （与 `classify/redchip.ts::inRedchipWindow` 的 dayGap 实现一致）→ 传 `N+1` 对齐。
 * 注：IPO 自己的 `IPO_VOICE_WINDOW_DAYS` **不加 1**（用户口径「2 天窗」= 今天+昨天）。
 * 卡片展示**不受**此窗影响（沿用 `REDCHIP_LIST_WINDOW_DAYS`）。
 */
export function redchipVoiceItems(
  items: ReportItem[],
  skip?: Set<string>,
  today?: string,
): ReportItem[] {
  const allowed = recentMmddSet(REDCHIP_VOICE_WINDOW_DAYS + 1, today ?? todayKey());
  const seen = new Set<string>();
  return items
    .filter(
      (it) =>
        it.redchip?.verdict === "redchip" &&
        allowed.has(it.date) &&
        !(skip && skip.has(companyNameOf(it.title_cn || ""))),
    )
    .sort((x, y) => dateValue(y) - dateValue(x))
    .filter((it) => {
      const key = companyNameOf(it.title_cn || "") || it.url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * 口播实际选中的条目（**唯一选择口径**）：红筹句**置前**，常规 IPO 句其后，共用 3 席。
 *
 * 展示横滑 / 口播 / 事件记忆写回三处共用本函数，保证「看到的就是听到的」。
 */
export function pickSpokenItems(
  items: ReportItem[],
  opts?: { skipCompanies?: Set<string>; withinDays?: number; today?: string },
): { redchip: ReportItem[]; regular: ReportItem[]; selected: ReportItem[]; totalCandidates: number } {
  const redchip = redchipVoiceItems(items, opts?.skipCompanies, opts?.today);
  const rcCompanies = new Set(redchip.map((it) => companyNameOf(it.title_cn || "")));
  const regular = gdIpoCandidates(items, opts?.skipCompanies, opts?.withinDays ?? IPO_VOICE_WINDOW_DAYS, {
    uniqueCompany: true, // 口播不把同一家企业念两遍（P1-4）
    today: opts?.today,
    excludePlainHk: true, // 单纯赴港上市不播（2026-09-16 用户口径）
  }).filter((it) => !rcCompanies.has(companyNameOf(it.title_cn || "")));
  const seats = Math.max(0, 3 - redchip.length);
  return {
    redchip,
    regular,
    selected: [...redchip, ...regular.slice(0, seats)],
    totalCandidates: redchip.length + regular.length,
  };
}

/**
 * 确定性口播稿（免 LLM）：**红筹线索句置段首**（T3），其后接常规广东 IPO 句，
 * 共 3 席；截断由 `AUDIO_SPEAK_LIMITS.ipo` 统一处理 —— 因红筹在前，**截断时红筹优先保留**。
 *
 * @param opts.skipCompanies 同一企业口播去重（命中者跳过，由事件记忆 `ipoVoicing` 算出）。
 * @param opts.withinDays 常规 IPO 口播窗（日历日，含今天），默认 `IPO_VOICE_WINDOW_DAYS`。
 *   红筹窗独立，不受此参数影响（取 `REDCHIP_VOICE_WINDOW_DAYS`）。
 */
export function buildGdIpoSpoken(
  items: ReportItem[],
  opts?: { skipCompanies?: Set<string>; withinDays?: number; today?: string },
): string {
  const { selected, totalCandidates } = pickSpokenItems(items, opts);
  const clauses = selected
    .map((it) => (it.redchip ? redchipClauseOf(it) : regularClauseOf(it)))
    .filter((s) => s.length > 0);
  if (clauses.length === 0) return "";
  let s = clauses.join("；");
  // 候选多于席位时收尾「等N家」，避免口播听起来像只有这几家
  if (totalCandidates > clauses.length) s += `；等${totalCandidates}家`;
  return s;
}

/**
 * IPO 阶段 → 商机价值权重（任务六·广东IPO商机优先排序）：
 * 辅导备案/Pre-IPO（最佳商机）> 辅导完成/已验收（临近申报，授信落地窗口）> 注册生效/过会 >
 * 在审/受理 > 已上市（已兑现，商机偏后）。
 * render 横滑卡与 audio 口播共用此序，确保「展示卡片」与「口播」完全一致。
 *
 * 2026-09-11 新增 `stage-coach-done`（辅导完成·已验收）。**必须与
 * `gd-ipo.IPO_STAGE_ORDER` 同序**（gzinfo 明确设计约束）：本表降序 = 展示顺序。
 * 整表平移后插入新键——既有条目相对次序不变。gzinfo 本次遗漏本表，新阶段无键→比较产生
 * `NaN` → 商机排序未定义，故 2.0 补齐。
 */
export const BIZ_VALUE_RANK: Record<string, number> = {
  "stage-tutoring": 5,
  "stage-coach-done": 4,
  "stage-registered": 3,
  "stage-reviewing": 2,
  "stage-listed": 1,
  "": 0,
};

/** 「是否存在阶段信号」的粗筛词表：只判有无，不判归属（归属唯一由 inferStage 决定）。 */
const STAGE_HINT_RE =
  /注册|过会|核准|受理|问询|上会|审核|上市委|辅导|备案|招股|发行|申购|中签|挂牌|上市|pre-?ipo/i;

/**
 * ReportItem → IPO 阶段（**全链路唯一判定入口**，P0-1 收敛）。
 *
 * 优先级：
 *   ① 官方结构化字段 `it.ipoStage`（爬虫按交易所审核状态直接给出，最权威）；
 *   ② 否则回退 `inferStage` 关键词词表（与官方源同一张表，不再各维护一份）。
 *
 * 返回 `""` 表示「无阶段信号的 IPO 条目」——刻意**不**让 inferStage 的兜底值
 * （stage-tutoring）参与排序，否则无阶段信息的条目会被当成「最佳商机」顶到横滑前 3。
 * 此时分栏里归入「阶段待定」组（有数据才渲染）。
 *
 * 导出供渲染层（分栏 / 徽章 / 排序 / 筛选条）与测试共用。
 */
export function gdIpoStageOf(it: ReportItem): GdStage | "" {
  if (isGdStage(it.ipoStage)) return it.ipoStage;
  const title = it.title_cn || "";
  const summary = it.summary || "";
  if (!STAGE_HINT_RE.test(`${title} ${summary}`)) return "";
  return inferStage(title, summary);
}

/**
 * 广东 IPO 候选（「粤」标或 isGdIpoCandidate），按 skipCompanies 过滤，
 * 可选按 withinDays 限定「近 N 天」（含今天）——口播/今日必读传 2，底部列表传 7。
 * 按 商机价值优先 + 日期倒序 排序（不截断，供口播「等N家」计数）。
 *
 * @param opts.uniqueCompany 同企业只保留**商机价值最高**的一条（P1-4）。用于顶部 3 个
 *   稀缺横滑位与口播（避免同一企业两个阶段占 2 张卡 / 被念两遍）；底部完整列表传 false
 *   以保留「同企业不同阶段」的进展视角（用户既有口径）。
 */
export function gdIpoCandidates(
  items: ReportItem[],
  skip?: Set<string>,
  withinDays?: number,
  opts?: { uniqueCompany?: boolean; today?: string; excludePlainHk?: boolean },
): ReportItem[] {
  const allowed =
    withinDays && withinDays > 0 ? recentMmddSet(withinDays, opts?.today ?? todayKey()) : null;
  const sorted = items
    .filter(
      (it) =>
        // 单纯赴港上市（非红筹）不进口播/横滑（2026-09-16 用户口径；底部列表直调本函数时传 false）
        !(opts?.excludePlainHk === true && isPlainHkListing(it)) &&
        (it.tags?.includes("粤") ||
          isGdIpoCandidate(it.title_cn || "", it.summary || "") ||
          // 红筹线索（T2 已实体匹配）同样进池：其广东相关性由判定链给出，不依赖标题词表。
          // 注意「不额外占名额」——只放宽入池，不抬高下面的 n / 名额上限。
          Boolean(it.redchip)) &&
        !(skip && skip.has(companyNameOf(it.title_cn || ""))) &&
        (!allowed || allowed.has(it.date)),
    )
    .sort((x, y) => {
      const bx = candidateScore(y) - candidateScore(x);
      return bx !== 0 ? bx : dateValue(y) - dateValue(x);
    });
  if (!opts?.uniqueCompany) return sorted;
  const seenCompany = new Set<string>();
  return sorted.filter((it) => {
    const key = companyNameOf(it.title_cn || "") || it.url || "";
    if (seenCompany.has(key)) return false;
    seenCompany.add(key);
    return true;
  });
}

/**
 * 候选池排序键（T4）：商机价值 + **红筹提权**。
 *
 * 提权（`REDCHIP_VOICE_BOOST`，默认 2）只**前移**红筹条目，不增加名额上限
 * —— 用户 2026-09-15 拍板「不占额外名额，但红筹要优先播报」。
 * 调 0 即完全退回与普通 IPO 同序（由单测锁定）。
 */
function candidateScore(it: ReportItem): number {
  return BIZ_VALUE_RANK[gdIpoStageOf(it)] + (it.redchip ? REDCHIP_VOICE_BOOST : 0);
}

/**
 * 广东 IPO 展示/口播选中的 top-N（商机价值优先）；render 与 audio 共用确保一致。
 * 默认窗口 = 2 天（用户 2026-09-10：「进入口播是 2 天」）；底部列表显式传 `IPO_LIST_WINDOW_DAYS`。
 * @param opts.uniqueCompany 默认 true（3 个横滑位不被同企业占满，P1-4）。
 */
export function topGdIpo(
  items: ReportItem[],
  skip?: Set<string>,
  n = 3,
  withinDays: number = IPO_VOICE_WINDOW_DAYS,
  opts?: { uniqueCompany?: boolean; today?: string; excludePlainHk?: boolean },
): ReportItem[] {
  return gdIpoCandidates(items, skip, withinDays, {
    uniqueCompany: opts?.uniqueCompany ?? true,
    today: opts?.today,
    excludePlainHk: opts?.excludePlainHk,
  }).slice(0, n);
}

/**
 * 口播实际选中的企业名（红筹置前 + 常规其后，共 3 席，经 skipCompanies 过滤后）。
 * 供 audio.ts 把「今日已口播企业」写回事件记忆库（ipoVoicing），实现跨天去重。
 *
 * ⚠️ 必须与 `buildGdIpoSpoken` 共用 `pickSpokenItems`：否则「写回记忆的企业」与
 * 「真正播出的企业」不一致 → 跨天去重会错杀或漏杀。
 */
export function pickGdIpoCompanies(
  items: ReportItem[],
  opts?: { skipCompanies?: Set<string>; withinDays?: number; today?: string },
): string[] {
  return pickSpokenItems(items, opts).selected.map((it) => companyNameOf(it.title_cn || ""));
}
