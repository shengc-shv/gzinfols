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

/** 报告时区（懒读取，避免模块加载期固化早于 dotenv 的值）。 */
export function getReportTz(): string | undefined {
  return process.env.REPORT_TZ?.trim() || undefined;
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
