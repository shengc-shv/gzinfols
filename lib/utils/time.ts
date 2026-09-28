/**
 * 时间工具（纯函数，零 IO）—— 自 gzinfo lib/utils.ts 逐字移植。
 *
 * 时间红线相关口径的唯一定义处：
 * - todayKeyOf：REPORT_TZ 感知的日期键（日历日窗口的基准）。
 * - isWithinCalendarDays：日历日窗口判定（替代 48h 滑动窗口；2026-08-31 修复
 *   「29 号信息混入 31 号报告」根因）。无 publishedAt → false（时间红线）。
 * - extractDateFromUrl：从 URL 提取 YYYY-MM-DD（列表页无内联日期时的合法兜底，
 *   URL 日期是真实发布时间的载体，不是抓取时间——不违反红线 #1）。
 */

/**
 * 全项目唯一时区（**硬性规定**）：北京时间 Asia/Shanghai。
 *
 * 为什么是常量而不是可配置项：项目只认北京时间，任何 env 覆盖或系统时区回落
 * 都会让「今天是哪一天」在不同机器/CI runner（默认 UTC）上得出不同结果——
 * 历史窗口、跨天判重、交易日计算全部会错日。故**不接受配置**，单一真源。
 */
export const REPORT_TZ = "Asia/Shanghai";

/** 报告时区（保留函数形态以兼容既有调用点）。 */
export function getReportTz(): string {
  return REPORT_TZ;
}

/** 日期 → 报告时区下的 YYYY-MM-DD 键。 */
export function todayKeyOf(d: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: getReportTz(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

/** gzinfo 命名别名（todayKey；移植模块按 gzinfo 原名引用）。 */
export const todayKey = todayKeyOf;

/**
 * 日历日窗口判定：发布日期（报告时区）∈ {今天, 今天-1, ……, 今天-(days-1)}。
 * 无 publishedAt（时间红线）→ false；非法日期 → false。
 */
export function isWithinCalendarDays(
  publishedAt: Date | string | undefined,
  days: number,
  now: Date = new Date(),
): boolean {
  if (!publishedAt) return false; // 时间红线：无真实发布时间 → 不在窗口
  const t =
    typeof publishedAt === "string"
      ? new Date(publishedAt).getTime()
      : publishedAt.getTime();
  if (Number.isNaN(t)) return false;
  const allowed = new Set<string>();
  let cursor = now.getTime();
  for (let i = 0; i < days; i++) {
    allowed.add(todayKeyOf(new Date(cursor)));
    cursor -= 86_400_000; // 减 24h（报告时区无夏令时，日期键正确递减）
  }
  return allowed.has(todayKeyOf(new Date(t)));
}

/**
 * 自然日差（gzinfo lib/sources/crawlers/sources/staleness.ts dayGap 同款）：
 * 两个 YYYY-MM-DD 之间的天数差（b - a）。用于时效哨兵与广东IPO 健康度检查。
 */
export function dayGap(a: string, b: string): number {
  const ta = new Date(`${a}T00:00:00`).getTime();
  const tb = new Date(`${b}T00:00:00`).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
  return Math.round((tb - ta) / 86_400_000);
}

/**
 * 窗口过滤（gzinfo lib/ingest/merge.ts filterByWindow 同款）：只保留发布日期
 * （报告时区）落在最近 days 个日历日内的条目。时间红线：无真实发布时间 → 丢弃
 * （isWithinCalendarDays 内部已处理，绝不用抓取时间兜底）。
 */
export function filterByWindow<T extends { publishedAt?: Date | string }>(
  articles: T[],
  days: number,
  now: Date,
): T[] {
  // now 必填：窗口必须锚定报告时间（ctx.startTime），否则真实日期跨天后
  // 窗口漂移、测试与生产口径不一致（2026-09-13 修复：股市清单 3/4 天窗因此空窗）。
  return articles.filter((a) => isWithinCalendarDays(a.publishedAt, days, now));
}

/**
 * 从 URL 路径提取发布日期（YYYY-MM-DD）。支持 20260820 / 2026-08-20 / 2026/08/20
 * 等常见形态；无日期或非法日期返回 undefined。
 */
export function extractDateFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const m = url.match(/(\d{4})[-/]?(\d{1,2})[-/]?(\d{1,2})/);
  if (!m) return undefined;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * 前 n 个自然日（`YYYY-MM-DD` → 更早的日期键）。
 *
 * 纯日期运算，以 UTC 零点为锚（**不涉及时区换算**）：输入的键本身已是报告时区的日历日，
 * 减整天不会跨时区漂移。非法输入原样返回（宁可不改，也不编造日期）。
 *
 * 用途：抓取窗口「今天 + 昨天」等**多日窗口**构造
 * （如 `scripts/redchip-monitor` 的默认采信窗口，用户 2026-09-15 口径）。
 */
export function prevDateKey(key: string, n = 1): string {
  const t = Date.parse(`${key}T00:00:00Z`);
  if (Number.isNaN(t) || !Number.isFinite(n)) return key;
  return new Date(t - Math.trunc(n) * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 近 N 天的 MM/DD 集合（`ReportItem.date` 的口径）——**内容条目窗口的单一真源**。
 *
 * 以**报告日**（北京时间日历日键）为基准做纯日期推算，不读 `Date.now()`：服务层禁止
 * 隐式时钟，窗口口径因此完全确定、可注入、跨时区一致。
 *
 * 为什么放在这里（2026-09-16 用户口径「所有要变成口播的，全部是 2 天窗，保持一致；
 * 只有最下面的信息清单，IPO 是 7 天」）：消费方有三处，必须共用同一实现，否则改一处
 * 不生效、口径漂移（历史教训：`IPO_VOICE_WINDOW_DAYS` 曾两处重复定义）——
 *   1. 口播 / 顶部横滑候选：`classify/gd-ipo-spoken.gdIpoCandidates`；
 *   2. exec 的 `guangdong_ipo` 输入池：`enrich/exec-pool.buildIpoPool`；
 *   3. 底部「广东IPO动态」完整列表：同一函数传 `IPO_LIST_WINDOW_DAYS`（7 天）。
 * 注意入参是「含今天往前数 N 天」，`days=2` 即「今天 + 昨天」。
 */
export function recentMmddSet(days: number, today: string): Set<string> {
  const out = new Set<string>();
  // 仅做「减整天」的纯日期运算，故以 UTC 零点为锚（不涉及时区换算）
  const base = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(base)) return out;
  for (let i = 0; i < days; i++) {
    const d = new Date(base - i * 86_400_000);
    out.add(
      `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`,
    );
  }
  return out;
}

/* ───────── 相对日表述（口播/卡面「昨天 / 今天凌晨」口径，2026-09-28 sc 立项） ───────── */

/**
 * 「仅日期」发布时间的识别（源站把时分秒归零，如 `2026-09-27T00:00:00.000Z`）。
 *
 * ⚠️ 为什么必须识别：这类值**没有真实时刻**。若照常做「时刻 → 时段」换算，
 * 会算出「今天上午 8 点发布」这种**编造时间**（00:00Z 换算到北京时区正是 08:00），
 * 直接违反「时间真实性」红线。故此类条目只能说到「日」。
 */
const DATE_ONLY_RE = /[T ]00:00:00(?:\.0+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

const HOUR_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: REPORT_TZ,
  hour: "2-digit",
  hour12: false,
});

/** 报告时区下的小时（0-23）。 */
function hourInReportTz(d: Date): number {
  return Number(HOUR_FMT.format(d));
}

/** 相对日 + 精度（供口播/卡面措辞使用）。 */
export interface SpokenDayParts {
  /** 与报告日的天数差（0 = 今天、1 = 昨天…）；无法解析 → null。 */
  gap: number | null;
  /** 仅日期（无真实时分）→ 调用方**不得**给出「上午 / 下午」这类时段。 */
  dateOnly: boolean;
  /** 报告时区下的小时（0-23）；无法解析 → null。 */
  hour: number | null;
}

/** MM/DD（无年份）形态 —— 报告条目 `ReportItem.date` 与 IPO 池用的就是它。 */
const MM_DD_RE = /^(\d{2})\/(\d{2})$/;

/** 拆出「相对日 + 精度 + 时刻」（纯函数，报告时区口径）。支持 ISO 与 MM/DD 两种输入。 */
export function spokenDayParts(
  publishedAt: Date | string | undefined,
  reportDate: string,
): SpokenDayParts {
  if (!publishedAt) return { gap: null, dateOnly: true, hour: null };
  const raw = typeof publishedAt === "string" ? publishedAt.trim() : "";
  // MM/DD（无年份）：跨年按「今年 → 去年」两次尝试（与 render/atoms.ts#relativeDayLabel 同口径）。
  // 天然只有日粒度 → dateOnly=true，绝不给出时段。
  const mmdd = MM_DD_RE.exec(raw);
  if (mmdd) {
    const [ty, tm, td] = reportDate.split("-").map(Number);
    if (!ty || !tm || !td) return { gap: null, dateOnly: true, hour: null };
    const base = Date.UTC(ty, tm - 1, td);
    for (const y of [ty, ty - 1]) {
      const gap = Math.round(
        (base - Date.UTC(y, Number(mmdd[1]) - 1, Number(mmdd[2]))) / 86_400_000,
      );
      if (gap >= 0) return { gap, dateOnly: true, hour: null };
    }
    return { gap: null, dateOnly: true, hour: null };
  }
  const iso = typeof publishedAt === "string" ? publishedAt : publishedAt.toISOString();
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return { gap: null, dateOnly: true, hour: null };
  const d = new Date(t);
  return {
    gap: dayGap(todayKeyOf(d), reportDate), // b - a = 报告日 − 发布日
    dateOnly: DATE_ONLY_RE.test(iso.trim()),
    hour: hourInReportTz(d),
  };
}

/** 时段划分（报告时区）：口语习惯优先 —— 0-5 凌晨 / 6-8 一早 / 9-11 上午 / 12-17 下午 / 18-23 晚间。 */
const DAY_PERIODS: ReadonlyArray<readonly [number, number, string]> = [
  [0, 5, "凌晨"],
  [6, 8, "一早"],
  [9, 11, "上午"],
  [12, 17, "下午"],
  [18, 23, "晚间"],
];

function periodOf(hour: number): string {
  for (const [lo, hi, label] of DAY_PERIODS) if (hour >= lo && hour <= hi) return label;
  return "";
}

/**
 * 把发布时间换算成**可朗读的相对日短语**（2026-09-28 sc 口径）。
 *
 * 口径（sc 拍板）：以**报道时间**为准（媒体刊发 / 官方发布时刻）—— 数据里只有这个；
 * 官方源的结构化事件日（如 IPO 的 `ipoMeta` 受理日）由各自分支单独精确化。
 *
 * 返回示例：`今天凌晨` / `今天一早` / `昨天上午` / `昨晚` / `昨天` / `前天`。
 * - **精度分级**：`00:00:00` 兜底值（无真实时分）只给到「日」，绝不编造时段；
 * - 超出两天窗口（gap > 2）或无法解析 → 空串（调用方按自身口径回退，不硬造）。
 * - 未来时间（gap < 0，时钟偏差等）→ 空串。
 */
export function spokenRelativeDay(
  publishedAt: Date | string | undefined,
  reportDate: string,
): string {
  const { gap, dateOnly, hour } = spokenDayParts(publishedAt, reportDate);
  if (gap === null || gap < 0 || gap > 2) return "";
  if (gap === 2) return "前天";
  const dayWord = gap === 0 ? "今天" : "昨天";
  if (dateOnly || hour === null) return dayWord;
  const period = periodOf(hour);
  if (!period) return dayWord;
  if (gap === 1 && period === "晚间") return "昨晚"; // 口语更自然
  return `${dayWord}${period}`;
}
