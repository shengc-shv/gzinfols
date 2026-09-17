/**
 * 搜索入口卡片锁（2026-09-17 用户需求：移到「今日语音播报」正下方、醒目、有交互反馈）。
 *
 * 用户场景：边听语音边想检索 → 入口必须就在播放器正下方第一眼可见；
 * 交互反馈（hover/active）必须存在于 CSS，否则移动端/桌面端都"看不出可点"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSearchEntry, SEARCH_ENTRY_CSS } from "../lib/services/render/search-entry";
import { renderHtml } from "../lib/services/render";
import type { DailyReport } from "../lib/contracts/report";

function report() {
  return {
    date: "2026-09-17",
    hero_line: "定调",
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  } as unknown as DailyReport;
}

test("① 入口链接指向 ../search.html（报告页位于期次子目录）", () => {
  const entry = renderSearchEntry();
  assert.ok(entry.includes('href="../search.html"'), "须用站点相对路径指向检索页");
  assert.ok(entry.includes("搜索全期简报"), "须有可识别的主文案");
  assert.ok(entry.includes("两期对比"), "须提示能力（关键词/板块/主题/对比）");
});

test("② 有音频：入口紧随「今日语音播报」卡片之后（用户指定位置）", () => {
  const page = renderHtml(report(), {
    webMode: true,
    audio: {
      src: "audio/briefing-2026-09-17.mp3",
      duration: "约 3 分 46 秒",
      segments: [{ id: "hero", startSec: 0, durationSec: 10, refs: [], text: "定调" }],
    },
  });
  const playerEnd = page.indexOf("</audio>");
  const entry = page.indexOf('class="search-entry"');
  const heroMark = page.indexOf("<!-- 报头：今日定调 + 数据截至 -->");
  assert.ok(playerEnd > -1 && entry > playerEnd, "入口须在播放器之后");
  assert.ok(heroMark > entry, "入口须在报头之前（正下方，而非页面中部）");
  assert.ok(!page.includes('class="search-entry" data-stale'), "占位");
});

test("③ 无音频的日子：入口仍在页面顶部可见（不能因为没语音就找不到搜索）", () => {
  const page = renderHtml(report(), { webMode: true });
  const entry = page.indexOf('class="search-entry"');
  const heroMark = page.indexOf("<!-- 报头：今日定调 + 数据截至 -->");
  assert.ok(entry > -1, "无音频也须有入口");
  assert.ok(heroMark > entry, "无音频时入口在最顶部（报头之前）");
});

test("④ 交互反馈：hover 加深底色与边框、active 按压、箭头位移（用户要求视觉反馈）", () => {
  assert.ok(/\.search-entry:hover[^{]*\{[^}]*background[^}]*\}/.test(SEARCH_ENTRY_CSS), "hover 须变底色");
  assert.ok(SEARCH_ENTRY_CSS.includes(".search-entry:active"), "须有按压反馈");
  assert.ok(/\.search-entry:hover \.se-arrow/.test(SEARCH_ENTRY_CSS), "hover 须有箭头位移引导");
  assert.ok(SEARCH_ENTRY_CSS.includes("focus-visible"), "键盘聚焦也须有反馈（无障碍）");
  // 醒目性：与播放器同族的 accent 色描边（不是灰色细线）
  assert.ok(SEARCH_ENTRY_CSS.includes("--accent-brand"), "须用品牌 accent 色保证醒目");
});

test("⑤ 发布根副本的链接改写规则已登记（防 ../ 越界 404 第三次同源事故）", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("scripts/build-site.mjs", "utf8");
  assert.ok(
    src.includes('href="\\.\\.\\/search\\.html"'),
    "build-site 须把发布根副本里的 ../search.html 改写为 ./search.html",
  );
});
