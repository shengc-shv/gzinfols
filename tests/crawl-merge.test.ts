import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePubTime,
  routeRegion,
  rewriteGzPrefix,
  crawledToRaw,
  normalizeLocalIpoItems,
  SOURCE_ROUTE,
} from "../lib/services/normalize/crawl";
import { isWithinCalendarDays, extractDateFromUrl } from "../lib/utils/time";

test("normalizePubTime：裸北京时间补 +08:00（2026-08-31 时区偏移修复）", () => {
  assert.equal(normalizePubTime("2026-08-29 20:37"), "2026-08-29T20:37+08:00");
  assert.equal(normalizePubTime("2026-08-29T20:37"), "2026-08-29T20:37+08:00");
  assert.equal(normalizePubTime("2026-08-29T20:37:00Z"), "2026-08-29T20:37:00Z", "已有 Z 不动");
  assert.equal(
    normalizePubTime("2026-08-29T20:37:00+08:00"),
    "2026-08-29T20:37:00+08:00",
    "已有偏移不动",
  );
  assert.equal(normalizePubTime("2026-08-29"), "2026-08-29", "纯日期不动");
  assert.equal(normalizePubTime(undefined), undefined);
});

test("routeRegion：ipo 模式三分流 + gz- 前缀改写", () => {
  assert.deepEqual(routeRegion("gd-szse-audit", "ipo", { region: "gz" }), {
    sourceId: "gz-szse-audit",
    category: "gz",
  });
  assert.deepEqual(routeRegion("gd-sse-audit", "ipo", { region: "gd" }), {
    sourceId: "gd-sse-audit",
    category: "gd-ipo",
  });
  assert.deepEqual(routeRegion("hk-filing", "ipo", { region: "nation" }), {
    sourceId: "hk-filing",
    category: "ipo",
  });
  // gz 模式：sourceId 原样，category 走 gzCategory 兜底
  assert.deepEqual(routeRegion("cnfin", "gz", { gzCategory: "finance" }), {
    sourceId: "cnfin",
    category: "finance",
  });
});

test("rewriteGzPrefix：gd- 前缀改写为 gz-，gz- 保持不变", () => {
  assert.equal(rewriteGzPrefix("gd-szse-audit"), "gz-szse-audit");
  assert.equal(rewriteGzPrefix("gz-szse-audit"), "gz-szse-audit");
  assert.equal(rewriteGzPrefix("sse-audit"), "gz-sse-audit");
});

test("crawledToRaw：gd region → gd-ipo；URL 日期兜底 publishedAt（红线#1 不造时间）", () => {
  const raw = crawledToRaw(
    {
      sourceId: "gd-sse-audit",
      title: "某企业审核动态",
      url: "https://example.com/2026/0909/abc.html",
      region: "gd",
      publishedAt: "2026-09-09 10:00",
    },
    "ipo",
  );
  assert.equal(raw.category, "gd-ipo");
  assert.ok(raw.publishedAt instanceof Date);
  assert.equal(raw.publishedAt?.toISOString().slice(0, 16), "2026-09-09T02:00", "北京时间按 +08:00 解释");

  // 无发布时间 + 无 URL 日期 → publishedAt 缺失（由 C2 丢弃），绝不伪造
  const noDate = crawledToRaw({ sourceId: "s", title: "t", url: "https://example.com/x" }, "ipo");
  assert.equal(noDate.publishedAt, undefined);
});

test("crawledToRaw：gz 模式 SOURCE_ROUTE 路由 + stocks 强制分类", () => {
  const gz = crawledToRaw(
    { sourceId: "cnfin", title: "财经要闻", url: "https://example.com/a" },
    "gz",
    { gzCategory: SOURCE_ROUTE["cnfin"]?.category },
  );
  assert.equal(gz.category, "finance");
  const stock = crawledToRaw(
    { sourceId: "sina-a-stock", title: "A股收盘", url: "https://example.com/b", subcategory: "a-share" },
    "gz",
    { gzCategory: "stocks" },
  );
  assert.equal(stock.category, "stocks");
  assert.equal(stock.subcategory, "a-share");
});

test("isWithinCalendarDays：日历日窗口（报告时区），无时间为 false", () => {
  const now = new Date("2026-09-11T04:00:00Z"); // 北京时间 09-11 12:00
  assert.equal(isWithinCalendarDays("2026-09-11T02:00:00Z", 2, now), true, "今天");
  assert.equal(isWithinCalendarDays("2026-09-10T02:00:00Z", 2, now), true, "昨天");
  assert.equal(isWithinCalendarDays("2026-09-09T02:00:00Z", 2, now), false, "前天出窗");
  assert.equal(isWithinCalendarDays(undefined, 2, now), false, "无时间红线");
  assert.equal(isWithinCalendarDays("not-a-date", 2, now), false, "非法时间");
});

test("extractDateFromUrl：常见 URL 日期形态", () => {
  assert.equal(extractDateFromUrl("https://x.com/2026-09-09/abc.html"), "2026-09-09");
  assert.equal(extractDateFromUrl("https://x.com/20260909/abc.html"), "2026-09-09");
  assert.equal(extractDateFromUrl("https://x.com/2026/09/09/abc.html"), "2026-09-09");
  assert.equal(extractDateFromUrl("https://x.com/nodate.html"), undefined);
});

test("normalizeLocalIpoItems：丢无日期 / 裁窗口 / URL 去重（内容键兜底）", () => {
  const now = new Date("2026-09-11T04:00:00Z");
  const r = normalizeLocalIpoItems(
    [
      { sourceId: "gd-csrc-tutoring", title: "有日期", url: "u1", publishedAt: "2026-09-10 10:00" },
      { sourceId: "gd-csrc-tutoring", title: "无日期", url: "u2" },
      { sourceId: "gd-csrc-tutoring", title: "超窗", url: "u3", publishedAt: "2026-08-01 10:00" },
      { sourceId: "gd-csrc-tutoring", title: "重复", url: "u1", publishedAt: "2026-09-10 11:00" },
      { sourceId: "gd-szse-audit", title: "空URL键", publishedAt: "2026-09-10 10:00" },
      { sourceId: "gd-szse-audit", title: "空URL键", publishedAt: "2026-09-10 10:00" },
    ],
    { now },
  );
  assert.equal(r.items.length, 2);
  assert.equal(r.droppedNoDate, 1);
  assert.equal(r.droppedOutOfWindow, 1);
  assert.equal(r.droppedDuplicate, 2, "u1 重复 + 空URL内容键重复");
});
