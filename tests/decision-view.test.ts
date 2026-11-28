/**
 * 零售经营决策情报视角（第一期 · 管理决策型八模块）守护。
 *
 * 锁住 sc 2026-11-28 口径：
 *  - 按新规格推翻早版六模块：页头状态 / 今日定调 / 今日必读 / 商机洞察 /
 *    风险预警 / 管理关注 / 六大经营领域 / 原有专业内容入口；
 *  - 方案 A 版本切换保留：与旧版共存同一 HTML、切 class，旧视角 DOM 零改动；
 *  - 脱敏（无具体行名/分管行长）、时间真实性、事实与研判区分、证据等级、
 *    折中建议、宁缺毋滥、来源可追溯、超长正文不铺页面全部不回退；
 *  - 顶部快捷跳转 + 各板块返回顶部 + 悬浮按钮 + 角色轻量筛选。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHtml } from "../lib/services/render";
import { DV_MODULE_NAV, DV_ROLE_VIEWS } from "../lib/services/render/decision-view";
import { BUSINESS_DOMAINS } from "../lib/services/vocab/business-domains";
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
    published_at: "2026-11-27T15:10:00.000Z",
    summary: "客观事实摘要。",
    importance: 2,
    rank: 1,
    tags: ["财富"],
    locale: "gz",
    ...over,
  };
}

function report(over: Partial<DailyReport> = {}): DailyReport {
  return {
    date: TODAY,
    hero_line: "",
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
    ...over,
  };
}

/** 从产物中截取决策视角根节点。 */
function decisionPart(html: string): string {
  const i = html.indexOf('id="view-decision"');
  const j = html.indexOf('id="view-classic"');
  assert.ok(i >= 0 && j > i, "决策视角必须在旧视角之前");
  return html.slice(i, j);
}

test("① 两视角共存：默认决策视角、切换开关、旧视角 DOM 全部保留", () => {
  const html = renderHtml(report());
  assert.ok(html.includes('<body class="view-decision">'), "默认进入决策视角");
  assert.ok(html.includes('id="view-decision"') && html.includes('id="view-classic"'), "两视角容器都在");
  assert.ok(html.includes('id="view-switch"') && html.includes('data-view="classic"'), "切换开关存在");
  assert.ok(html.includes('gz_view'), "偏好写入 localStorage");
  assert.ok(html.includes('class="masthead"') && html.includes('id="p-gz"'), "旧视角报头与板块保留");
  assert.ok(!html.includes("分管行长") && !html.includes("广州分行"), "全页脱敏：无身份与具体行名");
});

test("② 八模块结构：页头状态 + 定调 + 必读 + 商机 + 风险 + 关注 + 领域 + 专业内容", () => {
  const html = renderHtml(report({ hero_line: "今日定调测试句。" }));
  const d = decisionPart(html);
  const ids = [...d.matchAll(/class="dv-mod[^"]*" id="(dv-[a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["dv-hero", "dv-mustread", "dv-opportunity", "dv-risk", "dv-attention", "dv-domains", "dv-legacy"]);
  assert.ok(d.includes("简报生成日") && d.includes("去重后资讯") && d.includes("商机") && d.includes("风险"), "页头数据状态齐全");
  for (const title of ["今日定调", "今日必读", "商机洞察", "风险预警", "管理关注", "六大经营领域", "专业内容与深度阅读"]) {
    assert.ok(d.includes(title), `缺模块：${title}`);
  }
  assert.ok(!d.includes("昨日最值得关注") && !d.includes("今晨重要更新"), "早版六模块文案已推翻");
});

test("③ 日期口径：按实际可拿到的数据，不搞事件日四字段", () => {
  const html = renderHtml(report({ hero_line: "x" }), { now: new Date("2026-10-03T01:00:00Z") });
  const d = decisionPart(html);
  assert.ok(d.includes(`简报生成日 ${TODAY}`), "生成日=报告 date");
  assert.ok(d.includes("统计区间") && d.includes("数据更新 09:00"), "注入 now 走北京时间");
  assert.ok(!d.includes("事件实际发生") && !d.includes("first_seen_at"), "不展示事件日四字段（sc 口径）");
});

test("④ 空字段给空状态，不 AI 造数补足", () => {
  const d = decisionPart(renderHtml(report()));
  assert.ok(!d.includes('id="dv-hero"'), "无定调则整块不输出");
  assert.ok(d.includes("宁缺毋滥"), "必读空态明确不造数");
  assert.ok((d.match(/class="dv-empty"/g) ?? []).length >= 4, "多个模块给空状态");
  assert.ok(!d.includes("undefined") && !d.includes("NaN"), "不得露出 undefined/NaN");
});

test("⑤ 事实与研判分栏 + 证据等级 + 来源可追溯", () => {
  const body = item("广州首套房贷利率下调", { url: "https://e.com/house", source_type: "official", tier: "T1" });
  const r = report({
    sections: { gz_local: [body], biz_insight: [], policy_market: [], tech: [], ipo: [] },
    must_read: [{ title: "广州首套房贷利率下调", why: "影响住房金融条线", url: body.url }],
    insights: [{
      topic: "房贷利率下行带来的客户经营机会", tags: ["信贷"], impact: "可能带动住房金融咨询量上升",
      segments: ["零售AUM"], sources: [{ title: "房贷报道", url: body.url }],
    }],
    risk: { topic: "风险", evidence: "依据", impact: "影响", source: "T2" },
  });
  const d = decisionPart(renderHtml(r));
  assert.ok(d.includes("<b>事实</b>") && d.includes("<b>研判</b>") && d.includes("<b>经营影响</b>"));
  assert.ok(d.includes("E1 官方披露") && d.includes("E3 媒体报道"), "证据等级由来源客观标注");
  assert.ok(d.includes('class="dv-src"'), "来源可追溯");
  assert.ok(d.includes("S 重大变化") || d.includes("A 重要变化"), "必读带 S/A/B 分级");
});

test("⑥ 六大经营领域导航 = 新配置六领域，带当日计数，链接复用现成页", () => {
  const body = item("房贷利率调整", { primary_domain: "retail_credit", importance: 3 });
  const d = decisionPart(renderHtml(report({
    sections: { gz_local: [body], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  })));
  assert.equal(BUSINESS_DOMAINS.length, 6);
  for (const name of ["财富管理", "客户经营", "零售信贷", "渠道科技", "风险消保", "区域同业"]) {
    assert.ok(d.includes(name), `缺领域：${name}`);
  }
  assert.ok(d.includes("当日 1 条") && d.includes("含重点 1"), "领域带当日计数与重点亮标");
  assert.ok(d.includes('data-expand-domain="retail_credit"'), "领域卡片改为本页展开按钮");
  assert.ok(d.includes('id="dv-domain-detail-retail_credit"'), "该领域明细容器存在");
  assert.ok(d.includes("房贷利率调整"), "明细列出该领域当日条目");
  assert.ok(!d.includes('class="dv-domain" href='), "不再跳外页（预览死链已消除）");
});

test("⑥b 历史报告无领域字段：渲染期同源降级打标，不 mutate 入参", () => {
  const body = item("广州住房金融政策调整，房贷利率下行", { primary_domain: undefined });
  const r = report({ sections: { gz_local: [body], biz_insight: [], policy_market: [], tech: [], ipo: [] } });
  const snapshot = JSON.stringify(r);
  const d = decisionPart(renderHtml(r));
  assert.ok(d.includes("零售信贷"), "降级打标后领域导航有计数");
  assert.ok(!d.includes("当日暂无") || d.includes("当日 1 条"), "命中领域不再显示当日暂无");
  assert.equal(JSON.stringify(r), snapshot, "渲染不得 mutate 入参报告");
});

test("⑥c 领域明细：展开脚本 + 原文链接 + 空状态，不跳 topics.html", () => {
  const body = item("房贷明细条目", { url: "https://e.com/detail", primary_domain: "retail_credit" });
  const r = report({ sections: { gz_local: [body], biz_insight: [], policy_market: [], tech: [], ipo: [] } });
  const html = renderHtml(r);
  const d = decisionPart(html);
  assert.ok(/data-expand-domain/.test(html) && /dv-domain-detail-/.test(html), "展开交互脚本存在");
  assert.ok(d.includes('href="https://e.com/detail" target="_blank" rel="noopener noreferrer"'), "明细条目直连原文");
  assert.ok(d.includes("当日暂无该领域条目"), "无条目的领域给空状态");
  const domSection = d.slice(d.indexOf('id="dv-domains"'), d.indexOf('id="dv-legacy"'));
  assert.ok(!domSection.includes('href="../topics.html"'), "领域导航不再指向预览会 404 的 topics.html");
  assert.equal((domSection.match(/data-expand-domain=/g) ?? []).length, 6, "六个领域卡片齐全");
});

test("⑦ 角色轻量筛选：五角色 + data-domain 锚点，不新增 AI 任务", () => {
  const d = decisionPart(renderHtml(report()));
  assert.equal(DV_ROLE_VIEWS.length, 5, "全景 + 四业务部门");
  for (const r of DV_ROLE_VIEWS) assert.ok(d.includes(`data-role="${r.id}"`), `缺角色：${r.label}`);
  const html = renderHtml(report());
  assert.ok(/querySelectorAll\('\.dv-card\[data-domain\]'\)/.test(html), "筛选只作用于带领域标签的卡片（脚本在 DOM 外）");
});

test("⑧ 决策 DOM 不产生重复 itm id（锚点唯一性不回退）", () => {
  const body = item("正文卡", { url: "https://e.com/a" });
  const d = decisionPart(renderHtml(report({
    sections: { gz_local: [body], biz_insight: [], policy_market: [], tech: [], ipo: [] },
    must_read: [{ title: "正文卡", why: "理由", url: body.url }],
  })));
  assert.ok(!d.includes('id="itm-'), "决策视角不得新增 itm 锚点 id");
  assert.ok(d.includes("dv-card"), "使用独立 dv-card 类名");
});

test("⑨ 管理关注 ≤3 项，折中建议措辞，非已作决定，不下操作指令", () => {
  const d = decisionPart(renderHtml(report({
    must_read: [
      { title: "A", why: "理由A", url: "https://e.com/a" },
      { title: "B", why: "理由B", url: "https://e.com/b" },
      { title: "C", why: "理由C", url: "https://e.com/c" },
      { title: "D", why: "理由D", url: "https://e.com/d" },
    ],
    risk: { topic: "风险", evidence: "依据", impact: "影响", source: "T2" },
  })));
  assert.ok((d.match(/class="dv-card dv-attn"/g) ?? []).length <= 3);
  assert.ok(d.includes("建议关注") && d.includes("非已作决定"), "折中建议措辞 + 非已作决定");
  assert.ok(!d.includes("本周完成") && !d.includes("务必") && !d.includes("新增贷款投放"), "不输出业务指令/指标目标");
});

test("⑩ 合规：脱敏 / 加密零容忍 / CSS 变量自洽", () => {
  const html = renderHtml(report());
  for (const bad of ["crypto", "fear-greed", "BTC", "加密", "币圈", "广州分行", "分管行长", "--cmb"]) {
    assert.ok(!html.includes(bad), `产物出现违禁字样：${bad}`);
  }
  const defined = new Set([...html.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const bare = new Set([...html.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g)].map((m) => m[1]));
  const undef = [...bare].filter((v) => !defined.has(v) && v !== "--brand");
  assert.deepEqual(undef, [], `裸引用未定义变量：${undef.join(", ")}`);
});

test("⑪ 可复现：同一 report + 注入 → 两次渲染逐字一致", () => {
  const r = report({ hero_line: "定调" });
  r.sections.gz_local = [item("科技前沿条目")];
  const a = renderHtml(r, { now: new Date("2026-10-03T01:00:00Z") });
  const b = renderHtml(r, { now: new Date("2026-10-03T01:00:00Z") });
  assert.equal(a, b);
});

test("⑫ 顶部快捷跳转：锚点全部命中模块，空定调不产生死锚点", () => {
  const withHero = decisionPart(renderHtml(report({ hero_line: "定调" })));
  const nav = (withHero.match(/<nav class="dv-quicknav"[\s\S]*?<\/nav>/) ?? [""])[0];
  const targets = [...nav.matchAll(/href="#(dv-[a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(targets, DV_MODULE_NAV.map((m) => m.id), "有定调时跳转目标与模块一一对应");
  for (const id of targets) assert.ok(withHero.includes(`id="${id}"`), `跳转目标不存在：${id}`);
  const noHero = decisionPart(renderHtml(report()));
  const nav2 = (noHero.match(/<nav class="dv-quicknav"[\s\S]*?<\/nav>/) ?? [""])[0];
  assert.ok(!nav2.includes("dv-hero"), "空定调整块不输出，快捷导航同步去掉该锚点");
  for (const id of [...nav2.matchAll(/href="#(dv-[a-z]+)"/g)].map((m) => m[1])) {
    assert.ok(noHero.includes(`id="${id}"`), `空定调下仍有死锚点：${id}`);
  }
  assert.ok(/\.dv-quicknav\s*\{[^}]*flex-wrap:\s*wrap/.test(renderHtml(report())), "导航换行不横滚");
});

test("⑬ 返回顶部：板块底部链接 + 悬浮按钮 + 锚点 + 平滑滚动", () => {
  const html = renderHtml(report());
  const d = decisionPart(html);
  assert.ok((d.match(/class="dv-back" href="#dv-top"/g) ?? []).length === 6, "空定调时六模块底部均有返回链接");
  const withHero = decisionPart(renderHtml(report({ hero_line: "定调" })));
  assert.ok((withHero.match(/class="dv-back" href="#dv-top"/g) ?? []).length === 7, "有定调时七模块均有返回链接");
  assert.ok(d.includes('id="dv-float-top"') && /position:\s*fixed/.test(html));
  assert.ok(/scrollY[\s\S]{0,120}>320/.test(html), "滚过一屏才出现");
  assert.ok(/scrollIntoView\(\{behavior:'smooth',block:'start'\}\)/.test(html));
});

test("⑭ 风险来源：超长正文不铺页面，正常标题保留（11-28 真实样本）", () => {
  const longTitle = "【中国证监会严肃查处两起编造传播证券市场误导性信息案件】近日，中国证监会对安某、乔某涉嫌编造传播涉及上市公司的误导性信息依法做出行政处罚，没收违法所得并处罚款，相关言论经网络渠道大范围传播导致股价异常波动。";
  const url = "https://www.cnfin.com/yw-lb/detail/20261127/4501413_1.html";
  const d = decisionPart(renderHtml(report({
    risk: { topic: "查处误导信息", evidence: "行政处罚", impact: "合规审视", source: "T1", sources: [{ title: longTitle, url }] },
  })));
  assert.ok(!d.includes(longTitle) && d.includes("cnfin.com · 原文"));
  assert.ok(d.includes(`href="${url}"`), "链接仍可溯源");
});
