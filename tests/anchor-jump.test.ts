/**
 * 「摘要 → 正文」站内跳转（F2）健壮性锁 —— 2026-09-17 用户实测「点了没反应」的回归锁。
 *
 * 根因：目标卡片有**两重隐藏**，只处理「切 tab」不够——
 *   ① 常在未激活的 tab 面板内（.panel 非 active → display:none）；
 *   ② 还可能落在**折叠区**（.brief.more 默认 display:none）。
 *   对 display:none 的元素 scrollIntoView 不产生任何滚动 → 表现为点了完全没反应。
 *
 * 本测试用真实渲染产物复现该场景（必读条目恰好排在正文第 6 条 → 生成「见正文」锚点，
 * 且目标卡片带 more 折叠），据此锁住脚本必须包含「切面板 + 展开折叠 + 滚动」三件事。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import { renderHtml } from "../lib/services/render";
import { itemIdOf } from "../lib/utils/item-id";
import type { DailyReport, ReportItem } from "../lib/contracts/report";

const TARGET_URL = "https://example.com/anchor-target";

function item(i: number, url = `https://example.com/n${i}`): ReportItem {
  return {
    url,
    title_cn: `政策条目${i}`,
    source: "证券时报",
    source_type: "media",
    date: "09/17",
    summary: "摘要内容。",
    importance: 2,
    rank: i,
    tags: [],
    locale: "national",
  } as ReportItem;
}

/** 必读条目位于正文第 6 条（top5 之外）→ 必然落在折叠区。 */
function report(): DailyReport {
  return {
    date: "2026-09-17",
    hero_line: "",
    must_read: [{ url: TARGET_URL, why: "与客群相关" }],
    insights: [],
    sections: {
      gz_local: [],
      biz_insight: [],
      policy_market: [item(1), item(2), item(3), item(4), item(5), item(6, TARGET_URL)],
      tech: [],
      ipo: [],
    },
  } as unknown as DailyReport;
}

const html = renderHtml(report());

test("场景复现：目标卡片确实落在「折叠区」(more)，且面板默认可非激活", () => {
  const $ = cheerio.load(html);
  const anchor = $("a.must-inbody").first();
  assert.ok(anchor.length > 0, "必读条目已在正文 → 应生成「见正文」锚点");

  const id = (anchor.attr("href") ?? "").slice(1);
  assert.equal(id, itemIdOf(TARGET_URL), "锚点须指向该条目的稳定 ID");

  const $target = $(`#${id}`);
  assert.equal($target.length, 1, "锚点目标必须在同一页内存在");
  assert.ok(
    $target.hasClass("more"),
    "该场景下目标卡片带 more（折叠）→ 脚本必须先展开，否则 scrollIntoView 无效",
  );
});

test("脚本必须齐备三件事：切面板、展开折叠、滚动 + 高亮", () => {
  const s = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  assert.ok(s.includes("function gotoItem"), "跳转逻辑应抽成 gotoItem 以便复用");
  // ① 切面板
  assert.ok(s.includes("classList.toggle('active'"), "须切换 tab 面板");
  // ② 展开折叠（本次修复的核心）
  assert.ok(
    s.includes("classList.contains('more')") && s.includes("classList.add('expanded')"),
    "目标在折叠区时须先展开 —— 否则 display:none 下 scrollIntoView 无任何效果",
  );
  // ③ 滚动 + 高亮
  assert.ok(s.includes("scrollIntoView"), "须滚动到目标");
  assert.ok(s.includes("'flash'"), "须高亮提示，避免用户以为没响应");
});

test("详情页返回也能定位：须监听 hashchange 并在加载时处理锚点", () => {
  const s = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  assert.ok(s.includes("hashchange"), "返回/前进带 #itm- 时也要定位");
  assert.ok(/onHash\(\)/.test(s), "首次加载即带锚点（从详情页返回）时须立即定位");
});

test("事件委托：动态内容也能命中锚点（不再逐个绑定）", () => {
  const s = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  assert.ok(
    s.includes("document.addEventListener('click'") && s.includes("closest('a[href^=\"#itm-\"]')"),
    "改用事件委托，避免新增/筛选后锚点失效",
  );
});
