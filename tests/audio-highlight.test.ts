/**
 * 音频播放 → 卡片高亮联动（P0-A）。
 *
 * 2026-09-17 用户反馈「播放时完全没看到高亮」。核查结论：**机制是好的**
 * （段 id intro/hero/must/insight/risk/stock 与卡片 data-audio-section 完全匹配，
 * 脚本也在），问题是**视觉太弱** —— 原先只有静态 3px 淡蓝光晕 + 6% 背景，
 * 手机上几乎不可见。现改为「整卡明显描边 + 进入时闪 3 次」。
 *
 * 本测试锁三件事：
 *   ① 高亮是**动画闪 3 次**（用户明确要求），且静止态也足够明显；
 *   ② 用 box-shadow **不用 border** —— 加 border 会改变卡片宽高(+4px)，
 *      在横滑容器里引起错位/跳动；
 *   ③ 高亮目标（data-audio-section）与脚本联动链路齐备。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUDIO_HIGHLIGHT_CSS,
  generateAudioHighlightScript,
} from "../lib/services/render/inline-player";
import { renderHtml } from "../lib/services/render";
import type { DailyReport, ReportItem } from "../lib/contracts/report";

function item(i: number): ReportItem {
  return {
    url: `https://example.com/a${i}`,
    title_cn: `条目${i}`,
    source: "证券时报",
    source_type: "media",
    date: "09/17",
    summary: "摘要。",
    importance: 2,
    rank: i,
    tags: [],
    locale: "national",
  } as ReportItem;
}

const html = renderHtml({
  date: "2026-09-17",
  hero_line: "",
  must_read: [{ url: "https://example.com/a1", why: "原因" }],
  insights: [],
  sections: { gz_local: [item(1)], biz_insight: [], policy_market: [], tech: [], ipo: [] },
} as unknown as DailyReport);

test("① 高亮须为「闪 3 次」动画，且静止态明显（原实现太弱，用户看不到）", () => {
  assert.ok(/@keyframes\s+gz-audio-flash/.test(AUDIO_HIGHLIGHT_CSS), "须定义闪烁关键帧");
  assert.ok(
    /animation:\s*gz-audio-flash[^;]*\s3\b/.test(AUDIO_HIGHLIGHT_CSS),
    "动画必须迭代 3 次（用户要求「边框闪烁 3 次」）",
  );
  // 静止态（动画结束后）仍要有明显描边：box-shadow 的扩散半径 >= 4px
  assert.ok(
    /\.audio-highlight\s*\{[^}]*box-shadow:\s*0 0 0 (\d+)px/.test(AUDIO_HIGHLIGHT_CSS),
    "静止态须有明显描边",
  );
  const spread = Number(
    /\.audio-highlight\s*\{[^}]*box-shadow:\s*0 0 0 (\d+)px/.exec(AUDIO_HIGHLIGHT_CSS)?.[1] ?? "0",
  );
  assert.ok(spread >= 4, `描边扩散至少 4px（实测太小会看不见），当前 ${spread}px`);
});

test("② 必须用 box-shadow 而非 border（border 会改变卡片尺寸→横滑错位）", () => {
  const rule = /\.audio-highlight\s*\{([^}]*)\}/.exec(AUDIO_HIGHLIGHT_CSS)?.[1] ?? "";
  assert.ok(rule.length > 0, "应存在 .audio-highlight 规则");
  assert.ok(!/(^|;)\s*border\s*:/.test(rule), "不得使用 border 简写（会撑大卡片）");
  assert.ok(rule.includes("box-shadow"), "须用 box-shadow 模拟描边");
});

test("③ 尊重「减少动态效果」偏好（无障碍）", () => {
  assert.ok(AUDIO_HIGHLIGHT_CSS.includes("prefers-reduced-motion"), "须提供降级：只留静止描边不闪");
});

test("④ 联动链路：脚本监听 timeupdate 并按段切换高亮；卡片锚点存在", () => {
  // 脚本本身（音频仅在当日有音频时才注入页面，故直接验生成器）
  const script = generateAudioHighlightScript();
  assert.ok(script.includes("timeupdate"), "须监听播放进度");
  assert.ok(script.includes("audio-highlight"), "须切换高亮 class");
  assert.ok(script.includes("data-audio-section"), "须按 data-audio-section 定位卡片");
  // 卡片锚点：无 audio 时页面也应有卡片（有音频时脚本才注入）
  assert.ok(
    html.includes('data-audio-section="must"'),
    "卡片须带 data-audio-section（段 id 与之一一对应，否则高亮找不到目标）",
  );
});
