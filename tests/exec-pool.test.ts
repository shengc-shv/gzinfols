/**
 * buildTwoDayExecPool 单元测试（2026-08-23 2 天窗口需求）。
 * 验证：今/昨两天窗口内的 finance|gz 高信号条目被纳入，前天与无关/无摘要被排除，
 * 且时区（全项目固定 Asia/Shanghai，常量 REPORT_TZ）下日期键比对正确。
 *
 * 移植自 gzinfo tests/exec-pool.test.ts（仅改 import 路径）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTwoDayExecPool,
  dateKeyOf,
  pruneHomogeneousTopics,
  type ExecPoolHistoryEntry,
} from "../lib/services/enrich/exec-pool";
import { scoreBranchRelevance } from "../lib/services/select/filters/relevance-score";
import type { DailyReport } from "../lib/contracts/report";

const TODAY = "2026-08-23";
const YEST = "2026-08-22";
const BEFORE = "2026-08-21";

function mkReportItem(url: string, title_cn: string, summary: string) {
  return {
    url,
    title_cn,
    title_orig: "",
    source: "源",
    source_type: "media" as const,
    date: "08/23",
    summary,
    importance: 2 as const,
    rank: 1,
    tags: [],
    locale: "national" as const,
  };
}

function mkReport(): DailyReport {
  return {
    date: TODAY,
    hero_line: "",
    must_read: [],
    insights: [],
    sections: {
      gz_local: [mkReportItem("tg", "今日广州业务", "今日广州某业务动态摘要。")],
      biz_insight: [],
      policy_market: [mkReportItem("tf", "今日宏观政策", "今日某宏观政策摘要。")],
      tech: [],
      ipo: [],
    },
  };
}

function mkHistory(): Record<string, ExecPoolHistoryEntry> {
  return {
    // 昨日 finance，相关+有摘要 → 应纳入
    yf: { publishedAt: `${YEST}T20:00:00+08:00`, category: "finance", ai_relevant: true, summary: "昨日宏观政策摘要。", title: "昨日宏观", url: "yf" },
    // 昨日 gz，相关+有摘要 → 应纳入
    yg: { publishedAt: `${YEST}T19:00:00+08:00`, category: "gz", ai_relevant: true, summary: "昨日广州业务摘要。", title: "昨日广州", url: "yg" },
    // 前天 finance → 超窗口，排除
    of: { publishedAt: `${BEFORE}T10:00:00+08:00`, category: "finance", ai_relevant: true, summary: "前天宏观摘要。", title: "前天宏观", url: "of" },
    // 昨日但不相关 → 排除
    nr: { publishedAt: `${YEST}T18:00:00+08:00`, category: "finance", ai_relevant: false, summary: "无关摘要。", url: "nr" },
    // 昨日相关但无摘要 → 排除
    ns: { publishedAt: `${YEST}T17:00:00+08:00`, category: "gz", ai_relevant: true, summary: "", title: "无摘要", url: "ns" },
  };
}

const articles = [
  { url: "tf", publishedAt: `${TODAY}T09:00:00+08:00`, category: "finance" },
  { url: "tg", publishedAt: `${TODAY}T09:30:00+08:00`, category: "gz" },
];

test("2天窗口：纳入今+昨，排除前天/无关/无摘要", () => {
  process.env.REPORT_TZ = "Asia/Shanghai";
  const res = buildTwoDayExecPool({ history: mkHistory(), articles, report: mkReport(), today: TODAY, now: new Date() });
  const finUrls = res.finance.map((i) => i.url).sort();
  const gzUrls = res.gz.map((i) => i.url).sort();
  // finance：今日 tf + 昨日 yf，排除前天 of、无关 nr
  assert.deepEqual(finUrls, ["tf", "yf"]);
  // gz：今日 tg + 昨日 yg，排除无摘要 ns
  assert.deepEqual(gzUrls, ["tg", "yg"]);
});

test("2天窗口：前天条目整体排除", () => {
  process.env.REPORT_TZ = "Asia/Shanghai";
  const res = buildTwoDayExecPool({ history: mkHistory(), articles, report: mkReport(), today: TODAY, now: new Date() });
  const all = [...res.finance, ...res.gz].map((i) => i.url);
  assert.ok(!all.includes("of"), "前天条目不应纳入");
  assert.ok(!all.includes("nr"), "不相关条目不应纳入");
  assert.ok(!all.includes("ns"), "无摘要条目不应纳入");
});

test("时区：UTC 凌晨时间戳在 Asia/Shanghai 下日期键正确", () => {
  process.env.REPORT_TZ = "Asia/Shanghai";
  // 2026-08-22T16:00:00Z = 上海 2026-08-23 00:00 → 应归今天
  assert.equal(dateKeyOf("2026-08-22T16:00:00Z", "Asia/Shanghai"), "2026-08-23");
  // 2026-08-23T00:30:00Z = 上海 2026-08-23 08:30 → 今天
  assert.equal(dateKeyOf("2026-08-23T00:30:00Z", "Asia/Shanghai"), "2026-08-23");
  // 无效日期返回 undefined
  assert.equal(dateKeyOf("not-a-date", "Asia/Shanghai"), undefined);
});

/**
 * 广东 IPO 池（2026-08-31 新增；窗口于 2026-09-16 按用户口径修正为 **2 天**）。
 * 背景：exec 提示词有 guangdong_ipo 槽位且要求「无则 null、不要编造」，但 ipo 入参
 * 从未被传入 → LLM 恒回 null，口播只能靠 audio.ts 确定性兜底。本测试锁住该通路。
 *
 * 要点（用户 2026-09-16 原话：「所有要变成口播的，全部是 2 天窗，保持一致。
 * 只有最下面的信息清单，IPO 是 7 天。」）：
 *  - 该槽位的产出**会变成口播**（spoken）+ 被引用的条目会进商机洞察 → 必须与
 *    口播/横滑同窗（`IPO_VOICE_WINDOW_DAYS` = 2 天）；
 *  - `sections.ipo` 分支原实现**无任何时间过滤**（7 天窗形同虚设）→ 09/14 的
 *    「优邦科技注册生效」曾被写成「今日商机洞察」，而当天 2 天窗内根本没有这张卡
 *    （用户实证）→ 现按 `it.date` 走 2 天窗；
 *  - 底部「广东IPO动态」完整列表仍是 7 天，本池不承担该职责。
 */
test("IPO 池：2 天窗（与口播同窗），7 天内的过期条目必须排除", () => {
  process.env.REPORT_TZ = "Asia/Shanghai";
  const report = mkReport();
  report.sections.ipo = [
    // 今天（mkReportItem 默认 date = 08/23 = TODAY）→ 纳入
    mkReportItem("ipo-today", "粤芯半导体：注册生效（拟深交所）", "注册地：广东"),
    // 昨天 → 纳入
    { ...mkReportItem("ipo-yest", "尚睿科技：IPO问询中（拟北交所）", "注册地：广东"), date: "08/22" },
    // 4 天前：仍在「底部列表 7 天窗」内，但**不是口播素材** → 必须排除（新口径核心锁）
    { ...mkReportItem("ipo-4d", "腾信精密：IPO已受理（拟北交所）", "注册地：广东"), date: "08/19" },
    // 8 天前：连 7 天窗都超了
    { ...mkReportItem("ipo-8d", "某旧企业：IPO过会（拟创业板）", "注册地：广东"), date: "08/15" },
  ];
  const arts = [
    {
      url: "ipo-arts-today",
      publishedAt: `${TODAY}T09:10:00+08:00`, // 今天 → 纳入
      category: "gd-ipo",
      title: "珠江啤酒：IPO辅导备案（拟上交所）",
      excerpt: "注册地：广东",
    },
    {
      url: "ipo-arts-3d",
      publishedAt: "2026-08-20T10:00:00+08:00", // 3 天前 → 排除
      category: "gd-ipo",
      title: "东莞某精密：IPO已受理（拟北交所）",
      excerpt: "注册地：广东",
    },
    { url: "tf", publishedAt: `${TODAY}T09:00:00+08:00`, category: "finance" },
    { url: "tg", publishedAt: `${TODAY}T09:30:00+08:00`, category: "gz" },
  ];
  const res = buildTwoDayExecPool({
    history: mkHistory(),
    articles: arts,
    report,
    today: TODAY,
    now: new Date(),
  });
  assert.deepEqual(
    res.ipo.map((i) => i.url).sort(),
    ["ipo-arts-today", "ipo-today", "ipo-yest"],
    "2 天窗内纳入；4 天前 / 3 天前 / 8 天前一律排除",
  );

  // 关键：IPO 绝不能污染必读/商机池
  const finGz = [...res.finance, ...res.gz].map((i) => i.url ?? "");
  assert.ok(
    finGz.every((u) => !u.startsWith("ipo-")),
    "IPO 条目不得进入 finance/gz 池",
  );
  // 原有的 finance/gz 结果不受影响
  assert.deepEqual(res.finance.map((i) => i.url).sort(), ["tf", "yf"]);
  assert.deepEqual(res.gz.map((i) => i.url).sort(), ["tg", "yg"]);
});

test("IPO 池：缺发布时间的条目一律排除（时间红线）", () => {
  process.env.REPORT_TZ = "Asia/Shanghai";
  const report = mkReport();
  // date 非 MM/DD（无法判定窗口）→ 不得进池
  report.sections.ipo = [
    { ...mkReportItem("ipo-nodate", "某粤企：IPO获受理（拟北交所）", "注册地：广东"), date: "" },
  ];
  const res = buildTwoDayExecPool({
    history: mkHistory(),
    articles,
    report,
    today: TODAY,
    now: new Date(),
  });
  assert.deepEqual(res.ipo, [], "无有效日期 → 不进池，绝不用抓取时间兜底");
});

test("IPO 池：无 IPO 条目时返回空数组（不报错）", () => {
  process.env.REPORT_TZ = "Asia/Shanghai";
  const res = buildTwoDayExecPool({
    history: mkHistory(),
    articles,
    report: mkReport(),
    today: TODAY,
    now: new Date(),
  });
  assert.deepEqual(res.ipo, []);
});

test("无 publishedAt 的条目被跳过", () => {
  process.env.REPORT_TZ = "Asia/Shanghai";
  const hist: Record<string, ExecPoolHistoryEntry> = {
    noDate: { category: "finance", ai_relevant: true, summary: "有摘要但无日期", title: "无日期", url: "noDate" },
  };
  // 今日实际抓取的文章均带真实发布时间，与 report.sections 的 tf/tg 对应（生产实况：
  // ingest 已保证 articles 一律有 publishedAt，不会有无日期条目流入）。
  const todayArts = [
    { url: "tf", publishedAt: `${TODAY}T09:00:00+08:00`, category: "finance" },
    { url: "tg", publishedAt: `${TODAY}T09:30:00+08:00`, category: "gz" },
  ];
  const res = buildTwoDayExecPool({ history: hist, articles: todayArts, report: mkReport(), today: TODAY, now: new Date() });
  assert.equal(res.finance.length, 1, "今日 report.sections 的 tf 带发布时间，仍贡献");
  assert.ok(!res.finance.map((i) => i.url).includes("noDate"), "无发布时间的 noDate 必须被跳过");
});

// ---------------------------------------------------------------------------
// S5（2026-10-06 sc 授权）：评分禁止喂回 AI 摘要
// ---------------------------------------------------------------------------
/**
 * 自证循环：今日这一路的 `summary` 是 **AI 摘要**（PASS2 生成），喂回评分器会让我们
 * 自己的措辞反过来抬高相关性分。实测 10-05 exec 池：Δ 平均 +3.9，极值 +45
 * （「前9月广州海关…中欧班列」84 → 39、「韩国金融业接连遭网络攻击」74 → 29）。
 *
 * 本用例锁定：**池条目必须带上源站原文（`excerpt`），排序只认它**。
 * 构造上让 AI 摘要里塞满业务关键词（「房贷」「贴息」「广州」），源站原文则是中性的 ——
 * 若回归成「用 AI 摘要评分」，分数会被人为抬高，断言立刻失败。
 */
test("S5：池条目带 excerpt（源站原文），排序只认原文、不认 AI 摘要", () => {
  const rep = mkReport();
  rep.sections.policy_market = [
    mkReportItem(
      "u1",
      "广州海关监管中欧班列进出口货物",
      "广州房贷贴息新政落地，广州分行应重点关注信贷投放，房贷利率下调。",
    ),
  ];
  const pool = buildTwoDayExecPool({
    history: {
      u1: {
        publishedAt: `${YEST}T20:00:00+08:00`,
        category: "finance",
        ai_relevant: true,
        summary: "广州房贷贴息新政落地，广州分行应重点关注信贷投放，房贷利率下调。",
        title: "广州海关监管中欧班列进出口货物",
        url: "u1",
        excerpt: "前9月广州海关监管广州国际港中欧班列进出口货物2.73万标箱。",
      },
    },
    articles: [
      {
        url: "u1",
        title: "广州海关监管中欧班列进出口货物",
        publishedAt: `${TODAY}T08:00:00+08:00`,
        category: "finance",
        excerpt: "前9月广州海关监管广州国际港中欧班列进出口货物2.73万标箱。",
      },
    ],
    report: rep,
    today: TODAY,
    now: new Date(`${TODAY}T12:00:00+08:00`),
  });
  const hit = [...pool.finance, ...pool.gz].find((i) => i.url === "u1");
  assert.ok(hit, "u1 应入池");
  assert.ok(hit?.excerpt, "池条目必须把源站原文（excerpt）带出来，供评分使用");
  // 用源站原文评分 = 39（context）；若被 AI 摘要污染会是 84（must_read）
  const byRaw = scoreBranchRelevance({ title: hit!.title, summary: hit!.excerpt });
  const byAI = scoreBranchRelevance({ title: hit!.title, summary: hit!.summary });
  assert.ok(
    byAI.score > byRaw.score,
    `构造前提：AI 摘要会抬分（${byRaw.score} → ${byAI.score}），本用例才有意义`,
  );
});

// ---------------------------------------------------------------------------
// S6（2026-10-06 sc 授权）：池定稿前的同主题终选
// ---------------------------------------------------------------------------
const S6_TITLES = {
  goldEvent: "港交所：要推出人民币计价黄金期货",
  goldComment1: "黄金市场四季度有哪些交易机会？ | 期势新洞察",
  goldComment2: "黄金这次的走势为什么如此诡异？",
  goldComment3: "10月4日下周黄金行情分析，暴跌摸4000，后死猫反弹4100下震荡",
  etf: "占比超八成！个人投资者大举涌入新上市ETF",
 新股: "A股前三季度新股上市首日零破发，4只“大肉签",
  gzFestival1: "国庆假期，广州警方依托科技赋能守护平安",
  gzFestival2: "国庆假期，广州东至新塘五六线建设者奋战一线",
};

function prune(items: { title: string; summary?: string; url?: string; excerpt?: string }[]) {
  return pruneHomogeneousTopics(items);
}

test("S6：同主题簇只留信息量最大者（黄金 4 条 → 1 条，留事件稿）", () => {
  const kept = prune([
    { title: S6_TITLES.goldComment1, url: "c1", excerpt: "四季度黄金交易机会分析。" },
    { title: S6_TITLES.goldEvent, url: "e1", excerpt: "港交所将推出人民币计价黄金期货。" },
    { title: S6_TITLES.goldComment2, url: "c2", excerpt: "黄金走势分析。" },
    { title: S6_TITLES.goldComment3, url: "c3", excerpt: "下周黄金行情分析。" },
  ]);
  assert.equal(kept.length, 1, "4 条同质黄金内容应只留 1 条");
  assert.equal(kept[0].url, "e1", "应保留分值最高的事件稿（港交所推人民币计价黄金期货）");
});

test("S6 反向守护：共享锚但不够同质 → 不合并（ETF 与新股破发是两件事）", () => {
  const items = [
    { title: S6_TITLES.etf, url: "a", excerpt: "个人投资者涌入新上市ETF。" },
    { title: S6_TITLES.新股, url: "b", excerpt: "A股新股首日零破发。" },
  ];
  assert.equal(prune(items).length, 2, "锚 Jaccard 0.5 < 0.8 → 不得合并");
});

test("S6 反向守护：只共享地域锚的广州民生稿不得被并成一类", () => {
  const items = [
    { title: S6_TITLES.gzFestival1, url: "g1", excerpt: "国庆假期广州警方守护平安。" },
    { title: S6_TITLES.gzFestival2, url: "g2", excerpt: "国庆假期广州东至新塘建设者奋战一线。" },
  ];
  assert.equal(prune(items).length, 2, "「广州」是通用锚，不能单独构成同主题");
});

test("S6：空池 / 单条直接返回，顺序保持不变", () => {
  assert.deepEqual(prune([]), []);
  const one = [{ title: "唯一一条", url: "solo" }];
  assert.deepEqual(prune(one), one);
  const two = [
    { title: S6_TITLES.gzFestival1, url: "g1" },
    { title: S6_TITLES.etf, url: "a" },
  ];
  assert.deepEqual(prune(two).map((i) => i.url), ["g1", "a"], "不同主题时原顺序不变");
});

/* ------------------------------------------------------------------ *
 * 2026-10-29 sc：必读必须"页面看得到" + 国家政策不得被分数门槛埋掉
 * ------------------------------------------------------------------ */

test("排序优先级：正文条目 > 非正文；同组内国家政策 > 高分普通条", () => {
  process.env.REPORT_TZ = "Asia/Shanghai";
  const report: DailyReport = {
    date: TODAY,
    hero_line: "",
    must_read: [],
    insights: [],
    sections: {
      gz_local: [],
      biz_insight: [],
      policy_market: [
        mkReportItem("t-policy", "8000亿新型政策性金融工具投放完成，基建有望加速跑", "新型政策性金融工具投放完成，基建投资有望加速。"),
        mkReportItem("t-pbc", "央行发布三季度金融机构贷款投向统计报告", "信贷结构呈现积极变化，科技领域信贷表现亮眼。"),
      ],
      tech: [],
      ipo: [],
    },
  } as DailyReport;
  const arts = [
    { url: "t-policy", publishedAt: `${TODAY}T09:00:00+08:00`, category: "finance" },
    { url: "t-pbc", publishedAt: `${TODAY}T09:05:00+08:00`, category: "finance" },
  ];
  const hist: Record<string, ExecPoolHistoryEntry> = {
    // 昨日、非本期正文、分还不低（加拿大央行 10-29 实测 66 分）
    "y-ca": {
      publishedAt: `${YEST}T20:00:00+08:00`,
      category: "finance",
      ai_relevant: true,
      summary: "加拿大央行上调基准利率25个基点至2.5%",
      title: "加拿大央行加息25基点至2.5%",
      url: "y-ca",
    },
  };
  const res = buildTwoDayExecPool({ history: hist, articles: arts, report, today: TODAY, now: new Date() });
  const order = res.finance.map((i) => i.url);

  const iPolicy = order.indexOf("t-policy");
  const iPbc = order.indexOf("t-pbc");
  const iCa = order.indexOf("y-ca");
  assert.ok(iPolicy >= 0 && iPbc >= 0 && iCa >= 0, `三条都应在池内，实际 ${JSON.stringify(order)}`);

  // ① 正文全部排在非正文前面（加拿大 66 分也不得越过 43 分的正文政策条）
  assert.ok(iPolicy < iCa, "正文政策条应排在非正文的加拿大央行之前");
  assert.ok(iPbc < iCa, "正文的央行报告应排在非正文之前");

  // ② 正文组内：国家政策优先于更高分的普通正文条（央行报告 87 > 政策条 43）
  assert.ok(iPolicy < iPbc, "国家政策条应排在更高分的普通正文条之前");
  assert.equal(res.finance[0].url, "t-policy", "国家政策条应排池首");
  assert.equal(res.finance[0].inBody, true);
});

/* ------------------------------------------------------------------ *
 * 方案 C（2026-10-29 sc 授权）：同事件「数值口径不同」不得漏并
 * ------------------------------------------------------------------ */

test("S6 方案 C：同一事件的不同数值口径可合并（主体锚相同 + 标题 Dice ≥0.55）", () => {
  const items = [
    { title: "8000亿元新型政策性金融工具投放完成，资金到位节奏快于预期", summary: "投放完成。", url: "a" },
    { title: "8000亿新型政策性金融工具投放完成，基建有望加速跑", summary: "投放完成。", url: "b" },
  ];
  const out = pruneHomogeneousTopics(items);
  assert.equal(out.length, 1, "同题两条应合并（Dice 0.60 ≥ 0.55）");

  const items2 = [
    { title: "8000亿新型政策性金融工具投放完成，基建有望加速跑", summary: "投放完成。", url: "b" },
    { title: "2026年8000亿元新型政策性金融工具完成投放", summary: "投放完成。", url: "c" },
  ];
  assert.equal(pruneHomogeneousTopics(items2).length, 1, "数值锚不一致也要合并（Dice 0.58）");
});

test("S6 方案 C 反向守护：只共享粗体锚、讲不同事的不得被并（数字锚是区分力）", () => {
  const etf = [
    { title: "18只主动ETF开售在即 有望为A股带来360亿元增量资金", summary: "新基金发行。", url: "x" },
    { title: "最后10分钟进场！多只宽基ETF放量拉升近2000亿元入市", summary: "资金流入。", url: "y" },
  ];
  assert.equal(pruneHomogeneousTopics(etf).length, 2, "ETF 簇不该被并（Dice 0.15）");

  const insurance = [
    { title: "金融监管总局副局长丛林：保险业要精准对接重点领域和薄弱环节", summary: "监管表态。", url: "m" },
    { title: "中国人寿总裁利明光：推动普惠保险由风险补偿向风险减量转型", summary: "机构表态。", url: "n" },
  ];
  assert.equal(pruneHomogeneousTopics(insurance).length, 2, "保险簇不该被并（Dice 0.04）");
});
