/**
 * 零售经营决策情报视角（第一期 · 管理决策型八模块）守护。
 *
 * 锁住 sc 2026-11-28 口径：
 *  - 按新规格推翻早版六模块：页头状态 / 今日定调 / 今日必读 / 商机洞察 /
 *    风险预警 / 管理关注 / 六大经营领域 / 原有专业内容入口；
 *  - 方案 A 版本切换保留：与旧版共存同一 HTML、切 class，旧视角 DOM 零改动；
 *  - 脱敏（无具体行名/分管行长）、时间真实性、事实与研判区分、证据等级、
 *    折中建议、宁缺毋滥、来源可追溯、超长正文不铺页面全部不回退；
 *  - 顶部快捷跳转 + 各板块返回顶部 + 悬浮按钮 + 核心卡片横滑 + 六大领域平铺标签。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHtml } from "../lib/services/render";
import { DV_MODULE_NAV } from "../lib/services/render/decision-view";
import { BUSINESS_DOMAINS } from "../lib/services/vocab/business-domains";
import type { DailyReport, ReportAttention, ReportItem, StockRecap } from "../lib/contracts/report";
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

/** 管理关注样例（2026-11-28 起由组装阶段生成，渲染层只读；跨条线=domains≥2）。 */
const ATTENTION: ReportAttention[] = [
  {
    id: "att-1",
    topic: "客户资产配置需求与产品策略同步调整",
    rationale: "多家银行调整财富产品策略，黄金配置区间上调至 5%—28%。",
    significance: "可能影响客户沟通口径与产品适配节奏，值得关注后续市场反应。",
    domains: ["wealth_aum", "customer_growth"],
    source_urls: ["https://e.com/mr-1", "https://e.com/mr-2"],
    confidence: "high",
  },
];

const STOCK: StockRecap = {
  aShare: {
    overview: "A股放量上涨，成交额突破两万亿。",
    sectors: ["科创50大涨", "券商板块活跃"],
    indices: [{ name: "上证指数", value: "3606.49", changePct: "+3.73%" }],
    meta: { source: "东方财富", quoteSource: "新浪行情", date: "11/28" },
  },
  hk: { overview: "港股跟随上行。", sectors: ["科技股领涨"], indices: [{ name: "恒生指数", value: "26000", changePct: "+1.2%" }] },
  us: { overview: "美股三大指数收涨。", sectors: ["半导体走强"], indices: [{ name: "纳斯达克", value: "19000", changePct: "+0.8%" }] },
  quoteChannel: "新浪行情",
  quoteDate: "11/28",
};

/** 从产物中截取决策视角根节点。 */
function decisionPart(html: string): string {
  const i = html.indexOf('id="view-decision"');
  const j = html.indexOf('id="view-classic"');
  assert.ok(i >= 0 && j > i, "决策视角必须在旧视角之前");
  return html.slice(i, j);
}

test("① 两视角共存：默认旧版资讯视角、切换开关、决策视角 DOM 全部保留", () => {
  const html = renderHtml(report());
  assert.ok(html.includes('<body class="view-classic">'), "默认进入旧版资讯视角（19:25 回退）");
  assert.ok(html.includes('id="view-decision"') && html.includes('id="view-classic"'), "两视角容器都在");
  assert.ok(html.includes('id="view-switch"') && html.includes('data-view="classic"'), "切换开关存在");
  assert.match(html, /class="view-switch-btn active" data-view="classic"/, "默认选中旧版资讯");
  assert.ok(html.includes('gz_view'), "偏好写入 localStorage");
  assert.ok(html.includes('class="masthead"') && html.includes('id="p-gz"'), "旧视角报头与板块保留");
  assert.ok(!html.includes("分管行长") && !html.includes("广州分行"), "全页脱敏：无身份与具体行名");
  assert.ok(!decisionPart(html).includes("行长"), "新版首页不暴露行长身份");
});

test("② 八模块结构：页头状态 + 定调 + 必读 + 商机 + 风险 + 关注 + 领域 + 专业内容", () => {
  const body = item("房贷利率调整", { primary_domain: "retail_credit" });
  const html = renderHtml(report({
    hero_line: "今日定调测试句。",
    attention: ATTENTION,
    stock_recap: STOCK,
    must_read: [
      { title: "房贷利率调整", why: "影响住房金融条线", url: body.url },
      { title: "跨境结算便利化", why: "影响跨境客群", url: "https://e.com/b" },
      { title: "黄金配置区间", why: "影响财富货架", url: "https://e.com/c" },
    ],
    sections: { gz_local: [body], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  }));
  const d = decisionPart(html);
  const ids = [...d.matchAll(/class="dv-mod[^"]*" id="(dv-[a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["dv-key", "dv-attention", "dv-priorities", "dv-stock", "dv-opportunity", "dv-risk", "dv-domains", "dv-legacy"]);
  assert.ok(d.includes('id="dv-core"'), "核心判断不是 dv-mod，单独常驻");
  assert.ok(d.includes("生成日") && d.includes("资讯") && d.includes("重点 3"), "页头数据状态齐全且紧凑");
  for (const title of ["核心判断", "三件重点变化", "管理层关注", "今日经营重点", "股市行情", "商机洞察", "风险预警", "六大经营领域", "专业内容与深度阅读"]) {
    assert.ok(d.includes(title), `缺模块：${title}`);
  }
  assert.ok(!d.includes("昨日最值得关注") && !d.includes("今晨重要更新"), "早版六模块文案已推翻");
});

test("③ 日期口径：按实际可拿到的数据，不搞事件日四字段", () => {
  const html = renderHtml(report({ hero_line: "x" }), { now: new Date("2026-10-03T01:00:00Z") });
  const d = decisionPart(html);
  assert.ok(d.includes(`生成日 ${TODAY}`), "生成日=报告 date");
  assert.ok(d.includes("更新 09:00"), "注入 now 走北京时间");
  assert.ok(!d.includes("事件实际发生") && !d.includes("first_seen_at"), "不展示事件日四字段（sc 口径）");
});

test("④ 空字段给空状态，不 AI 造数补足", () => {
  const d = decisionPart(renderHtml(report()));
  assert.ok(d.includes("今日暂无足以改变经营判断的重大变化"), "无数据时给固定核心判断，不造事件");
  assert.ok(!d.includes('id="dv-key"') && !d.includes('id="dv-priorities"'), "无必读则不输出重点变化/经营重点");
  assert.ok((d.match(/class="dv-empty"/g) ?? []).length >= 2, "商机/风险给空状态");
  assert.ok(!d.includes('id="dv-attention"'), "无独立议题时管理关注整块不展示");
  assert.ok(!d.includes('id="dv-domains"'), "无领域内容时整块不展示");
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
  assert.ok(d.includes("<b>发生了什么</b>") && d.includes("<b>对经营意味着什么</b>") && d.includes("<b>接下来关注什么</b>"), "经营重点三段式齐全");
  assert.ok(d.includes("可能带动住房金融咨询量上升"), "同 URL 商机 impact 回填为经营影响");
  assert.ok(d.includes('class="dv-src"'), "来源可追溯");
  assert.ok(d.includes("S 重大变化") || d.includes("A 重要变化"), "经营重点带 S/A/B 分级");
  assert.ok(d.includes("事实依据") && d.includes("潜在影响"), "风险卡保留事实依据/潜在影响");
});

test("⑥ 只展示当日有内容的领域，带当日计数，链接复用现成页", () => {
  const body = item("房贷利率调整", { primary_domain: "retail_credit", importance: 3 });
  const d = decisionPart(renderHtml(report({
    sections: { gz_local: [body], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  })));
  assert.equal(BUSINESS_DOMAINS.length, 6);
  assert.ok(d.includes("零售信贷"), "有内容的领域展示");
  assert.ok(d.includes("当日 1 条") && d.includes("含重点 1"), "领域带当日计数与重点亮标");
  assert.ok(d.includes('data-domain-tab="retail_credit"'), "领域改为平铺标签");
  assert.ok(d.includes('id="dv-domain-panel-retail_credit"'), "该领域明细面板存在");
  assert.ok(d.includes("房贷利率调整"), "明细列出该领域当日条目");
  assert.equal((d.match(/data-domain-tab=/g) ?? []).length, 1, "空领域不占 tab");
  assert.ok(!d.includes('data-domain-tab="wealth_aum"'), "无内容领域不出现");
  assert.ok(!d.includes('class="dv-domain" href='), "不再跳外页（预览死链已消除）");
});

test("⑥b 历史报告无领域字段：渲染期同源降级打标，不 mutate 入参", () => {
  const body = item("广州房贷利率下调，按揭与首付政策调整", { primary_domain: undefined });
  const r = report({ sections: { gz_local: [body], biz_insight: [], policy_market: [], tech: [], ipo: [] } });
  const snapshot = JSON.stringify(r);
  const d = decisionPart(renderHtml(r));
  assert.ok(d.includes("零售信贷"), "降级打标后领域导航有计数");
  assert.ok(d.includes("当日 1 条"), "命中领域显示当日计数");
  assert.ok(!d.includes("当日暂无该领域条目"), "空领域不再用空状态占位");
  assert.equal(JSON.stringify(r), snapshot, "渲染不得 mutate 入参报告");
});

test("⑥c 领域明细：标签切换脚本 + 原文链接 + 空状态，不跳 topics.html", () => {
  const body = item("房贷明细条目", { url: "https://e.com/detail", primary_domain: "retail_credit" });
  const r = report({ sections: { gz_local: [body], biz_insight: [], policy_market: [], tech: [], ipo: [] } });
  const html = renderHtml(r);
  const d = decisionPart(html);
  assert.ok(/data-domain-tab/.test(html) && /dv-domain-panel-/.test(html), "标签切换结构存在");
  assert.ok(/selectDomain/.test(html) && /\.dv-domain-panel/.test(html), "切换脚本存在（面板显隐）");
  assert.ok(d.includes('href="https://e.com/detail" target="_blank" rel="noopener noreferrer"'), "明细条目直连原文");
  const domSection = d.slice(d.indexOf('id="dv-domains"'), d.indexOf('id="dv-legacy"'));
  assert.ok(!domSection.includes('href="../topics.html"'), "领域导航不再指向预览会 404 的 topics.html");
  assert.equal((domSection.match(/data-domain-tab=/g) ?? []).length, 1, "只保留有内容的领域标签");
  assert.ok(!d.includes("当日暂无该领域条目"), "空领域整块不出现");
});

test("⑦ 有内容的领域才出 tab；整块全空则连板块一起隐藏", () => {
  const body = item("房贷利率调整", { primary_domain: "retail_credit" });
  const html = renderHtml(report({ sections: { gz_local: [body], biz_insight: [], policy_market: [], tech: [], ipo: [] } }));
  const d = decisionPart(html);
  const dom = d.slice(d.indexOf('id="dv-domains"'), d.indexOf('id="dv-legacy"'));
  assert.ok(!dom.includes('class="dv-roles"'), "过滤条已移除（不再按领域过滤上方卡片）");
  assert.ok(!/class="dv-role[\s"]/.test(dom), "不再有领域过滤按钮");
  const tabs = [...dom.matchAll(/data-domain-tab="([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ["retail_credit"], "只保留有内容的领域标签");
  assert.equal((dom.match(/role="tab"/g) ?? []).length, 1, "一个 tab");
  assert.equal((dom.match(/role="tabpanel"/g) ?? []).length, 1, "一块面板");
  assert.ok(dom.includes('role="tablist"'), "标签条有 tablist 语义");
  assert.ok(!/data-domain="[a-z_]+"/.test(d), "卡片不再挂仅供过滤的 data-domain");
  for (const bad of ["全景", "零售银行部", "私行部", "财富管理部"]) {
    assert.ok(!d.includes(bad), `角色视图已移除：${bad}`);
  }

  const empty = decisionPart(renderHtml(report()));
  assert.ok(!empty.includes('id="dv-domains"'), "全空时整个领域板块不输出");
  assert.ok(!empty.includes('href="#dv-domains"'), "快捷导航同步去掉领域锚点");
});

test("⑦b 核心阅读区纵向排列：三件变化/经营重点/股市不得横滑", () => {
  const r = report({
    hero_line: "定调",
    must_read: [{ title: "必读", why: "理由", url: "https://e.com/a" }],
    insights: [{ topic: "商机", tags: [], impact: "影响", sources: [{ title: "源", url: "https://e.com/a" }] }],
    risk: { topic: "风险", evidence: "依据", impact: "影响", source: "T2" },
    attention: [ATTENTION[0], { ...ATTENTION[0], id: "att-2", topic: "另一条管理议题", source_urls: ["https://e.com/mr-3"] }],
  });
  const html = renderHtml(r);
  const d = decisionPart(html);
  const key = d.slice(d.indexOf('id="dv-key"'), d.indexOf('id="dv-attention"'));
  const pri = d.slice(d.indexOf('id="dv-priorities"'), d.indexOf('id="dv-opportunity"'));
  assert.ok(!key.includes("dv-scroller") && !pri.includes("dv-scroller"), "第一/二层不横滑");
  assert.equal((d.match(/class="dv-scroller"/g) ?? []).length, 2, "只有商机/风险保留第三层横滑");
  assert.ok(/mask-image:linear-gradient/.test(html), "第三层横滑仍有右缘渐隐");
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

test("⑨ 管理关注：只读独立研判，不复述必读/风险；跨条线看经营领域不看标签数量", () => {
  const d = decisionPart(
    renderHtml(
      report({
        must_read: [
          { title: "多家银行调整财富产品策略", why: "理由A", url: "https://e.com/a" },
          { title: "黄金配置需求上升", why: "理由B", url: "https://e.com/b" },
          { title: "市场波动加剧", why: "理由C", url: "https://e.com/c" },
        ],
        risk: { topic: "市场波动风险", evidence: "依据", impact: "影响", source: "T2" },
        attention: ATTENTION,
      }),
    ),
  );
  const attn = d.slice(d.indexOf('id="dv-attention"'), d.indexOf('id="dv-priorities"'));
  assert.equal((d.match(/class="dv-attn-top"/g) ?? []).length, 1, "第一层只展示 1 条管理层关注");

  // 旧行为是把必读前两条换个样式再放一遍：卡片数与必读条数相当、主题逐字等于必读标题。
  // 新口径：管理关注是独立议题 —— 主题不得照抄必读标题，条数也不跟着必读走。
  // （rationale 里引用必读事实是允许且要求的：那是「关注依据」，必须能回溯。）
  const attnTopics = [...attn.matchAll(/<h3>[\s\S]{0,80}?<\/h3>/g)].map((m) =>
    m[0].replace(/<[^>]+>/g, "").trim(),
  );
  for (const t of ["多家银行调整财富产品策略", "黄金配置需求上升", "市场波动加剧"]) {
    assert.ok(
      !attnTopics.some((x) => x.includes(t)),
      `管理关注主题不得照抄必读标题：${t}`,
    );
  }
  assert.ok(attnTopics.length < 3, "不是「必读前两条换样式」：条数不跟着必读走");

  assert.ok(attn.includes("关注依据") && attn.includes("管理意义"), "每条必须有依据与管理意义");
  assert.ok(attn.includes("https://e.com/mr-1"), "来源可点回原文");
  assert.ok(attn.includes("建议跨条线研究"), "两个不同经营领域 → 标注跨条线");
  assert.ok(attn.includes("非已作决定"), "建议性质，非已作决定");
  assert.ok(!/必须立即|要求各部门|责成/.test(attn), "不出现命令式语言");

  // 单领域不标跨条线（旧口径 tags.length>1 已废弃）
  const single = decisionPart(
    renderHtml(
      report({
        attention: [{ ...ATTENTION[0], domains: ["wealth_aum"], source_urls: ["https://e.com/x"] }],
      }),
    ),
  );
  const one = single.slice(single.indexOf('id="dv-attention"'), single.indexOf('id="dv-priorities"'));
  assert.ok(one.includes("dv-attn-top"), "单领域条目照常展示");
  assert.ok(!one.includes("建议跨条线研究"), "只有一个经营领域 → 不标跨条线");
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
  // 本 fixture 无 report.focus / 无 report.attention → 「本期重点」「管理关注」都不渲染，
  // 快捷跳转同步去掉这两个锚点（不得留下点不到的死链）。
  const expected = DV_MODULE_NAV.filter((m) => withHero.includes(`id="${m.id}"`)).map((m) => m.id);
  assert.deepEqual(targets, expected, "有定调时跳转目标与模块一一对应");
  for (const id of targets) assert.ok(withHero.includes(`id="${id}"`), `跳转目标不存在：${id}`);
  const noHero = decisionPart(renderHtml(report()));
  const nav2 = (noHero.match(/<nav class="dv-quicknav"[\s\S]*?<\/nav>/) ?? [""])[0];
  assert.ok(!nav2.includes("dv-hero"), "不再有旧「今日定调」死锚点");
  for (const id of [...nav2.matchAll(/href="#(dv-[a-z]+)"/g)].map((m) => m[1])) {
    assert.ok(noHero.includes(`id="${id}"`), `空定调下仍有死锚点：${id}`);
  }
  assert.match(renderHtml(report()), /\.dv-quicknav\s*\{[^}]*flex-wrap:\s*nowrap/, "导航单行不换行");
  assert.match(renderHtml(report()), /\.dv-quicknav\s*\{[^}]*overflow-x:\s*auto/, "导航可横滑");
  assert.match(renderHtml(report()), /\.dv-quicknav::-webkit-scrollbar\s*\{\s*display:none/, "隐藏滚动条");
});

test("⑬ 返回顶部：板块底部链接 + 悬浮按钮 + 锚点 + 平滑滚动", () => {
  const html = renderHtml(report());
  const d = decisionPart(html);
  // 核心判断/重点变化/经营重点不挂返回链接；第三层有内容的模块各自挂一个。
  assert.ok((d.match(/class="dv-back" href="#dv-top"/g) ?? []).length >= 2, "商机/风险/专业入口至少各有一个返回链接");
  for (const m of d.matchAll(/class="dv-back" href="#dv-top"/g)) assert.ok(m);
  const withAttn = decisionPart(renderHtml(report({ hero_line: "定调", attention: ATTENTION })));
  assert.ok((withAttn.match(/class="dv-back" href="#dv-top"/g) ?? []).length > (d.match(/class="dv-back"/g) ?? []).length, "含管理关注时返回链接增加");
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

test("⑮ 本期经营重点（二期）：只列年度重点且有实质命中，无命中整块不输出", () => {
  const hits = [
    { id: "a26_aum", name: "AUM 规模与结构优化", layer: "annual" as const, grade: "S", level: "M3" as const, bonus: 15, reason: "标题命中 AUM" },
  ];
  const annual = { id: "a26_aum", name: "AUM 规模与结构优化", layer: "annual" as const, grade: "S", count: 5, high: 3, domains: ["wealth_aum"] };
  const quarterly = { id: "q4_high_end_aum", name: "中高端客户 AUM 提升", layer: "quarterly" as const, grade: "S", count: 3, high: 2, domains: ["wealth_aum"] };
  const base = {
    hero_line: "定调",
    sections: { gz_local: [item("AUM 规模突破千亿", { focus_hits: hits })], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  };

  const d = decisionPart(
    renderHtml(report({ ...base, focus: { version: "f-21bd17f2", items: [quarterly, annual] } })),
  );
  assert.ok(d.includes('id="dv-focus"'), "年度重点有实质命中 → 模块存在");
  assert.ok(d.includes("配置版本 f-21bd17f2"), "显示配置版本（可追溯当时用的是哪版重点）");
  assert.ok(d.includes("年度重点") && d.includes("AUM 规模与结构优化"), "列年度重点");
  assert.ok(!d.includes("本季主攻") && !d.includes("中高端客户 AUM 提升"), "季度重点只参与加权，不进模块");
  assert.ok(d.includes("当日 5 条 · 实质 3"), "命中计数（相关条数 + 实质命中数）");
  assert.ok(d.includes('data-expand-focus="a26_aum"') && d.includes('id="dv-focus-detail-a26_aum"'));
  assert.ok(d.includes("精准命中"), "展开条目标注匹配等级");
  assert.ok(/href="#dv-focus"/.test(d), "快捷跳转含本期重点");

  // 只有季度命中、年度全为 0 → 整块不输出，快捷跳转同步去掉（不留死锚点）
  const onlyQ = decisionPart(
    renderHtml(report({ ...base, focus: { version: "f-x", items: [quarterly, { ...annual, high: 0 }] } })),
  );
  assert.ok(!onlyQ.includes('id="dv-focus"') && !onlyQ.includes("本期经营重点"), "无年度实质命中 → 模块不出现");
  assert.ok(!/href="#dv-focus"/.test(onlyQ), "模块不存在时快捷跳转同步去掉");

  // 年度有弱相关（count>0）但无实质命中 → 同样不输出，也不显示「当日 N 条」占位
  const weak = decisionPart(
    renderHtml(report({ ...base, focus: { version: "f-x", items: [{ ...annual, count: 4, high: 0 }] } })),
  );
  assert.ok(!weak.includes('id="dv-focus"') && !weak.includes("当日 4 条"), "弱相关不占位");

  // 空 focus（未配置）→ 整块不输出、不留占位
  const none = decisionPart(renderHtml(report()));
  assert.ok(!none.includes('id="dv-focus"') && !none.includes("本期经营重点"));
});

test("⑯ 卡片经营重点标签：只打年度重点，必读/商机/风险共用，与重要性标签并列不合并", () => {
  const hits = [
    { id: "a26_aum", name: "AUM 规模与结构优化", layer: "annual" as const, grade: "S", level: "M3" as const, bonus: 15, reason: "标题命中 AUM" },
  ];
  const url = "https://e.com/aum";
  const d = decisionPart(
    renderHtml(
      report({
        hero_line: "定调",
        must_read: [{ title: "AUM 开门红", why: "关注理财经理产能", url }],
        insights: [{ topic: "AUM 争夺", tags: [], impact: "代销中收改善", sources: [{ title: "源", url: "https://e.com/aum-ins" }] }],
        risk: { topic: "AUM 集中度", evidence: "依据", impact: "影响", source: "T2", sources: [{ title: "源", url: "https://e.com/aum-risk" }] },
        sections: {
          gz_local: [
            item("AUM 规模突破千亿", { url, focus_hits: hits }),
            item("AUM 争夺加剧", { url: "https://e.com/aum-ins", focus_hits: hits }),
            item("AUM 集中度上升", { url: "https://e.com/aum-risk", focus_hits: hits }),
          ],
          biz_insight: [],
          policy_market: [],
          tech: [],
          ipo: [],
        },
      }),
    ),
  );
  const tags = d.match(/class="dv-ftag"/g) ?? [];
  assert.equal(tags.length, 3, "经营重点 / 商机 / 风险三张卡都带同一重点标签");
  assert.ok(d.includes("年度重点：AUM 规模与结构优化"), "标签文案含层级与重点名");
  assert.ok(d.includes("S 重大变化"), "事件重要性（S/A/B）独立保留，不被重点标签替代");
  assert.ok(d.includes('title="标题命中 AUM"'), "标签带命中理由（悬停可核对）");

  // 季度命中不进卡片（展示口径只认年度三条）
  const qHits = [
    { id: "q4_high_end_aum", name: "中高端客户 AUM 提升", layer: "quarterly" as const, grade: "S", level: "M3" as const, bonus: 20, reason: "标题命中 AUM" },
  ];
  const qd = decisionPart(
    renderHtml(
      report({
        sections: { gz_local: [item("AUM 规模突破千亿", { focus_hits: qHits })], biz_insight: [], policy_market: [], tech: [], ipo: [] },
      }),
    ),
  );
  assert.ok(!qd.includes('class="dv-ftag"') && !qd.includes("本季主攻"), "季度命中不贴卡片标签");
});

test("⑰ 专业内容入口：只放独立页面，不得混入页内锚点（底部点击被弹回顶部）", () => {
  const d = decisionPart(renderHtml(report()));
  const seg = d.slice(d.indexOf('id="dv-legacy"'));
  const hrefs = [...seg.matchAll(/class="dv-legacy-item" href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    hrefs,
    [
      "../topics.html",
      "../focus.html",
      "../domains.html",
      "../research.html",
      "../redchip/index.html",
      "../search.html",
      "../archive.html",
    ],
    "七个入口与站点独立页一一对应（相对期次页 ../ 为站点根）",
  );
  assert.ok(!hrefs.some((h) => h.startsWith("#")), "不得混入 # 页内锚点：底部点击会滚回页面上方，像链接没链对");
  assert.ok(d.includes("独立页面与完整视图 · 点击进入对应板块"), "板块副文案说明独立页与完整视图入口");
  assert.ok(d.includes("data-open-classic") && d.includes("完整资讯视图"), "第三层提供一键切旧版的五大分类/角色视图入口");
});


test("⑱ 经营重点追踪入口：底部入口与模块内链都指向跨期页，首页副本改写为 ./focus.html", () => {
  const hits = [
    { id: "a26_aum", name: "AUM 规模与结构优化", layer: "annual" as const, grade: "S", level: "M3" as const, bonus: 15, reason: "标题命中 AUM" },
  ];
  const d = decisionPart(
    renderHtml(
      report({
        hero_line: "定调",
        focus: {
          version: "f-21bd17f2",
          items: [{ id: "a26_aum", name: "AUM 规模与结构优化", layer: "annual", grade: "S", count: 2, high: 1, domains: [] }],
        },
        sections: { gz_local: [item("AUM 规模突破千亿", { focus_hits: hits })], biz_insight: [], policy_market: [], tech: [], ipo: [] },
      }),
    ),
  );
  // 报告页在 <date>/ 子目录里 → 跨期页必须是 ../focus.html（构建时首页副本再改写为 ./）
  assert.ok(d.includes('href="../focus.html"'), "模块头/底部入口用站点根相对路径");
  assert.ok(d.includes("查看跨期追踪"), "重点模块内给跨期入口（当日命中 → 跨期观察的自然路径）");
});

test("⑲ IPO 线索：判不出领域时兜底进客户经营，商机洞察内嵌速览，季度例行报送不入列", () => {
  // tags 置空：模拟「短标题+纯阶段词」的真实形态（夹具默认带「财富」，会先把领域判走）
  const milestone = item("深鹏科技：IPO问询中（拟北交所）", { url: "https://e.com/ipo-milestone", tags: ["粤"] });
  const routine = item("盛凌电子辅导工作进展情况报告（第五期）", {
    url: "https://e.com/ipo-routine",
    tags: [],
    ipoStage: "stage-tutoring",
    summary: "报告: 辅导工作进展情况报告（第五期）",
  });
  const d = decisionPart(
    renderHtml(
      report({
        sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [milestone, routine] },
      }),
    ),
  );

  // ① 领域兜底（sc 2026-11-28：「IPO 至少兜底可以算经营线索」）：
  //    词表判不出领域的 IPO 条目不得被领域模块静默丢弃。
  const panel = d.slice(d.indexOf('id="dv-domain-panel-customer_growth"'));
  assert.ok(panel.length > 0, "客户经营面板必须存在");
  assert.ok(panel.slice(0, 4000).includes("深鹏科技"), "无领域 IPO 条目兜底进「客户经营与客群增长」");

  // ② 商机洞察内嵌「广东IPO 线索」：只列里程碑，例行报送排除（三处外发同源口径）。
  const opp = d.slice(d.indexOf('id="dv-opportunity"'), d.indexOf('id="dv-risk"'));
  assert.ok(opp.includes("广东IPO 线索 1 条"), "只数里程碑，季度例行报送不计入");
  assert.ok(opp.includes("深鹏科技"), "列出企业简称");
  assert.ok(!opp.includes("盛凌电子"), "季度例行报送不入线索行");
  assert.ok(opp.includes("仅里程碑"), "明确口径，避免被当成新增备案");

  // ③ 不进「商机 N 条」计数：IPO 线索是独立速览，不掺商机口径。
  assert.ok(!d.includes("商机 1 条"), "商机计数仍只认 insights");
});

test("⑳ 今日经营重点 3—5 条：有几条展示几条，首屏三件变化最多 3 条", () => {
  const mk = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      title: `必读事件 ${i + 1}`,
      why: "值得关注的理由。",
      url: `https://e.com/mr-${i + 1}`,
    }));
  const counts = (n: number): { priorities: number; changes: number } => {
    const d = decisionPart(renderHtml(report({ must_read: mk(n) })));
    const seg = d.slice(d.indexOf('id="dv-priorities"'), d.indexOf('id="dv-stock"'));
    const key = d.slice(d.indexOf('id="dv-key"'), d.indexOf('id="dv-attention"'));
    return {
      priorities: (seg.match(/class="dv-priority"/g) ?? []).length,
      changes: (key.match(/class="dv-change"/g) ?? []).length,
    };
  };

  assert.deepEqual(counts(2), { priorities: 2, changes: 2 }, "只有 2 条就展示 2 条");
  assert.deepEqual(counts(3), { priorities: 3, changes: 3 });
  assert.deepEqual(counts(4), { priorities: 4, changes: 3 }, "重点 4 条，首屏变化仍最多 3 条");
  assert.deepEqual(counts(5), { priorities: 5, changes: 3 });
  assert.deepEqual(counts(6), { priorities: 5, changes: 3 }, "超过 5 条才截断");
});

test("㉑ 手机横滑卡片：外框与内容都固定，标题3行/正文4行截断（招行风白卡）", () => {
  const html = renderHtml(report());
  assert.match(html, /#dv-mustread \.dv-scroller > \.dv-card \{ width:min\(82vw,332px\); height:235px/, "必读 235px + 右侧露边");
  assert.match(html, /#dv-opportunity \.dv-scroller > \.dv-card \{ width:min\(80vw,320px\); height:200px/, "商机 200px");
  assert.match(html, /#dv-risk \.dv-scroller > \.dv-card \{ width:min\(88vw,360px\); height:270px/, "风险 270px");
  assert.match(html, /#dv-attention \.dv-scroller > \.dv-card \{ width:min\(88vw,360px\); height:245px/, "管理关注 245px");
  assert.match(html, /\.dv-scroller\s*>\s*\.dv-card\s*\{[^}]*overflow:hidden/, "卡片内外都不滚动");
  assert.doesNotMatch(html, /isDirectionalLockEnabled/, "无内层滚动 → 不再需要方向锁脚本");
  assert.match(html, /\.dv-card-title[^}]*-webkit-line-clamp:3/, "标题限 3 行");
  assert.match(html, /\.dv-fact, \.dv-infer, \.dv-why[^}]*-webkit-line-clamp:4/, "正文限 4 行");
  assert.match(html, /\.dv-scroller > \.dv-card > \* \{ flex:0 0 auto; position:relative; z-index:1; \}/, "子块不得 shrink，否则标题会被压扁重叠");
  assert.match(html, /\.dv-scroller > \.dv-card > \.dv-card-hit \{ position:absolute; top:0; right:0; bottom:0; left:0;/, "整卡原生链接热区存在且不依赖 inset");
  assert.match(html, /#dv-mustread \.dv-card \.dv-chips \{ flex-wrap:nowrap; overflow:hidden; \}/, "必读标签压单行");
  assert.match(html, /#dv-mustread \.dv-card \.dv-chip \{ flex:0 0 auto; white-space:nowrap; \}/, "chip 不得被压扁换行");
  assert.match(html, /#dv-mustread \.dv-card \.dv-chip-evidence,/, "证据 chip 让位");
  assert.match(html, /#dv-mustread \.dv-card \.dv-chip-date \{ display:none; \}/, "日期 chip 隐藏，避免被裁半截");
  assert.match(html, /#dv-mustread \.dv-card \.dv-fact,[^}]*\-webkit-line-clamp:2/, "必读事实限 2 行");
  assert.match(html, /#dv-mustread \.dv-card \.dv-why \{ -webkit-line-clamp:2; \}/, "必读理由限 2 行");
  assert.match(html, /\.dv-card\s*\{[^}]*box-shadow:var\(--shadow-sm\)/, "沿用老版 .brief 的招行风阴影");
  assert.match(html, /scroll-snap-type:x proximity/, "吸附用 proximity");
});

test("㉒ 整卡可点：四类卡片都带 data-href，风险卡用 r.url 兜底", () => {
  const html = renderHtml(
      report({
        must_read: [{ title: "必读标题", why: "关注理由", url: "https://e.com/m" }],
        // 正文里存在同 URL：旧实现会返回 #itm-xxx，但锚点只在隐藏的旧版 DOM 里 → 死链。
        sections: {
          gz_local: [item("必读标题", { url: "https://e.com/m" })],
          biz_insight: [],
          policy_market: [],
          tech: [],
          ipo: [],
        },
        insights: [
          { topic: "商机标题", impact: "经营影响", tags: [], sources: [{ title: "源", url: "https://e.com/i" }] } as never,
        ],
        risk: { topic: "风险标题", evidence: "事实依据", impact: "潜在影响", url: "https://e.com/r" } as never,
        attention: [
          {
            id: "att-1",
            topic: "管理议题",
            rationale: "候选 c2 给出依据",
            significance: "意义",
            domains: ["wealth_aum"],
            source_urls: ["https://e.com/a"],
            confidence: "high",
          },
        ],
      }),
  );
  const d = decisionPart(html);
  assert.ok(!d.includes('href="#itm-'), "正文存在也不得回 #itm- 死链（锚点在隐藏的旧版 DOM）");
  assert.match(d, /href="https:\/\/e\.com\/m" target="_blank"/, "经营重点来源外链新开标签页");
  assert.match(d, /class="dv-card dv-opp" data-href="https:\/\/e\.com\/i"/);
  assert.match(d, /class="dv-card dv-risk" data-href="https:\/\/e\.com\/r"/, "风险只有 r.url 时也必须可点");
  assert.match(d, /href="https:\/\/e\.com\/a" target="_blank"/, "管理关注来源可点");
  assert.ok(!d.includes("候选 c2") && d.includes("相关条目 给出依据"), "内部候选 ID 不得露给读者");
  assert.match(html, /dv-scroller > \.dv-card\[data-href\]/, "整卡点击脚本存在");
});

test("㉓ 旧版资讯视角不得露出「经营重点」入口（新版独占功能）", () => {
  const html = renderHtml(report());
  const classic = html.slice(html.indexOf('id="view-classic"'));
  assert.ok(!classic.includes('href="../focus.html"'), "旧版模块入口不得链到 focus.html");
  assert.ok(!classic.includes('module-link-title">经营重点'), "旧版不得出现经营重点入口卡");
});

test("㉙ 第一层变化可跳第二层：#N 锚点、scroll-margin、1.2s 高亮", () => {
  const must = Array.from({ length: 3 }, (_, i) => ({
    title: `事件 ${i + 1}`,
    why: `理由 ${i + 1}`,
    url: `https://e.com/${i + 1}`,
  }));
  const d = decisionPart(renderHtml(report({ must_read: must })));
  for (let i = 1; i <= 3; i++) {
    assert.ok(d.includes(`class="dv-change" href="#dv-priority-${i}"`), `第 ${i} 条变化跳到对应重点`);
    assert.ok(d.includes(`id="dv-priority-${i}"`), `目标卡 ${i} 存在`);
  }
  assert.match(renderHtml(report({ must_read: must })), /\.dv-priority[^{]*\{[^}]*scroll-margin-top:14px/, "锚点避开顶部遮挡");
  assert.match(renderHtml(report({ must_read: must })), /is-flash|dv-priority-flash/, "1.2s 高亮反馈");
});

test("㉚ 第三层去重：已进第二层的事件改紧凑引用条，不整卡重复", () => {
  const body = item("房贷利率下调", { url: "https://e.com/dup" });
  const d = decisionPart(
    renderHtml(
      report({
        must_read: [{ title: "房贷利率下调", why: "影响住房金融条线", url: body.url }],
        insights: [{ topic: "房贷利率下调", tags: [], impact: "按揭咨询变化", sources: [{ title: "源", url: body.url }] }],
        risk: { topic: "房贷利率下调", evidence: "同题风险", impact: "同题影响", source: "T2", sources: [{ title: "源", url: body.url }] },
        sections: { gz_local: [body], biz_insight: [], policy_market: [], tech: [], ipo: [] },
      }),
    ),
  );
  assert.ok(d.includes("已纳入今日经营重点 #1，点击查看 ↑"), "商机/风险给出关联引用条");
  assert.equal((d.match(/class="dv-card dv-opp"/g) ?? []).length, 0, "商机不重复整卡");
  assert.equal((d.match(/class="dv-card dv-risk"/g) ?? []).length, 0, "风险不重复整卡");
});

test("㉛ 重大风险硬兜底：置顶第二层 + 红色警示徽标 + 风险模块转引用", () => {
  const risk = {
    topic: "监管处罚风险",
    evidence: "监管部门作出行政处罚。",
    impact: "财富条线合规审视加强。",
    source: "T1" as const,
    delta: { state: "new" as const },
  };
  const d = decisionPart(
    renderHtml(
      report({
        promotedRisk: {
          title: risk.topic,
          short: risk.topic,
          what: risk.evidence,
          impact: risk.impact,
          watch: "关注后续监管口径。",
          riskLevel: "critical",
        },
        risk,
      }),
    ),
  );
  const first = d.slice(d.indexOf('id="dv-priority-1"'), d.indexOf('id="dv-priority-2"'));
  assert.ok(first.includes("监管处罚风险"), "风险强制置顶第二层");
  assert.ok(first.includes("⚠ 极高风险"), "元信息栏红色风险徽标");
  assert.ok(d.includes("已纳入今日经营重点 #1，点击查看 ↑"), "风险模块不再重复整卡");
});

test("㉔ 第三层股市紧凑纵向：无横向长卡，三市场卡片纵向排布", () => {
  const d = decisionPart(renderHtml(report({ stock_recap: STOCK })));
  const stock = d.slice(d.indexOf('id="dv-stock"'), d.indexOf('id="dv-opportunity"'));
  assert.ok(stock.includes("dv-stock-grid"), "股市用纵向网格");
  assert.equal((stock.match(/class="dv-stock-card/g) ?? []).length, 3, "A股/港股/美股三张卡");
  assert.ok(!stock.includes("stock-scroller"), "不得复用旧版横向长卡");
  assert.ok(stock.includes("上证指数") && stock.includes("恒生指数") && stock.includes("纳斯达克"), "三地核心指数齐全");
});

test("㉗ LLM brief 回填：核心判断 + 三件变化 + 经营重点三段式", () => {
  const bodies = [
    item("房贷利率下调", { url: "https://e.com/1", summary: "首套房贷利率下调。" }),
    item("跨境结算便利化", { url: "https://e.com/2", summary: "跨境试点扩容。" }),
    item("黄金配置区间", { url: "https://e.com/3", summary: "黄金配置 5%~28%。" }),
  ];
  const d = decisionPart(
    renderHtml(
      report({
        must_read: bodies.map((b) => ({ title: b.title_cn, why: "影响经营", url: b.url })),
        sections: { gz_local: bodies, biz_insight: [], policy_market: [], tech: [], ipo: [] },
        brief: {
          core_judgment: "今日主要看住房金融与跨境结算两条线，房贷利率下调带动按揭咨询升温，跨境试点扩容改变客群结算路径。",
          priorities: bodies.map((b, i) => ({
            title: b.title_cn,
            url: b.url,
            short: `变化 ${i + 1}`,
            what: `发生了什么 ${i + 1}：事件主体与关键数字清楚。`,
            impact: `对经营意味着什么 ${i + 1}：住房金融与客群结构会变化。`,
            watch: `接下来关注什么 ${i + 1}：政策落地节奏。`,
          })),
        },
      }),
    ),
  );
  assert.ok(d.includes("今日主要看住房金融与跨境结算两条线"), "核心判断读 brief");
  assert.equal((d.match(/class="dv-change"/g) ?? []).length, 3, "首屏三件变化");
  assert.equal((d.match(/class="dv-priority"/g) ?? []).length, 3, "经营重点三条");
  for (const label of ["发生了什么", "对经营意味着什么", "接下来关注什么"]) {
    assert.ok(d.includes(`<b>${label}</b>`), `缺三段式：${label}`);
  }
  assert.ok(!d.slice(d.indexOf('id="dv-core"'), d.indexOf('id="dv-key"')).includes("dv-scroller"), "核心判断不横滑");
});

test("㉘ brief 选 3 条时不补回未选必读；音频仍只在旧版", () => {
  const must = Array.from({ length: 5 }, (_, i) => ({
    title: `事件 ${i + 1}`,
    why: `理由 ${i + 1}`,
    url: `https://e.com/${i + 1}`,
  }));
  const brief = {
    core_judgment: "今日主要看三条主线，事件一到事件三分别对应定价、跨境与财富配置。",
    priorities: must.slice(0, 3).map((m, i) => ({
      title: m.title,
      url: m.url,
      short: `变化 ${i + 1}`,
      what: `发生了什么 ${i + 1}：关键事实与数字。`,
      impact: `对经营意味着什么 ${i + 1}：客群与产品会变化。`,
      watch: `接下来关注什么 ${i + 1}：政策落地节奏。`,
    })),
  };
  const d = decisionPart(renderHtml(report({ must_read: must, brief })));
  const pri = d.slice(d.indexOf('id="dv-priorities"'), d.indexOf('id="dv-opportunity"'));
  assert.equal((pri.match(/class="dv-priority"/g) ?? []).length, 3, "LLM 只选 3 条，不用未选必读补到 5");

  const html = renderHtml(report(), {
    audio: { src: "audio/briefing.mp3", duration: "约 3 分钟" },
  });
  const decision = decisionPart(html);
  const classic = html.slice(html.indexOf('id="view-classic"'));
  assert.ok(!decision.includes('id="audio-player"'), "新版不接音频");
  assert.ok(classic.includes('id="audio-player"'), "音频仍保留在旧版");
});

test("㉕ 商机无 sources 时按标题找回当日条目：卡片外链 + 进入六大领域清单", () => {
  const body = item("六大行全部落地股票回购增持贷款", {
    url: "https://e.com/bank",
    primary_domain: "customer_growth",
  });
  const d = decisionPart(
    renderHtml(
      report({
        insights: [{ topic: "六大行落地股票回购增持贷款", tags: [], impact: "信贷客群竞争加剧。" }],
        sections: { gz_local: [], biz_insight: [body], policy_market: [], tech: [], ipo: [] },
      }),
    ),
  );
  const opp = d.slice(d.indexOf('id="dv-opportunity"'), d.indexOf('id="dv-risk"'));
  assert.match(opp, /class="dv-card dv-opp" data-href="https:\/\/e\.com\/bank"/, "无 sources 也要找到原文");
  assert.ok(opp.includes('href="https://e.com/bank"'), "来源标记可点原文");
  const domains = d.slice(d.indexOf('id="dv-domains"'));
  assert.ok(domains.includes("六大行全部落地股票回购增持贷款"), "新版重要商机必须进入领域清单");
});

test("㉖ IPO 线索与旧版同源：走 topGdIpo（广东 + 7 天窗口），非广东条目不混入", () => {
  const gd = item("深鹏科技：IPO问询中（拟北交所）", { url: "https://e.com/ipo-gd", tags: ["粤"] });
  const other = item("浙江某科技 IPO 受理", { url: "https://e.com/ipo-other", tags: [] });
  const d = decisionPart(
    renderHtml(report({ sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [gd, other] } })),
  );
  const opp = d.slice(d.indexOf('id="dv-opportunity"'), d.indexOf('id="dv-risk"'));
  assert.ok(opp.includes("深鹏科技"), "广东 IPO 线索保留");
  assert.ok(!opp.includes("浙江某科技"), "非广东条目不得进入新旧任一版的 IPO 集合");
});
