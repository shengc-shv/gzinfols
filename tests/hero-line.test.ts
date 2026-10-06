/**
 * 今日定调：文本口径、兜底派生与消费端标签（2026-09-28 sc 口径落地）。
 *
 * 口径（sc 2026-09-28）：「今日定调」是**维度提纲 + 看点** —— 回答「今天主要看哪几个方面」
 * （「今天主要看N个方面：X，看点；Y，看点。」，**≤70 字**），是必读/商机的「目录」。
 * **不写整句的为什么、不做事件摘要、不复述任何一条必读** —— 完整理由归必读，两者必须听得出分工。
 * 听众是**车里听的行领导**（看不见屏幕、不能回看），故每个维度可带 3~6 字看点给足分量。
 *
 * 本文件锁住四件事：
 *   ① `stripHeroPrefix`：历史遗留的「今日分行焦点：」前缀统一剥除（页面/企微/口播共用）；
 *   ② `deriveHeroLine`：由本次报告的必读+商机归纳**维度**（交错取用、上限 4 个、
 *      超长先砍维度、空素材回空串；**理由一字不入**）；
 *   ③ 集成：定调**不参与事件判重**（它是「必读+商机的提纲」、不是事件，2026-10-03 sc 口径
 *      「下面有出现，提纲就可以出现」）—— 只做**维度可回溯**校验：提纲里每个维度都要能在
 *      必读/商机里找到对应；悬空维度剔除、全可回溯则原样保留；全悬空则改由必读/商机重归纳，
 *      归纳不出才保留原定调（红线：宁可重复，不留空）；
 *   ④ 消费端：页面 / 企微 markdown / 企微 text 各自只加一份标签，不得出现双标签。
 *
 * 全部 fixture 时间戳显式带 +08:00（时间红线：不得出现无发布时间的条目）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { stripHeroPrefix } from "../lib/utils/hero-text";
import {
  HERO_DERIVE_MAX_LINES,
  auditHeroDimensions,
  auditHeroDisplayGrounding,
  deriveHeroLine,
  rebuildHeroLine,
  type ExecutiveSummary,
} from "../lib/services/enrich/executive-summary";
import { applyMemoryGuard } from "../lib/services/memory/exec-guard";
import {
  emptyMemory,
  rememberBroadcast,
  settleTodayIntoEvents,
} from "../lib/services/memory/event-memory";
import { renderHtml } from "../lib/services/render";
import { buildWecomMarkdown, buildWecomText } from "../lib/adapters/notify/wecom";
import type { DailyReport } from "../lib/contracts/report";

const TODAY = "2026-09-27";
const YEST = "2026-09-26";
const NOW = new Date("2026-09-27T07:30:00+08:00");

/** 与记忆库逐字重复的定调（回归用：判重已不再影响它）。 */
const HERO = "理财密集下调费率1667条，财富客群比价压力上升。";

function mkExec(): ExecutiveSummary {
  return {
    hero_line: HERO,
    must_read: [
      { title: "上海楼市已止跌回稳", why: "住房金融条线关注度上升", url: "https://example.com/a" },
    ],
    insights: [
      {
        topic: "助贷合作方适配排查",
        impact: "消费贷条线获客与分润结构或调整。",
        action: "风控部牵头排查存量合作方适配进度。",
        sources: [{ title: "助贷新规重塑合作模式", url: "https://example.com/b" }],
      },
    ],
  };
}

/** 昨天播过、与定调**同题**的事件（旧行为下定调会因此被判重拦下）。 */
function storeWithHeroHistory() {
  let store = emptyMemory();
  store = rememberBroadcast(store, {
    cand: { title: "上海楼市已止跌回稳", text: "" },
    section: "must_read",
    date: YEST,
    novelty: 1,
    broadcastAt: `${YEST}T08:00:00+08:00`,
  });
  return settleTodayIntoEvents(store, YEST);
}

// ---------------------------------------------------------------------------
// ① 前缀剥离（历史数据兼容）
// ---------------------------------------------------------------------------

test("stripHeroPrefix：剥掉历史补位前缀，无前缀原样返回，空值回空串", () => {
  assert.equal(
    stripHeroPrefix("今日分行焦点：河南省首笔取水权质押贷款落地信阳"),
    "河南省首笔取水权质押贷款落地信阳",
  );
  assert.equal(stripHeroPrefix("美联储10月加息概率逼近七成"), "美联储10月加息概率逼近七成");
  assert.equal(stripHeroPrefix(undefined), "");
  assert.equal(stripHeroPrefix("  今日分行焦点：  广州首单净土贷  "), "广州首单净土贷");
});

// ---------------------------------------------------------------------------
// ② deriveHeroLine：只列维度，不写理由
// ---------------------------------------------------------------------------

test("deriveHeroLine：按分行相关性分值降序取（高分在前）—— 定调是「最有价值的几条」", () => {
  const line = deriveHeroLine(mkExec());
  assert.equal(
    line,
    "今天主要看两个方面：助贷合作方适配排查、上海楼市已止跌回稳。",
    "助贷 74 分 > 楼市 66 分 → 高分在前（2026-10-03 sc：定调不是下面内容的目录，只放最有价值的几条）",
  );
});

test("deriveHeroLine：context / drop 档不进定调（10-03：低档内容被高分项挤掉）", () => {
  const line = deriveHeroLine({
    must_read: [{ title: "多地出台预售现房新规", why: "涉房开发贷与按揭项目的准入和资金监管要求可能随之变化。" }],
    insights: [{ topic: "本地马拉松赛事报名开启", impact: "全民健身活动，与零售业务无直接关联。" }],
  });
  assert.ok(line.includes("多地出台预售现房新规"), "高分项入选");
  assert.ok(!line.includes("马拉松"), "低档（context/drop）内容不进定调");
});

test("deriveHeroLine：理由（why）一字不入 —— 定调是纲，理由归必读", () => {
  const line = deriveHeroLine({
    must_read: [
      {
        title: "消费贷贴息扩围",
        why: "政策把贴息范围扩到更多消费场景，价格战随之升级，分行存量客户可能被同业以更低价抢走，需尽快统一口径。",
      },
    ],
  });
  assert.equal(line, "今天主要看一个方面：消费贷贴息扩围。");
  assert.ok(!line.includes("价格战"), "why 的内容不得进入提纲");
  assert.ok(!line.includes("需尽快统一口径"), "why 的内容不得进入提纲");
  assert.ok(line.length <= 90, `整句应 ≤90 字（实际 ${line.length}）`);
});

test("deriveHeroLine：最多 5 个维度、方向去重、空素材回空串", () => {
  const line = deriveHeroLine({
    must_read: [
      { title: "A方向", why: "理由A" },
      { title: "B方向", why: "理由B" },
      { title: "C方向", why: "理由C" },
      { title: "D方向", why: "理由D" },
      { title: "E方向", why: "理由E" },
      { title: "F方向", why: "理由F" },
    ],
    insights: [{ topic: "A方向", impact: "重复方向应被去掉" }],
  });
  assert.ok(line.startsWith("今天主要看五个方面："), `五条时应报「五个方面」（实际：${line}）`);
  assert.ok(line.includes("A方向") && line.includes("E方向"), "取前五条");
  assert.ok(!line.includes("F方向"), "第六条不进提纲");
  assert.equal((line.match(/A方向/g) ?? []).length, 1, "同一方向不重复");

  assert.equal(deriveHeroLine({ must_read: [], insights: [] }), "", "无素材 → 空串");
  assert.equal(deriveHeroLine({ must_read: [{ title: "  ", why: "x" }] }), "", "空白标题不算素材");
  assert.equal(HERO_DERIVE_MAX_LINES, 5, "上限常量须与口径一致");
});

test("deriveHeroLine：整句超 90 字 → 先砍维度再试（硬上限）", () => {
  const long = "很长的方向词组加起来要二十一个字才够长";
  const line = deriveHeroLine({
    must_read: [1, 2, 3, 4].map((i) => ({ title: `${long}${i}`, why: "x" })),
  });
  assert.ok(line.length <= 90, `整句不得超 90 字（实际 ${line.length} 字：${line}）`);
  assert.ok(line.startsWith("今天主要看"), "句式不变（只是减少维度数）");
  assert.ok(!line.includes("4"), "超长时最后一个维度被砍掉");
});

test("auditHeroDimensions：短词降级 —— 2 字维度不因 bigram 少而恒判悬空", () => {
  const a = auditHeroDimensions(
    "今天主要看两个方面：楼市，成交回暖；消费贷，贴息扩围。",
    [{ title: "楼市成交回暖" }],
    [{ topic: "消费贷贴息扩围" }],
  );
  assert.equal(a.dangling.length, 0, `两个短维度都应可回溯（实际悬空：${JSON.stringify(a.dangling)}）`);
  assert.equal(a.kept.length, 2, "看点随维度一起保留");
});

test("auditHeroDimensions：拆维度、摘主词与看点、悬空识别", () => {
  const a = auditHeroDimensions(
    "今天主要看两个方面：房贷贴息细则，口径落地；营销话术收紧，合规红线。",
    [{ title: "房贷贴息细则落地" }],
    [],
  );
  assert.deepEqual(
    a.dims.map((d) => d.key),
    ["房贷贴息细则", "营销话术收紧"],
    "按分号拆维度、主词取逗号前",
  );
  assert.equal(a.dims[0]!.note, "口径落地", "看点取逗号后");
  assert.deepEqual(a.dangling.map((d) => d.key), ["营销话术收紧"], "无对应 → 悬空");
  assert.deepEqual(a.kept, ["房贷贴息细则，口径落地"], "保留维度连同看点");
});

test("rebuildHeroLine：按保留维度重建、维度数改口、空数组回空串", () => {
  assert.equal(rebuildHeroLine(["A，看点"]), "今天主要看一个方面：A，看点。");
  assert.equal(rebuildHeroLine(["A，x", "B，y"]), "今天主要看两个方面：A，x；B，y。");
  assert.equal(rebuildHeroLine(["A，x", "B，y", "C，z"]), "今天主要看三个方面：A，x；B，y；C，z。");
  assert.equal(rebuildHeroLine([]), "", "无保留维度 → 空串（调用方据此保留原定调）");
});

// ---------------------------------------------------------------------------
// ③ 集成：维度可回溯校验（2026-10-03 sc 口径 —— 定调不再参与事件判重）
// ---------------------------------------------------------------------------

test("T4 防编造：合规的**跨条目综述**定调不再被误剔（10-04 sc 口径：定调是综合提炼）", () => {
  // 旧口径「维度逐条可回溯」会误剔合理综述：这三个维度都是对**多条**信息的提炼，
  // 不是任一条必读/商机的复述。实测旧守卫把它们判成悬空 → 只剩 1 个维度。
  // 这与 10-04 sc「定调偏综合性、不需一一匹配信息源」直接冲突。
  const exec: ExecutiveSummary = {
    hero_line:
      "今天主要看三个方面：合规成本上行，罚没密集；涉外窗口打开，美联储转向；存量压力集中在基金客户体验。",
    must_read: [
      { title: "9月银行业罚没2.07亿", why: "千万级罚单密集落地，信贷与代销是高频罚点。", url: "https://example.com/mr1" },
      { title: "美联储鹰派立场软化", why: "加息预期骤变，汇率与结售汇窗口打开。", url: "https://example.com/mr2" },
    ],
    insights: [
      {
        topic: "基金业绩腰斩客户体验转差",
        impact: "持有客户账面亏损扩大，投诉与赎回压力向理财经理端集中。",
        sources: [{ title: "t", url: "https://example.com/in1" }],
      },
    ],
  };
  const g = applyMemoryGuard({ exec, store: emptyMemory(), today: TODAY, now: NOW });
  assert.equal(
    g.exec.hero_line,
    exec.hero_line,
    "三个维度（罚没/美联储/基金）的主体锚都在当天信息源里 → 定调应原样保留，不得剔除",
  );
  assert.equal(g.exec.spoken_hero, exec.spoken_hero, "未改写 → 口播不动（保持同源）");
  assert.ok(
    g.log.some((l) => l.includes("防编造通过")),
    `应留防编造日志：${g.log.join(" | ")}`,
  );
});

test("T4 防编造：定调出现当天素材里不存在的业务主体锚 → 拦下并重归纳", () => {
  // 「跨境理财通」不在当日任何信息里 → 属编造，必须拦下。
  const exec: ExecutiveSummary = {
    hero_line: "今天主要看两个方面：合规成本上行，罚没密集；跨境理财通额度扩容。",
    must_read: [
      { title: "9月银行业罚没2.07亿", why: "千万级罚单密集落地。", url: "https://example.com/mr1" },
    ],
    insights: [],
  };
  const g = applyMemoryGuard({ exec, store: emptyMemory(), today: TODAY, now: NOW });
  assert.ok(
    g.log.some((l) => l.includes("不存在的主体锚") && l.includes("理财")),
    `应指出越界主体锚「理财」：${g.log.join(" | ")}`,
  );
  assert.equal(
    g.exec.hero_line,
    "今天主要看一个方面：9月银行业罚没2.07亿。",
    "含编造的定调不得原样发布 → 应改由必读/商机重归纳",
  );
  assert.equal(g.exec.spoken_hero, undefined, "定调改了 → 清空原口播，交由 syncNarration 派生");
});

test("维度全部可回溯 → 定调原样保留、口播不动（下面有出现，提纲就可以出现）", () => {
  const exec = mkExec();
  exec.hero_line = "今天主要看两个方面：上海楼市已止跌回稳，住房回暖；助贷合作方适配排查，分润调整。";
  exec.spoken_hero = "今天主要看两个方面，上海楼市和助贷排查。";
  const g = applyMemoryGuard({ exec, store: emptyMemory(), today: TODAY, now: NOW });
  assert.equal(g.exec.hero_line, exec.hero_line, "两个维度都能回溯 → 一字不改");
  assert.equal(g.exec.spoken_hero, exec.spoken_hero, "未改定调 → 口播保留（卡面与口播同源）");
});

test("定调下限：只给 1 个方面 → 标记二次 LLM 重写，但**不**用规则复读必读标题", () => {
  // 实证场景：当日有 5 条必读 + 5 条商机，LLM 却只输出
  // 「今天主要看一个方面：贵金属异动，资金搬家。」—— 整句 23 字、离 70 字上限还差 47 字。
  //
  // 🔴 关键：**不得**用 `deriveHeroLine` 补足 —— 它取的是 must_read.title/insights.topic **原文**，
  //    补出来的就是「把下面必读标题抄一遍」（实测与「今日必读」列表逐字相同），
  //    违反 §0 自己的禁令「不做事件摘要、不得换个说法复述某一条必读 —— 定调是纲、必读是目」。
  //    sc 判断：「如果是重复下面的内容，还不如原来的那一条总结」。
  const exec = mkExec();
  exec.hero_line = "今天主要看一个方面：上海楼市已止跌回稳，住房回暖。";
  exec.spoken_hero = "今天主要看一个方面，上海楼市。";
  const g = applyMemoryGuard({ exec, store: emptyMemory(), today: TODAY, now: NOW });
  assert.equal(g.exec.hero_line, exec.hero_line, "原定调必须原样保留（1 条精炼的纲 > 5 条复读的目）");
  assert.equal(g.exec.spoken_hero, exec.spoken_hero, "定调未改 → 口播保留（卡面与口播同源）");
  assert.equal(g.heroRewriteNeeded, true, "但要标记「需二次 LLM 重写」，由 LLM 把维度补齐");
  assert.ok(
    g.log.some((l) => l.includes("下限")),
    `日志应说明是下限触发：${g.log.join(" | ")}`,
  );
});

test("回归：定调不再参与事件判重（与历史同题也不换）", () => {
  // 旧行为：定调被当事件候选走 findMatchingEvent → 命中历史事件 → cooldown 拦下 → 兜底重写。
  // 新口径（10-03 sc）：提纲与必读/商机共享主题是**设计使然**，不该因此被换掉。
  const exec = mkExec();
  exec.hero_line = "今天主要看两个方面：上海楼市已止跌回稳，住房回暖；助贷合作方适配排查，分润调整。";
  const g = applyMemoryGuard({ exec, store: storeWithHeroHistory(), today: TODAY, now: NOW });
  assert.equal(
    g.exec.hero_line,
    exec.hero_line,
    "两个维度都可回溯 → 即使历史有同题事件，定调仍原样保留",
  );
});

test("T4 防编造的边界：定调无任何主体锚（「量子计算」等纯抽象词）→ 判为无越界，放行", () => {
  // ⚠️ 诚实的边界（10-04 实测）：`subjectAnchors` 靠 EVENT_ANCHORS 词表，**纯抽象词不产生锚点**。
  // 于是「量子计算突破」「元宇宙资产配置」这类完全编造的定调，**抓不到**。
  // 本用例把该边界**显式锁住**，避免后人误以为防编造是万能的：
  //   它能拦「借真实业务词编造」（如「跨境理财通额度扩容」而当天无理财通消息），
  //   但拦不住「凭空造一个词表里没有的概念」。
  // 补强手段（未实施）：把主体锚之外再校验**数字锚**，或引入专名识别 —— 二者都会带误伤，
  // 需单独评估（见 diagnostics 报告「四种修法」）。
  const exec = mkExec();
  exec.hero_line = "今天主要看两个方面：量子计算突破，前沿；元宇宙资产配置，新赛道。";
  const g = applyMemoryGuard({ exec, store: emptyMemory(), today: TODAY, now: NOW });
  assert.equal(
    g.exec.hero_line,
    exec.hero_line,
    "定调无主体锚 → 无从判定编造 → 放行（宁保留，不误杀）",
  );
  // 注：本 fixture 的维度数低于下限，`heroRewriteNeeded` 会因「维度不足」而置位 ——
  // 那与编造判定是**两条独立分支**，不由本用例守护。
});

test("红线：无素材可比 → 保留原定调（宁可重复，不留空、也不误杀真实内容）", () => {
  const exec: ExecutiveSummary = {
    hero_line: "今天主要看两个方面：量子计算突破，前沿；元宇宙资产配置，新赛道。",
    must_read: [],
    insights: [],
  };
  // 必读/商机与两天池都为空 → 无法判定编造 → **放行**（`auditHeroGrounding` 的空素材分支）
  const g = applyMemoryGuard({ exec, store: emptyMemory(), today: TODAY, now: NOW });
  assert.equal(g.exec.hero_line, exec.hero_line, "无素材可校验 → 保留原定调");
  assert.ok(
    g.log.some((l) => l.includes("防编造通过")),
    `应留防编造日志：${g.log.join(" | ")}`,
  );
});

// ---------------------------------------------------------------------------
// ④ 消费端：只加一份标签
// ---------------------------------------------------------------------------

test("页面渲染：hero_line 带历史前缀 → 只输出一个「今日定调：」标签", () => {
  const base = {
    date: TODAY,
    hero_line: "今日分行焦点：河南省首笔取水权质押贷款落地信阳",
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  } as unknown as DailyReport;
  const html = renderHtml(base);
  assert.ok(html.includes("今日定调：河南省首笔取水权质押贷款落地信阳"), "标签 + 正文各一份");
  assert.ok(!html.includes("今日分行焦点"), "不得出现补位前缀（历史数据重渲染亦不例外）");
  assert.ok(!html.includes('class="hero-line">今日定调：今日'), "不得出现双标签");
});

test("企微推送：同样剥前缀，只留【今日定调】标签", () => {
  const md = buildWecomMarkdown(
    "今日分行焦点：河南省首笔取水权质押贷款落地信阳",
    "9月27日 周日",
    "https://example.com",
  );
  assert.ok(
    md.includes("河南省首笔取水权质押贷款落地信阳") && md.includes("今日定调"),
    "markdown 版：正文在、标签在",
  );
  assert.ok(!md.includes("今日分行焦点"), "markdown 版不得出现补位前缀");

  const tx = buildWecomText(
    "今日分行焦点：河南省首笔取水权质押贷款落地信阳",
    "9月27日 周日",
    "https://example.com",
  );
  assert.ok(!tx.includes("今日分行焦点"), "text 版不得出现补位前缀");
});

// ---------------------------------------------------------------------------
// 2026-10-04 sc「R4 以 2 为主」：商机与必读互斥（代码层，方案 A）
// ---------------------------------------------------------------------------

/** 构造一份「必读 2 条 + 商机 4 条」的 exec：其中 2 条商机与必读同源。 */
function mkExclExec(): ExecutiveSummary {
  return {
    hero_line: "今天主要看两个方面：楼市分化，信贷收紧；跨境结算便利化提速。",
    must_read: [
      {
        title: "多地出台预售现房新规",
        why: "涉房开发贷与按揭项目的准入和资金监管要求可能随之变化。",
        url: "https://example.com/mr1",
      },
      {
        title: "贷款明白纸全面铺开",
        why: "年化成本需一目了然，对客披露口径与收费告知流程面临统一。",
        url: "https://example.com/mr2",
      },
    ],
    insights: [
      {
        // ① 与必读同 URL（LLM 改写过标题）
        topic: "现房销售改革落地",
        impact: "按揭与开发贷准入口径需同步核对。",
        sources: [{ title: "t", url: "https://example.com/mr1" }],
      },
      {
        // ② 与必读同 URL 且标题逐字相同
        topic: "贷款明白纸全面铺开",
        impact: "对客披露口径面临统一。",
        sources: [{ title: "t", url: "https://example.com/mr2" }],
      },
      {
        // ③ 应当保留：内容相近但**不同源**，不是同一条信息
        topic: "预售资金监管细则征求意见",
        impact: "房企现金流与按揭放款节奏需跟踪。",
        sources: [{ title: "t", url: "https://example.com/other1" }],
      },
      {
        // ④ 应当保留：完全独立
        topic: "跨境结算便利化提速",
        impact: "大湾区跨境客群资金周转效率提升。",
        sources: [{ title: "t", url: "https://example.com/other2" }],
      },
    ],
  } as ExecutiveSummary;
}

test("商机与必读互斥：同 URL / 标题逐字相同的商机被剔除（2026-10-04 sc R4-②）", () => {
  const g = applyMemoryGuard({
    exec: mkExclExec(),
    store: emptyMemory(),
    today: TODAY,
    now: NOW,
  });
  const topics = (g.exec.insights ?? []).map((i) => i.topic);
  assert.equal(topics.length, 2, `应剩 2 条（实际 ${topics.length}：${topics.join(" / ") || "空"}）`);
  assert.ok(!topics.includes("现房销售改革落地"), "同 URL 的商机必须剔除（哪怕标题被改写过）");
  assert.ok(!topics.includes("贷款明白纸全面铺开"), "标题逐字相同 + 同 URL 的商机必须剔除");
  assert.ok(topics.includes("预售资金监管细则征求意见"), "不同源、不同标题的商机必须保留（不得误伤）");
  assert.ok(topics.includes("跨境结算便利化提速"), "独立商机必须保留");
});

test("商机互斥判据不用事件指纹：泛化词+地域不得导致误剔（回归：sameEvent 层已移除）", () => {
  // 旧实现叠了 `sameEvent`（事件指纹共享 ≥2 锚点）。它有两个问题，实测均已确认：
  //  ① **抓不到**：商机 topic 是 LLM 改写后的短语，锚点被稀释 → 当天 3 条真重复一条没抓到；
  //  ② **误并**：`eventFingerprint` 地域锚照算 → 「泛化主体词 + 地域」就凑满 2 锚点。
  //     下面两条标题共享「广州」+「普惠」两个锚，若走 sameEvent 会被误判为同一事件。
  const exec = {
    hero_line: "今天主要看两个方面：市政项目获批，普惠开放；普惠金融改革试点扩围。",
    must_read: [
      {
        title: "将24小时面向全社会普惠开放，广州琶洲南CBD项目获批",
        why: "市政公共服务扩容。",
        url: "https://example.com/p1",
      },
    ],
    insights: [
      {
        // 共享「普惠」+「广州」两个锚，但**是完全不同的两件事**（市政 vs 金融政策）
        topic: "广州普惠金融改革试点扩围",
        impact: "普惠信贷投放口径变化。",
        sources: [{ title: "t", url: "https://example.com/p2" }],
      },
    ],
  } as unknown as ExecutiveSummary;
  const g = applyMemoryGuard({ exec, store: emptyMemory(), today: TODAY, now: NOW });
  assert.equal(
    (g.exec.insights ?? []).length,
    1,
    "不同 URL、不同标题的商机不得因共享「普惠/广州」锚点被误剔",
  );
});

test("T4 回归：综述式定调「一个维度都回溯不到」**不得**被判为维度不足（2026-04 实测踩坑）", () => {
  // 🔴 10-04 实测：合规综述「合规成本上行 / 涉外窗口打开 / 存量压力集中在基金客户体验」
  //    三个维度**都**不回溯到任一条必读/商机 —— 这正是 T4 要放行的「跨条目提炼」形态。
  //    若下限守卫仍用 `kept.length`（可回溯数）→ 0 < 2 → **误判为维度不足**，
  //    白白触发二次 LLM 重写（浪费一次调用，且可能被改写成复读）。
  //    正确口径：下限只看**实际维度数** `dims.length`。
  const exec: ExecutiveSummary = {
    hero_line:
      "今天主要看三个方面：合规成本上行，罚没密集；涉外窗口打开，美联储转向；存量压力集中在基金客户体验。",
    must_read: [
      { title: "9月银行业罚没2.07亿", why: "千万级罚单密集落地。", url: "https://example.com/mr1" },
      { title: "美联储鹰派立场软化", why: "加息预期骤变。", url: "https://example.com/mr2" },
    ],
    insights: [
      {
        topic: "基金业绩腰斩客户体验转差",
        impact: "客户账面亏损扩大。",
        sources: [{ title: "t", url: "https://example.com/in1" }],
      },
    ],
  };
  const g = applyMemoryGuard({ exec, store: emptyMemory(), today: TODAY, now: NOW });
  assert.equal(g.exec.hero_line, exec.hero_line, "3 个维度 → 不得因「回溯不到」被改写");
  assert.equal(
    g.heroRewriteNeeded,
    false,
    "综述式定调不应触发二次重写（否则浪费一次 LLM 调用，且可能被改成必读标题复读）",
  );
});

// ---------------------------------------------------------------------------
// 展示落点（2026-10-06 sc 口径）：定调的每个方面都要在**展示出来的资讯清单**里有出处
//
// sc 口径：「他的内容，虽然不一定出现在必读和商机里面，但还是得出现在展示出来的资讯清单
// 里面的。」—— 可以概括提炼，但不得引入页面完全没有的话题（听众听完提纲会往下找下文）。
// ---------------------------------------------------------------------------

/** 10-06 线上真实场景：定调 4 个方面，但「横琴口岸」那条从未进任何卡片。 */
const HERO_1006 =
  "今天主要看四个方面：湾区楼市，补贴扩容；跨境客群，口岸新高；消费场景，家电数码；海外市场，纳指新高。";
const DISPLAY_1006 = [
  "珠海出房产新政，港澳人士亦可同享补贴 湾区楼市跨境置业补贴范围首次覆盖港澳客群。",
  "补贴扩容、新品扎堆、一天卖出4台机器人……广州黄金周家电数码消费又新又热。",
  "全球市场：美股三大指数集体收涨，纳指涨超1%创收盘新高 海外风险偏好回升，客户对QDII及海外权益类产品的咨询热度可能走高。",
];

test("展示落点：10-06 线上实例 ——「跨境客群，口岸新高」在展示清单里找不到出处", () => {
  const a = auditHeroDisplayGrounding(HERO_1006, DISPLAY_1006);
  assert.equal(a.skipped, false);
  assert.deepEqual(
    a.ungrounded,
    ["跨境客群，口岸新高"],
    `只有这条无出处（其素材「横琴口岸」未进卡片）：${JSON.stringify(a.dims)}`,
  );
  assert.equal(a.dims.filter((d) => d.grounded).length, 3, "其余 3 个方面应有出处");
});

test("展示落点反向守护：把「横琴口岸」那条放进清单 → 该方面即有出处", () => {
  const withKouAn = [...DISPLAY_1006, "横琴口岸单日客流突破15万人次 创口岸启用以来新高。"];
  const a = auditHeroDisplayGrounding(HERO_1006, withKouAn);
  assert.deepEqual(a.ungrounded, [], "补齐出处后不应再判无落点");
});

test("展示落点：泛化词不得单独充当出处（「海外市场」不能靠「市场」蒙过）", () => {
  const genericOnly = [
    "A股市场震荡走高 成交额创阶段新高。",
    "房地产市场政策持续优化 新房成交回升。",
  ];
  const a = auditHeroDisplayGrounding("今天主要看一个方面：海外市场，纳指新高。", genericOnly);
  assert.equal(
    a.ungrounded.length,
    1,
    `泛化词不构成落点证据（实际 ${JSON.stringify(a.dims)}）`,
  );
});

test("展示落点：清单为空 → 放行（不误杀真实内容）", () => {
  const a = auditHeroDisplayGrounding(HERO_1006, []);
  assert.equal(a.skipped, true);
  assert.deepEqual(a.ungrounded, []);
});

test("展示落点：定调无维度 → 放行（与空清单同属无法判定）", () => {
  const a = auditHeroDisplayGrounding("", DISPLAY_1006);
  assert.equal(a.skipped, true);
});

test("展示落点：exec-guard 集成 —— 有方面无出处 → 标记二次重写，且**不**用规则替换定调", () => {
  const exec: ExecutiveSummary = {
    hero_line: HERO_1006,
    must_read: [{ title: "纳指涨超1%创收盘新高", why: "海外风险偏好回升。" }],
    insights: [{ topic: "广州家电数码补贴扩容", impact: "以旧换新场景热度上升。" }],
  };
  const g = applyMemoryGuard({
    exec,
    store: emptyMemory(),
    today: TODAY,
    now: NOW,
    displayTexts: DISPLAY_1006,
  });
  assert.equal(
    g.exec.hero_line,
    HERO_1006,
    "只标记重写：不得用规则把定调换成必读标题复读（10-04 sc 口径）",
  );
  assert.equal(g.heroRewriteNeeded, true, "应触发二次 LLM 重写");
  assert.ok(
    g.log.some((l) => l.includes("找不到出处")),
    `应有落点日志：${g.log.join(" | ")}`,
  );
});

test("展示落点：exec-guard 未传清单 → 不启用新判据（既有调用点行为不变）", () => {
  const exec: ExecutiveSummary = {
    hero_line: HERO_1006,
    must_read: [{ title: "纳指涨超1%创收盘新高", why: "海外风险偏好回升。" }],
    insights: [],
  };
  const g = applyMemoryGuard({ exec, store: emptyMemory(), today: TODAY, now: NOW });
  assert.ok(
    !g.log.some((l) => l.includes("找不到出处")),
    `未传清单时不应出现落点告警：${g.log.join(" | ")}`,
  );
});
