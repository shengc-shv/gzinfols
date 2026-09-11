/**
 * 股市数据交易日状态（2026-08-30 gzinfo 用户需求：周末/周一报告应提示为上一开盘日数据）。
 *
 * 从 side-output 下沉 services/market（口播侧 voice 与卡面侧 side-output 共用，
 * 避免日期格式化口径漂移——gzinfo 注释明确「文案由本函数单一产出」）。纯函数。
 */

import type { DailyReport } from "../../contracts/report";
import { prevTradingDay } from "./quotes";

const CN_WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
/** 统一的「X月X日 周X」中文日期格式（computeMarketStatus / 口播侧共用，避免口径漂移）。 */
export function formatCnDate(d: string): string {
  const dt = new Date(d + "T00:00:00");
  return `${dt.getMonth() + 1}月${dt.getDate()}日 ${CN_WEEK[dt.getDay()]}`;
}

/** 简化的「X月X日」中文日期（口播「下面是X月X日股市收盘信息」专用，不带星期）。 */
export function formatCnDateShort(d: string): string {
  const dt = new Date(d + "T00:00:00");
  return `${dt.getMonth() + 1}月${dt.getDate()}日`;
}

export type MarketStatus = NonNullable<NonNullable<DailyReport["stock_recap"]>["marketStatus"]>;

/**
 * 计算股市数据交易日状态（gzinfo 2026-08-30 用户：周末/周一报告应提示为上一开盘日数据）。
 * - 非交易日 = 周日/周六/周一（早间市场未开，数据取上周五收盘）。
 * - dataDate：数据实际所属交易日 = prevTradingDay(reportDate) 或 quotes.date（两者一致）。
 * - note：页面展示文案，仅非交易日有值（橙字警示）；交易日为空串。
 * - spokenNote：口播专用，**交易日也带日期**（听众所处时间不确定，只说「昨日」无法定位）。
 */
export function computeMarketStatus(reportDate: string, dataDate?: string): MarketStatus {
  const dt = new Date(reportDate + "T00:00:00");
  const dow = dt.getDay();
  const isMarketClosed = dow === 0 || dow === 6 || dow === 1; // 日/六/一
  const dd = dataDate ?? prevTradingDay(reportDate);
  const note = isMarketClosed
    ? `周末及周一休市时段，以下行情为上一交易日（${formatCnDate(dd)}）收盘数据`
    : "";
  const spokenNote = isMarketClosed
    ? `当前为休市时段，以下行情为上一交易日，${formatCnDate(dd)}的收盘情况`
    : `以下行情为上一交易日，${formatCnDate(dd)}的收盘情况`;
  return { isMarketClosed, reportDate, dataDate: dd, note, spokenNote };
}
