/**
 * C-2 产物级不变量（渲染层）。
 *
 * 为什么单独建这个文件：2026-09-14 审计的两个 P0 都是**产物级**问题 ——
 *   · P0-1 美国创投新闻被渲染进「广东IPO动态」并打「粤」标；
 *   · P0-2 四个主板块全空、产物只剩 3 个 tab（日报主体空白）。
 * 两者发生时**单元测试全绿**：因为现有 fixture 全是健康数据（见 `render.test.ts` 的
 * 面板齐全用例），没有一条断言「数据存在时必须渲染出来」「缺配置时不得编造」。
 *
 * 本文件锁住三类渲染契约：
 *   ① 数据在 → 必须落到产物（板块不得静默吞条）；空板块 → 不得出现面板；
 *   ② 缺配置 → 宁缺毋滥（不得回落到别的仓库、不得用隐式时钟编造时刻）；
 *   ③ 同一输入 + 同一注入 → 产物逐字一致（可复现性）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHtml } from "../lib/services/render";
import type { DailyReport, ReportItem } from "../lib/contracts/report";
import { todayKey } from "../lib/utils/time";

// ⚠️ 时间红线：fixture 日期必须相对「今天」动态生成（与 tests/render.test.ts 同源教训）。
// 本文件断言 p-ipo 面板，而 IPO 面板走 topGdIpo 的 IPO_LIST_WINDOW_DAYS 窗口判定
// （未传 today 时以 todayKey() 为基准）→ 写死日期会随日历逐日漂移，日差越过窗口
// 后 p-ipo 不再渲染、用例失败（render.test.ts 已于 2026-09-20 实锤）。
const TODAY_KEY = todayKey();
const TODAY_MMDD = `${TODAY_KEY.slice(5, 7)}/${TODAY_KEY.slice(8, 10)}`;

function item(title: string, over: Partial<ReportItem> = {}): ReportItem {
  return {
    url: `https://e.com/${encodeURIComponent(title).slice(0, 12)}`,
    title_cn: title,
    source: "源",
    source_type: "media",
    date: TODAY_MMDD,
    summary: "摘要。",
    importance: 2,
    rank: 1,
    tags: [],
    locale: "national",
    ...over,
  };
}

function report(over: Partial<DailyReport> = {}): DailyReport {
  return {
    date: TODAY_KEY,
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
    ...over,
  };
}

/** 产物中出现过的面板 id（`<section ... id="p-xxx">`）。 */
function panelIds(html: string): string[] {
  return [...new Set(html.match(/id="p-[a-z]+"/g) ?? [])].map((s) => s.slice(4, -1));
}

test("① 非空板块的条目必须出现在产物中（板块不得静默吞条）", () => {
  const titles: Record<string, string> = {
    gz_local: "广州首套房贷利率下调",
    biz_insight: "银行理财规模回升至年内高位",
    policy_market: "国务院部署金融支持实体经济",
    tech: "大模型驱动银行智能风控升级",
    ipo: "廣東微電新能源股份有限公司（主板递表·广东企业）",
  };
  const r = report();
  (Object.keys(titles) as Array<keyof typeof r.sections>).forEach((k) => {
    r.sections[k] = [item(titles[k], k === "ipo" ? { tags: ["粤"] } : {})];
  });
  const html = renderHtml(r);
  for (const [sec, title] of Object.entries(titles)) {
    assert.ok(html.includes(title), `板块 ${sec} 的条目未出现在产物中：${title}`);
  }
  assert.deepEqual(
    panelIds(html).sort(),
    ["p-biz", "p-gz", "p-ipo", "p-pol", "p-tech"],
    "五个板块非空时应有对应面板（stock_news 空 → 无 p-stock）",
  );
});

test("② 空板块不得渲染面板，但 gz_local 常驻（避免静默消失）", () => {
  const r = report();
  r.sections.biz_insight = [item("银行理财规模回升")];
  const html = renderHtml(r);
  const ids = panelIds(html);
  assert.deepEqual(ids.sort(), ["p-biz", "p-gz"], "只应有业务启示面板 + 常驻的广州本地");
  for (const absent of ["p-pol", "p-tech", "p-ipo", "p-stock"]) {
    assert.ok(!ids.includes(absent), `空板块不应出现面板：${absent}`);
  }
  // 契约：空板块自动隐藏属设计（曾被误读为「渲染退化」，见 docs/review-2026-09-14-arch.md P0-2）
  assert.ok(html.length > 1000, "空板块不等于空页面");
});

test("③ 空 sections 的退化输入不得抛错", () => {
  const html = renderHtml(report());
  assert.ok(html.includes("<!doctype html>"), "仍应产出完整文档");
  assert.deepEqual(panelIds(html), ["p-gz"], "只剩余常驻面板");
});

test("④ CSS 自定义属性自洽：裸 var(--x)（无 fallback）必须已定义", () => {
  const r = report();
  r.sections.tech = [item("AI 大模型驱动金融科技升级")];
  const html = renderHtml(r);
  const defined = new Set([...html.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  // 只检查**无 fallback** 的引用：`var(--x, 兜底)` 是显式的可选变量，属正常写法，
  // 而裸 `var(--x)` 未定义会让整条声明失效（静默的死样式）。
  const bare = new Set([...html.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g)].map((m) => m[1]));
  const undef = [...bare].filter((v) => !defined.has(v) && v !== "--brand");
  assert.deepEqual(
    undef,
    [],
    `存在「裸引用但未定义」的 CSS 变量（该声明会整体失效）：${undef.join(", ")}`,
  );
  assert.ok(defined.size > 10, `应确实定义了 CSS 变量（实测 ${defined.size} 个），否则本断言形同虚设`);
});

test("⑧ 合规：产物不得出现任何加密资产相关字样（零容忍红线）", () => {
  const r = report();
  r.sections.tech = [item("科技前沿条目")];
  const html = renderHtml(r);
  for (const bad of ["crypto", "fear-greed", "fg-fear", "fg-greed", "BTC", "加密", "币圈"]) {
    assert.ok(!html.includes(bad), `产物中出现加密资产相关字样：${bad}`);
  }
});

test("⑤ 命名脱敏：产物不得出现主体缩写与历史项目代号", () => {
  const r = report();
  r.sections.tech = [item("科技前沿条目")];
  const html = renderHtml(r);
  for (const bad of ["--accent-cmb", "--cmb", "gzcmbdf3"]) {
    assert.ok(!html.includes(bad), `产物中出现应被脱敏的字样：${bad}`);
  }
  assert.ok(html.includes("--accent-brand"), "应使用脱敏后的变量名 --accent-brand");
});

test("⑥ og:image 契约：注入则输出绝对地址，缺省则完全不输出，且永不指向他仓", () => {
  const r = report();
  const withBase = renderHtml(r, { baseUrl: "https://u.github.io/r/" });
  assert.ok(
    withBase.includes('<meta property="og:image" content="https://u.github.io/r/og-image.png">'),
    "注入基址后应输出绝对 og:image（且去掉尾斜杠避免双斜杠）",
  );
  assert.ok(
    withBase.includes('<meta name="twitter:image" content="https://u.github.io/r/og-image.png">'),
    "twitter:image 应同源",
  );

  const noBase = renderHtml(r);
  assert.ok(!noBase.includes("og:image"), "未注入基址时不得输出 og:image");
  assert.ok(!noBase.includes("twitter:image"), "未注入基址时不得输出 twitter:image");
  for (const html of [withBase, noBase]) {
    assert.ok(!html.includes("github.io/gzinfo"), "任何情况下都不得指向旧仓库 gzinfo（P1-2 回归）");
  }
});

test("⑦ 渲染时刻只由注入决定：缺省不显示、注入走北京时间、不污染其他产物", () => {
  const r = report();
  r.sections.tech = [item("科技前沿条目")];

  const noNow = renderHtml(r);
  assert.ok(!/数据截至 \d{2}:\d{2}/.test(noNow), "未注入 now 时不得编造「数据截至 时刻」");

  // 2026-09-14T11:14:00Z → 北京时间 19:14（UTC+8）
  const a = renderHtml(r, { now: new Date("2026-09-14T11:14:00Z") });
  const b = renderHtml(r, { now: new Date("2026-09-14T13:45:00Z") });
  assert.ok(/数据截至 19:14/.test(a), "时刻应按北京时间渲染（CI 为 UTC，禁止回落系统时区）");

  // 可复现性：除时刻外逐字一致 —— 这条锁住「隐式时钟」回归（P0-4）
  const strip = (s: string) => s.replace(/\d{2}:\d{2}/g, "HH:MM");
  assert.equal(strip(a), strip(b), "两次渲染的差异必须仅来自注入的 now");
  assert.notEqual(a, b, "注入了不同 now 就应真的不同（否则本断言没有区分力）");
});
