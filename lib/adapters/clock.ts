/**
 * 时钟适配器（副作用出口 #2）。
 *
 * 测试可注入固定时间的 Clock 实现；生产用本实现。
 */
import type { Clock } from "../contracts/pipeline";
import { REPORT_TZ } from "../utils/time";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  todayKey(tz: string = REPORT_TZ): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(this.now());
    const get = (t: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === t)?.value ?? "00";
    return `${get("year")}-${get("month")}-${get("day")}`;
  }
}

/** 测试用：固定时钟。 */
export class FixedClock implements Clock {
  constructor(private readonly fixed: Date = new Date("2026-09-11T00:00:00+08:00")) {}
  now(): Date {
    return this.fixed;
  }
  todayKey(): string {
    const p = this.fixed.toISOString().slice(0, 10);
    return p;
  }
}
