/**
 * 产物 CSS 结构守卫 + 移动端增强层（2026-09-18）。
 *
 * 起因：2026-09-18 的移动端审查发现一条**产物级静默缺陷，而当时全部测试是绿的**：
 *   `.must-card` 的规则体在 `display: flex` 之后被提前闭合，尾部 5 条声明
 *   （border / border-radius / padding / background / box-shadow）落到了规则体之外，
 *   成了「顶层裸声明」——按 CSS 规范会被浏览器**整块丢弃**。
 *   症状：卡片没有内边距、边框、圆角、白底、阴影，移动端首屏权重最高的
 *   「今日必读」几乎不可读。没有报错、没有告警、指纹拼接测试也照样通过
 *   （拼接确实逐字节相等 —— 源串本身就是坏的）。
 *
 * 本文件锁三类「看着正常、实际失效」的问题：
 *   ① 产物 CSS 不得含顶层裸声明（防同类缺陷再次静默发布）；
 *   ② 多处定义同一属性时，**最后生效的那个必须是预期值**（防修复被后续插入的规则压掉）；
 *   ③ 移动端增强层必须真的生效（触摸热区规则存在、紧凑播放器脚本按需注入且不读墙钟）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHtml } from "../lib/services/render";
import { generateCompactPlayerScript } from "../lib/services/render/mobile-opt";
import {
  styleOf,
  stripComments,
  rulesOf,
  rulesMatching,
  topLevelDeclarations,
} from "./css-inspect";
import type { DailyReport, ReportItem } from "../lib/contracts/report";

function item(over: Partial<ReportItem> = {}): ReportItem {
  return {
    url: "https://e.com/a1",
    title_cn: "条目一",
    source: "源",
    source_type: "media",
    date: "09/17",
    summary: "摘要。",
    importance: 2,
    rank: 1,
    tags: [],
    locale: "national",
    ...over,
  } as ReportItem;
}

function report(over: Partial<DailyReport> = {}): DailyReport {
  return {
    date: "2026-09-17",
    hero_line: "今日定调。",
    must_read: [{ url: "https://e.com/a1", why: "原因", title: "必读一" }],
    insights: [],
    sections: { gz_local: [item()], biz_insight: [], policy_market: [], tech: [], ipo: [] },
    ...over,
  } as unknown as DailyReport;
}

// CSS 解析工具见 ./css-inspect（与 a1a-layout.test.ts 共用，避免两处各写一套解析）

// ── ① 产物 CSS 结构：不得有顶层裸声明 ────────────────────────────────

test("① 产物 CSS 不得含顶层裸声明（规则体必须完整闭合）", () => {
  const html = renderHtml(report());
  const style = stripComments(styleOf(html));
  assert.ok(style.length > 1000, "应取到 <style> 内容");
  const orphans = topLevelDeclarations(style);
  assert.deepEqual(
    orphans,
    [],
    `产物 CSS 出现顶层裸声明（会被浏览器整块丢弃，对应样式静默失效）：\n  ${orphans.join("\n  ")}`,
  );
});

test("①-b .must-card 规则体内必须含卡片容器样式（防修复被回退）", () => {
  const style = stripComments(styleOf(renderHtml(report())));
  const body = rulesOf(style).find((r) => r.prelude === ".must-card")?.body ?? "";
  assert.ok(body.length > 0, "应存在 .must-card 规则");
  for (const decl of ["border:", "border-radius:", "padding:", "background:", "box-shadow:"]) {
    assert.ok(
      body.includes(decl),
      `.must-card 规则体缺少 ${decl} —— 5 条声明曾在规则体外被浏览器丢弃（2026-09-18 P0），勿再移出`,
    );
  }
});

// ── ② 覆盖顺序：最后生效的必须是预期值 ──────────────────────────────

test("② --muted 的最后一次定义必须是达 AA 的取值（浅色 4.82:1）", () => {
  const style = stripComments(styleOf(renderHtml(report())));
  const all = [...style.matchAll(/--muted:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(all.length >= 1, "应存在 --muted 定义");
  assert.equal(all[0], "#6b6b78", "--muted 浅色取值应为 #6b6b78（#797986 仅 3.94:1 未达 AA）");
});

test("②-b tab 选中态最后生效的文字色必须可读（不得只靠分类色）", () => {
  const style = stripComments(styleOf(renderHtml(report())));
  const active = rulesMatching(style, /^\.tabs\s+\.tab\.active$/);
  assert.ok(active.length >= 1, "应存在 tab 选中态规则");
  const last = active[active.length - 1].body;
  assert.ok(
    /color:\s*var\(--fg\)/.test(last),
    "tab 选中态文字色应为 var(--fg)（分类色低至 3.46:1）；分类色只留在 border-bottom-color 上",
  );
});

test("②-c 正文卡标题链接不得回落到浏览器默认链接色（死选择器已移除）", () => {
  const style = stripComments(styleOf(renderHtml(report())));
  assert.ok(
    /\.brief h3 a\s*\{[^}]*color:\s*var\(--fg\)/.test(style),
    "正文卡标题需要 .brief h3 a 的 color 规则（真实 DOM 是 <h3><a class=\"to-detail\">）",
  );
  assert.ok(
    !/\.brief-title a/.test(style),
    ".brief-title 类名在 DOM 中不存在（死选择器），不得再作为标题链接色规则",
  );
});

test("②-d 深色模式下不达标文字色必须有深色覆盖", () => {
  const style = stripComments(styleOf(renderHtml(report())));
  const darkBlocks = rulesMatching(style, /prefers-color-scheme:\s*dark/);
  assert.ok(darkBlocks.length >= 1, "应存在深色模式媒体查询");
  const darkCss = darkBlocks.map((r) => r.body).join("\n");
  assert.ok(
    /\.tag\.t-policy\s*\{[^}]*#fbbf24/.test(darkCss),
    "深色下政策标签原为 #b45309（3.51:1），应有覆盖",
  );
});

// ── ③ 移动端增强层：必须排在最后，且规则真的进了产物 ─────────────────

test("③ 移动端增强层必须是 <style> 里的最后一块（否则会被同选择器规则静默压掉）", () => {
  const style = stripComments(styleOf(renderHtml(report())));
  const rules = rulesOf(style);
  assert.ok(rules.length > 0, "应能从产物里解析出 CSS 规则");
  const last = rules[rules.length - 1];
  assert.match(
    last.prelude,
    /^@media \(max-width: 719\.98px\)$/,
    "移动端增强层必须排在样式表最末：媒体查询不提升优先级，只要其后再出现同选择器规则" +
      "（例如 full.ts 内联的 .seg-chip），本层就会被静默压掉。" +
      `当前最后一块是：${last.prelude.slice(0, 80)}`,
  );
});

test("③-b 触摸热区规则存在（伪元素铺开，不靠撑高盒子）", () => {
  const style = stripComments(styleOf(renderHtml(report())));
  assert.ok(/\.card-actions button::after\s*\{[^}]*inset:/.test(style), "卡片工具条需铺开热区");
  assert.ok(/\.filter-chip::after/.test(style), "筛选 chip 需铺开热区");
  assert.ok(/\.player-card\.compact/.test(style), "粘性播放器需有紧凑态样式");
});

test("③-c 紧凑播放器脚本按需注入，且不读墙钟", () => {
  const script = generateCompactPlayerScript();
  const withAudio = renderHtml(report(), {
    audio: { src: "audio/a.mp3", duration: "约 1 分", segments: [] },
  });
  assert.ok(withAudio.includes(script), "有音频时应注入紧凑播放器脚本");
  const noAudio = renderHtml(report());
  assert.ok(!noAudio.includes("var offAt = origin + 4"), "无音频的期次不得注入空脚本");
  assert.ok(!/\bDate\b/.test(script), "脚本不得读墙钟（服务层禁 Date.now / 裸 new Date）");
});

test("③-d 紧凑态必须「补回下边距」而不是「补偿滚动位置」（真机死循环的根因）", () => {
  const script = generateCompactPlayerScript();
  // 🔴 回归守卫：绝不能再用 scrollBy 补偿。程序化滚动会改变滚动量，而滚动量又是切换判据，
  // 两者构成反馈环 —— 2026-09-18 真机上表现为「一滚就死循环抖动」（桌面模拟却通过）。
  assert.ok(
    !/scrollBy|scrollTo/.test(script),
    "紧凑态切换**不得**改动滚动位置：程序化滚动 + 阈值判据 = 反馈环，真机会来回翻转抖动",
  );
  // 正确做法：把省下的高度补回下边距 → 文档流总高不变 → 内容一动不动，且不碰滚动
  assert.ok(
    /pc\.style\.marginBottom = want \? 'calc\('/.test(script),
    "切换后须把 (before - after) 补回下边距，保持「播放器 + 下边距」总高不变（内容不位移）",
  );
  assert.ok(
    /getComputedStyle\(pc\)\.marginBottom/.test(script),
    "补偿基准须取展开态的计算下边距（写成常量会在样式调整后失真）",
  );
  // 阈值：小滞回带即可（切换不再影响滚动量，故不需要「滞回带 > 收窄量」那套）
  assert.ok(
    /var onAt = origin \+ 6/.test(script) && /var offAt = origin - 6/.test(script) && /on \? y > offAt : y > onAt/.test(script),
    "开关用「上开下关」的小滞回带，防阈值边界反复切换",
  );
  assert.ok(
    /matchMedia\('\(max-width: 719\.98px\)'\)/.test(script),
    "脚本须先判小屏再介入（宽屏紧凑样式不生效）",
  );
});
