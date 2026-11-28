/**
 * 零售经营决策情报视角（L1 领导首页 · 一期）守护。
 *
 * 锁住 sc 2026-11-28 拍板的口径：
 *  - 方案 A：决策视角与旧版资讯视角**共存同一 HTML**，JS 切 class，共用一份 report；
 *  - 一期只做六模块 + 切换，不碰数据契约 / AI / 评分 / 审核；
 *  - 时间真实性、事实与研判区分、来源可追溯、零操作建议、脱敏合规全部不回退；
 *  - 旧视角产物不变量（panel / 锚点 / CSS 变量）不受新 DOM 影响。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHtml } from "../lib/services/render";
import { BUSINESS_DOMAINS, DV_MODULE_NAV } from "../lib/services/render/decision-view";
import type { DailyReport, ReportItem } from "../lib/contracts/report";
import { todayKey } from "../lib/utils/time";

const TODAY = todayKey();
const MMDD = `${TODAY.slice(5, 7)}/${TODAY.slice(8, 10)}`;

function item(title: string, over: Partial<ReportItem> = {}): ReportItem {
  return {
    url: `https://e.com/${encodeURIComponent(title).slice(0, 10)}`,
    title_cn: title,
    source: "测试源",
    source_type: "media",
    date: MMDD,
    summary: "客观事实摘要。",
    importance: 2,
    rank: 1,
    tags: ["财富"],
    locale: "national",
    ...over,
  };
}

function report(over: Partial<DailyReport> = {}): DailyReport {
  return {
    date: TODAY,
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
    ...over,
  };
}

/** 从产物中截取决策视角根节点（view-decision section）。 */
function decisionPart(html: string): string {
  const i = html.indexOf('id="view-decision"');
  const j = html.indexOf('id="view-classic"');
  assert.ok(i >= 0 && j > i, "决策视角必须在旧视角之前");
  return html.slice(i, j);
}

test("① 两视角共存：默认决策视角、切换开关、旧视角 DOM 全部保留", () => {
  const html = renderHtml(report());
  assert.ok(html.includes('<body class="view-decision">'), "默认进入决策视角");
  assert.ok(html.includes('id="view-decision"'), "决策视角容器存在");
  assert.ok(html.includes('id="view-classic"'), "旧版资讯视角容器存在");
  assert.ok(html.includes('id="view-switch"'), "视角切换开关存在");
  assert.ok(html.includes('data-view="decision"') && html.includes('data-view="classic"'), "两个切换按钮都在");
  assert.ok(html.includes('gz_view'), "偏好写入 localStorage（键存在）");
  // 旧视角核心结构仍在（零改动）
  assert.ok(html.includes('class="masthead"'), "旧报头保留");
  assert.ok(html.includes('id="p-gz"'), "旧板块面板保留");
});

test("② 六模块齐全且顺序固定（PRD 4.2~4.7）", () => {
  const html = renderHtml(report());
  const d = decisionPart(html);
  const ids = [...d.matchAll(/class="dv-mod" id="(dv-[a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, [
    "dv-yesterday",
    "dv-morning",
    "dv-opportunity",
    "dv-risk",
    "dv-attention",
    "dv-domains",
  ]);
  for (const title of ["昨日最值得关注的", "今晨重要更新", "经营机会", "风险预警", "今日管理关注", "六大业务专题"]) {
    assert.ok(d.includes(title), `缺模块标题：${title}`);
  }
  assert.ok(d.includes("零售经营决策情报 · 外部经营环境观察"), "客观项目描述存在");
  assert.ok(!d.includes("分管行长") && !d.includes("行长专属"), "首页不得出现身份专属描述");
});

test("③ 日期四要素：生成日 / 昨日统计 / 今晨截止 / 数据更新；不编造事件日", () => {
  const html = renderHtml(report(), { now: new Date("2026-10-03T01:00:00Z") });
  const d = decisionPart(html);
  assert.ok(d.includes(`简报生成日 ${TODAY}`), "生成日 = 报告 date");
  assert.ok(d.includes("昨日事件统计"), "昨日统计日标签存在");
  assert.ok(d.includes("今晨更新截至 09:00"), "注入 now 走北京时间（01:00Z → 09:00）");
  assert.ok(d.includes("数据更新 09:00"), "数据更新时间存在");
  assert.ok(!d.includes("事件发生"), "不得编造事件实际发生时间（无字段）");
});

test("④ 空字段宁愿空状态，不 AI 造数补足（PRD 4.2 / 1.4）", () => {
  const html = renderHtml(report());
  const d = decisionPart(html);
  assert.ok(d.includes("宁缺毋滥"), "昨日模块空态明确不造数");
  assert.ok((d.match(/class="dv-empty"/g) ?? []).length >= 4, "空数据时多个模块给出空状态");
  assert.ok(!d.includes("undefined") && !d.includes("NaN"), "不得露出 undefined/NaN");
});

test("⑤ 事实与 AI 研判分栏标注，结论带来源（PRD 1.4 / 4.2）", () => {
  const body = item("广州首套房贷利率下调", { url: "https://e.com/house" });
  const r = report({
    sections: { gz_local: [body], biz_insight: [], policy_market: [], tech: [], ipo: [] },
    must_read: [{ title: "广州首套房贷利率下调", why: "影响住房金融条线", url: body.url }],
    insights: [
      {
        topic: "房贷利率下行带来的客户经营机会",
        tags: ["信贷"],
        impact: "可能带动住房金融咨询量上升",
        segments: ["零售AUM"],
        sources: [{ title: "房贷报道", url: body.url }],
      },
    ],
  });
  const d = decisionPart(renderHtml(r));
  assert.ok(d.includes("<b>事实</b>"), "客观事实摘要标注");
  assert.ok(d.includes("<b>研判</b>"), "AI 研判单独标注");
  assert.ok(d.includes("<b>经营影响</b>"), "经营影响单独标注");
  assert.ok(d.includes("关注理由"), "关注理由呈现");
  assert.ok(d.includes('class="dv-src"'), "来源可追溯（链接或标注）");
});

test("⑥ 六大业务专题入口 = PRD 六个领域，链接到现有专题页（不新增死链）", () => {
  const d = decisionPart(renderHtml(report()));
  assert.equal(BUSINESS_DOMAINS.length, 6, "恰好六大领域");
  for (const label of ["财富管理", "客户经营", "零售信贷", "渠道科技", "风险消保", "区域同业"]) {
    assert.ok(d.includes(label), `缺专题入口：${label}`);
  }
  assert.ok(d.includes('href="../topics.html"'), "入口指向现有专题页（复用，不新建死链）");
});

test("⑦ 决策 DOM 不产生重复 itm id（锚点唯一性不回退）", () => {
  const body = item("正文卡", { url: "https://e.com/a" });
  const r = report({
    sections: { gz_local: [body], biz_insight: [], policy_market: [], tech: [], ipo: [] },
    must_read: [{ title: "正文卡", why: "理由", url: body.url }],
  });
  const d = decisionPart(renderHtml(r));
  // 决策视角卡片一律 dv-card，不挂 itm- 锚点（链接可以有，id 不能有）
  assert.ok(!d.includes('id="itm-'), "决策视角不得新增 itm 锚点 id");
  assert.ok(d.includes("dv-card"), "使用独立的 dv-card 类名");
});

test("⑧ 管理关注 ≤3 项，措辞为建议性质，不下操作指令", () => {
  const r = report({
    must_read: [
      { title: "A", why: "理由A", url: "https://e.com/a" },
      { title: "B", why: "理由B", url: "https://e.com/b" },
      { title: "C", why: "理由C", url: "https://e.com/c" },
      { title: "D", why: "理由D", url: "https://e.com/d" },
    ],
    risk: { topic: "风险", evidence: "依据", impact: "影响", source: "T2" },
  });
  const d = decisionPart(renderHtml(r));
  assert.ok((d.match(/class="dv-card dv-attn"/g) ?? []).length <= 3, "管理关注不超过 3 项");
  assert.ok(d.includes("建议关注"), "用建议措辞");
  assert.ok(d.includes("非已作决定"), "明确不是行领导已作决定");
  assert.ok(!d.includes("本周完成") && !d.includes("务必"), "不输出操作指令");
});

test("⑨ 合规：脱敏 / 加密零容忍 / CSS 变量自洽 不因新 DOM 回退", () => {
  const html = renderHtml(report());
  for (const bad of ["crypto", "fear-greed", "BTC", "加密", "币圈", "--cmb", "gzcmbdf3"]) {
    assert.ok(!html.includes(bad), `产物出现违禁字样：${bad}`);
  }
  const defined = new Set([...html.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const bare = new Set([...html.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g)].map((m) => m[1]));
  const undef = [...bare].filter((v) => !defined.has(v) && v !== "--brand");
  assert.deepEqual(undef, [], `裸引用未定义变量：${undef.join(", ")}`);
});

test("⑩ 可复现：同一 report + 注入 → 两次渲染逐字一致", () => {
  const r = report();
  r.sections.gz_local = [item("科技前沿条目")];
  const a = renderHtml(r, { now: new Date("2026-10-03T01:00:00Z") });
  const b = renderHtml(r, { now: new Date("2026-10-03T01:00:00Z") });
  assert.equal(a, b, "相同输入必须逐字一致（隐式时钟/随机回归）");
});

test("⑪ 顶部快捷跳转：6 个锚点全部命中模块，位于报头内且换行不横滚（PRD 8.3）", () => {
  const html = renderHtml(report());
  const d = decisionPart(html);
  assert.ok(d.includes('<nav class="dv-quicknav"') && d.includes('aria-label="模块快捷跳转"'), "顶部快捷跳转导航存在");
  const nav = (d.match(/<nav class="dv-quicknav"[\s\S]*?<\/nav>/) ?? [""])[0];
  const targets = [...nav.matchAll(/href="#(dv-[a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(targets, DV_MODULE_NAV.map((m) => m.id), "六个跳转目标与模块一一对应且顺序一致");
  for (const id of targets) assert.ok(d.includes(`id="${id}"`), `跳转目标不存在：${id}`);
  assert.ok(d.indexOf("dv-quicknav") < d.indexOf('id="dv-yesterday"'), "导航位于首个模块之前（顶部）");
  assert.ok(/\.dv-quicknav\s*\{[^}]*flex-wrap:\s*wrap/.test(html), "导航自动换行，重要内容无需横向滚动");
  assert.ok(!d.includes("分管行长"), "导航区同样不得出现身份描述");
});

test("⑫ 返回顶部：六个板块底部链接 + 悬浮按钮 + 锚点，滚动过一屏才出现", () => {
  const html = renderHtml(report());
  const d = decisionPart(html);
  assert.ok(d.includes('id="dv-top"'), "顶部导航锚点存在");
  assert.ok((d.match(/class="dv-back" href="#dv-top"/g) ?? []).length === 6, "六个板块底部均有返回顶部导航链接");
  assert.ok(d.includes('id="dv-float-top"') && d.includes("返回顶部导航"), "右下角悬浮按钮存在且语义明确");
  assert.ok(/position:\s*fixed/.test(html) && /dv-float-top\.is-visible\s*\{\s*display:\s*flex/.test(html), "悬浮按钮 fixed 定位且默认隐藏、按需显示");
  assert.ok(/scrollY[\s\S]{0,120}>320/.test(html), "滚过一屏才出现，避免遮挡首屏");
  assert.ok(/scrollIntoView\(\{behavior:'smooth',block:'start'\}\)/.test(html), "跳转平滑滚动到顶部导航");
});

test("⑬ 风险来源：超长正文不铺在页面上，正常标题原样显示（2026-11-28 真实样本）", () => {
  const longTitle = "【中国证监会严肃查处两起编造传播证券市场误导性信息案件】近日，中国证监会对安某、乔某涉嫌编造传播涉及上市公司的误导性信息依法做出行政处罚，没收违法所得并处罚款，相关低俗言论经网络渠道大范围传播导致股价异常波动。";
  const url = "https://www.cnfin.com/yw-lb/detail/20261127/4501413_1.html";
  const d = decisionPart(renderHtml(report({
    risk: { topic: "查处编造误导信息", evidence: "行政处罚", impact: "合规审视", source: "T1", sources: [{ title: longTitle, url }] },
  })));
  assert.ok(!d.includes(longTitle), "整篇正文不得铺在来源位置");
  assert.ok(d.includes("cnfin.com · 原文"), "超长标题退化为域名 + 原文");
  assert.ok(d.includes(`href="${url}"`), "链接仍可溯源");
  const short = decisionPart(renderHtml(report({
    risk: { topic: "风险", evidence: "依据", impact: "影响", source: "T2", sources: [{ title: "正常来源标题", url: "https://e.com/a" }] },
  })));
  assert.ok(short.includes(">正常来源标题</a>"), "正常标题原样保留");
});
