/**
 * E2 复制/导出/收藏 + A4 反向「听这段」（2026-09-17）。
 *
 * 锁四件事：
 *  ① 三条能力都注入到页面，且**纯前端**（剪贴板 / localStorage / Blob 下载，零后端）；
 *  ② 报告日期走 `<meta name="report-date">`，脚本**不得读墙钟**（服务层禁 Date.now()）；
 *  ③ 「听这段」只在有音频与段落时出现（无音频的期次不该出现死按钮）；
 *  ④ 工具条是 `type=button`，不会误触发卡片标题的详情页跳转。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generatePageActionsScript,
  renderFavBar,
  renderReportDateMeta,
} from "../lib/services/render/page-actions";
import { renderHtml } from "../lib/services/render";
import type { DailyReport, ReportItem } from "../lib/contracts/report";

function item(over: Partial<ReportItem> = {}): ReportItem {
  return {
    url: "https://example.com/a1",
    title_cn: "条目一",
    source: "证券时报",
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

function report(): DailyReport {
  return {
    date: "2026-09-17",
    hero_line: "",
    must_read: [{ url: "https://example.com/a1", why: "原因", title: "必读一" }],
    insights: [],
    sections: { gz_local: [item()], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  } as unknown as DailyReport;
}

test("① 三条能力齐备且纯前端（无后端调用）", () => {
  const page = renderHtml(report());
  assert.ok(page.includes('class="card-actions"') === false, "工具条由脚本注入，模板里不该有静态节点");
  assert.ok(page.includes("card-actions"), "须注入工具条脚本");
  assert.ok(page.includes("navigator.clipboard"), "复制走剪贴板");
  assert.ok(page.includes("legacyCopy"), "须有 execCommand 兜底（微信内置浏览器常见）");
  assert.ok(page.includes("localStorage"), "收藏走 localStorage");
  assert.ok(page.includes("URL.createObjectURL"), "导出走 Blob 下载");
  assert.ok(page.includes("'gz_fav'"), "收藏键须稳定（跨期可取回）");
  assert.ok(!/fetch\(|XMLHttpRequest/.test(generatePageActionsScript()), "不得引入任何后端请求");
});

test("② 日期取自 meta，脚本不读墙钟", () => {
  const page = renderHtml(report());
  assert.ok(page.includes('<meta name="report-date" content="2026-09-17">'), "须写入报告日期 meta");
  const script = generatePageActionsScript();
  assert.ok(!script.includes("Date.now"), "不得用墙钟（架构门禁禁隐式时钟）");
  assert.ok(!/new Date\(\)/.test(script), "不得裸 new Date()");
  assert.ok(script.includes("briefing-' + (PAGE_DATE"), "导出文件名须带报告日期");
});

test("③ 「听这段」按需出现：有音频段才渲染按钮", () => {
  const script = generatePageActionsScript();
  assert.ok(script.includes("'▶ 听这段'"), "脚本须包含反向跳段按钮");
  assert.ok(script.includes("segOf"), "须按 data-audio-section 找对应段");
  assert.ok(/if \(audio && seg\)/.test(script), "无音频/无对应段时不得注入按钮");
  // 有音频的页面同时具备播放器与段落数据（按钮才能真正生效）
  const withAudio = renderHtml(report(), {
    audio: {
      src: "audio/briefing-2026-09-17.mp3",
      duration: "约 2 分",
      segments: [{ id: "must", startSec: 12, durationSec: 30, refs: [], text: "必读" }],
    },
  });
  assert.ok(withAudio.includes('id="audio-player"'));
  assert.ok(withAudio.includes('id="audio-segments"'));
});

test("④ 按钮均为 type=button（不得误触发详情页跳转），收藏栏齐备", () => {
  const script = generatePageActionsScript();
  const btns = script.match(/\.type = 'button'/g) ?? [];
  assert.ok(btns.length >= 3, `复制/收藏/听这段三个按钮都要 type=button，实际 ${btns.length}`);
  assert.ok(script.includes("className = 'act-copy'") && script.includes("'act-fav'") && script.includes("'act-listen'"));

  const bar = renderFavBar();
  assert.ok(bar.includes('id="fav-bar"') && bar.includes('id="fav-list"'), "收藏栏容器齐备");
  assert.ok(bar.includes("fav-export") && bar.includes("fav-clear"), "导出/清空入口齐备");
  assert.ok(/hidden/.test(bar), "无收藏时默认收起（不占首屏）");
  assert.equal(renderReportDateMeta("2026-09-17"), '<meta name="report-date" content="2026-09-17">');
  // 注入顺序：工具条脚本先于音频高亮脚本（此时工具栏已就位，高亮只管加 class/徽章）
  // 用**只出现在各自脚本体里**的特征串比较（CSS 里也有 gz-audio-flash/audio-now-badge，
  // 拿它们比会得到错误的先后关系）。
  const page = renderHtml(report(), {
    audio: { src: "a.mp3", duration: "1 分", segments: [{ id: "must", startSec: 0, durationSec: 10, refs: [], text: "x" }] },
  });
  const iActions = page.indexOf("navigator.clipboard");
  const iHighlight = page.indexOf('getElementById("audio-now-hint")');
  assert.ok(iActions > 0 && iHighlight > 0, "两个脚本都应注入");
  assert.ok(iActions < iHighlight, "工具条脚本应在音频高亮脚本之前注入");
});
