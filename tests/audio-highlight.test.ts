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
  renderAudioChapters,
  renderAudioNowHint,
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

test("⑤ v4：高亮不得被卡片自身规则盖掉，且不得被横滑容器裁掉", () => {
  // ① 特异性：v3 只有 .audio-highlight(0,1,0)，会被 .must-card.must-top /
  //    .risk-scroller .risk-card(0,2,0) 的 background 盖回去 → 表现为「只有描边、卡面不变色」
  for (const sel of [".must-card.audio-highlight", ".risk-card.audio-highlight", ".stock-card.audio-highlight"]) {
    assert.ok(AUDIO_HIGHLIGHT_CSS.includes(sel), `须有卡片级选择器 ${sel}（提升特异性）`);
  }
  // ② overflow 裁剪：横滑容器 overflow-x:auto 会裁掉向外的阴影 → 必须有内向 outline 兜底
  const outline = /outline:\s*(\d+)px[^;]*;\s*outline-offset:\s*-\d+px/.exec(AUDIO_HIGHLIGHT_CSS);
  assert.ok(outline, "须有 outline + 负 outline-offset（画在卡片内部，容器裁不掉）");
});

test("⑥ A4 章节列表：多段产出可点击章节，单段/空不产出", () => {
  const segs = [
    { id: "hero", startSec: 1, durationSec: 17 },
    { id: "must", startSec: 18, durationSec: 36 },
  ];
  const out = renderAudioChapters(segs);
  assert.ok(out.includes('id="audio-chapters"'), "须产出章节容器");
  assert.ok(out.includes('data-start="18"'), "章节须带起始秒（点击跳段）");
  assert.ok(out.includes("今日必读"), "章节须显示中文段名（回落 id 会很难读）");
  assert.equal(renderAudioChapters([]), "", "空段落不产出章节列表");
  assert.equal(renderAudioChapters([segs[0]]), "", "仅 1 段无跳转意义 → 不产出");
});

test("⑦ A4 章节列表注入当日页面，且与高亮脚本同源联动", () => {
  const page = renderHtml(
    {
      date: "2026-09-17",
      hero_line: "",
      must_read: [{ url: "https://example.com/a1", why: "原因" }],
      insights: [],
      sections: { gz_local: [item(1)], biz_insight: [], policy_market: [], tech: [], ipo: [] },
    } as unknown as DailyReport,
    {
      audio: {
        src: "audio/briefing-2026-09-17.mp3",
        duration: "约 2 分 0 秒",
        segments: [
          { id: "hero", startSec: 0, durationSec: 10, refs: [], text: "定调" },
          { id: "must", startSec: 10, durationSec: 20, refs: [], text: "必读" },
        ],
      },
    },
  );
  assert.ok(page.includes('id="audio-chapters"'), "有音频时页面须带章节列表");
  assert.ok(page.includes('class="audio-chapter"'), "须有章节按钮");
  assert.ok(page.includes("audio-highlight"), "高亮脚本须一并注入（否则点章节只跳音不亮卡）");
  assert.ok(page.includes('id="audio-now-hint"'), "有音频时页面须带「正在播」提示条");
  assert.ok(renderAudioNowHint().includes('id="audio-now-go"'), "提示条须含「定位到卡片」按钮（点击才跳）");
});

test("⑨ 脚本不得自动切面板 / 自动滚动（读者要求：音频跟随只提示不切）", () => {
  const script = generateAudioHighlightScript();
  assert.ok(script.includes("gotoCards"), "须保留读者主动定位能力");
  assert.ok(/hintGo\.onclick\s*=/.test(script), "定位按钮须由读者点击触发");
  // 用「出现次数」锁死调用面（比抠函数体正则稳）：跳转只能有 2 处 —— 定义 + 提示条点击回调。
  // 一旦有人在 timeupdate/apply 里加了自动跳转，计数就会变成 3 → 测试红。
  const hits = (re: RegExp) => (script.match(re) ?? []).length;
  assert.equal(hits(/gotoCards\(/g), 2, "gotoCards 只允许「定义 + 提示条点击回调」两处引用");
  assert.equal(hits(/scrollIntoView/g), 2, "滚动只允许出现在 gotoCards 内部");
  assert.equal(
    hits(/classList\.toggle\("active"/g),
    2,
    "切面板只允许出现在 gotoCards 内部（tab/panel 各一处）",
  );
  const tickBody = /function tick\(\)\s*\{([^}]*)\}/.exec(script)?.[1] ?? "";
  assert.ok(!/gotoCards|scrollIntoView/.test(tickBody), "tick 内不得自动切页");
  assert.ok(script.includes("hiddenReason"), "须检测卡片是否在未激活标签页/折叠区并给出提示");
  assert.ok(script.includes("audio-now-hint"), "须更新播放提示条");
});

test("⑧ 闪 3 次之后必须有持续动效 + 卡片内徽章（读者「抬眼就在动」，不靠 1.65 秒窗口）", () => {
  assert.ok(/@keyframes\s+gz-audio-pulse/.test(AUDIO_HIGHLIGHT_CSS), "须有呼吸脉冲关键帧");
  assert.ok(
    /animation:\s*gz-audio-flash[^;]*\s3\s*,[^;]*gz-audio-pulse[^;]*infinite/.test(AUDIO_HIGHLIGHT_CSS),
    "闪 3 次之后须接无限脉冲（段长 36~98 秒，只闪 1.65 秒等于看不见）",
  );
  assert.ok(AUDIO_HIGHLIGHT_CSS.includes(".audio-now-badge"), "须有卡片内徽章样式（DOM 兜底，裁不掉）");
  assert.ok(/\.audio-highlight\s*\{[^}]*position:\s*relative/.test(AUDIO_HIGHLIGHT_CSS), "徽章绝对定位需 position:relative 承载");
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
