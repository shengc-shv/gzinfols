/**
 * 加密资产零容忍红线（用户 2026-09-12 拍板，永久）：**不移植、不渲染、不进契约**。
 *
 * 本测试锁住两条实证漏网路径（均**已渲染上线**）：
 *   · 2026-09-16 `stock_news`（股市动态）出现「加密货币市场遭遇重大利空」；
 *   · 2026-10-03 `stock_recap.us.sectors[2]` =「比特币周内小幅上涨…」—— 当时的
 *     `stripCryptoNews` **只管 stock_news**，看不见这条；且过滤只在渲染层，而
 *     **音频在 renderHtml 之前装配** → 口播读的是未过滤 report（没念到只是侥幸）。
 * 现由 `sanitizeCrypto` 在**旁路汇聚处**统一过滤（渲染入口保留为幂等安全网）。
 *
 * 注意「Token贷/词元贷」是银行信贷产品，与加密无关，不在本词表（勿误加）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeCrypto, stripCryptoNews, hitsCrypto } from "../lib/services/assemble/safety";
import { renderHtml } from "../lib/services/render";
import { CRYPTO_WORDS, BANNED_WORDS } from "../lib/services/enrich/validator";
import type { DailyReport, StockRecap } from "../lib/contracts/report";

function report(stockNews: unknown[]): DailyReport {
  return {
    date: "2026-09-16",
    hero_line: "",
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
    stock_news: stockNews,
  } as unknown as DailyReport;
}

/** 真实形态的三卡（2026-10-03 线上那条 us.sectors 即取自此处）。 */
function capReport(mut: Partial<Record<"us" | "aShare" | "hk", unknown>> = {}): DailyReport {
  const card = (over: Record<string, unknown> = {}) => ({
    overview: "美股三大指数集体收涨，纳指盘中创新高。",
    sectors: ["美股三大指数集体收涨，纳指盘中创新高，英伟达刷新纪录高位。"],
    ...over,
  });
  const recap = {
    us: card({
      sectors: [
        "美股三大指数集体收涨，纳指盘中创新高，英伟达盘中刷新纪录高位。",
        "比特币周内小幅上涨，市场削减美联储加息押注。",
        "欧洲冬季能源紧张或已启动，CNBC点名两只受益美股。",
      ],
      ...(mut.us as Record<string, unknown> | undefined),
    }),
    aShare: card(mut.aShare as Record<string, unknown> | undefined),
    hk: card(mut.hk as Record<string, unknown> | undefined),
  } as unknown as StockRecap;
  return { ...report([]), stock_recap: recap };
}

test("红线：stock_news 里的加密条目被剔除（不渲染）", () => {
  const r = stripCryptoNews(
    report([
      { title: "加密货币市场遭遇重大利空！里程碑法案遭否决", url: "u-crypto" },
      { title: "港股收评：恒指涨0.19% 科指涨0.79%", url: "u-normal" },
    ]),
  );
  assert.equal(r.stock_news?.length, 1, "加密条目必须剔除，正常行情保留");
  assert.equal((r.stock_news?.[0] as { url: string }).url, "u-normal");
});

test("红线：渲染产物中不得出现加密词（端到端）", () => {
  const html = renderHtml(report([{ title: "比特币大涨引发关注", url: "u3" }]));
  assert.ok(!html.includes("比特币"), "渲染产物不得包含加密资产内容");
  assert.ok(!html.includes("u3"), "该条目整体不得被渲染");
});

test("红线：摘要/正文里的加密词同样无处可渲染（正常条目不受影响）", () => {
  const r = stripCryptoNews(
    report([{ title: "某行推出Token贷支持小微", url: "u-token" }]),
  );
  assert.equal(
    r.stock_news?.length,
    1,
    "Token贷是银行信贷产品，与加密无关，必须保留（勿误删）",
  );
});

test("不误伤：「偏上行/偏下行」是话术词，不得因加密过滤删除行情条目", () => {
  const r = stripCryptoNews(report([{ title: "指数偏上行", url: "u4" }]));
  assert.equal(r.stock_news?.length, 1);
  assert.ok(!hitsCrypto({ title: "指数偏上行" }), "偏上行不在加密词表");
});

test("词表一致性：CRYPTO_WORDS 是 BANNED_WORDS 的子集（避免两份词表漂移）", () => {
  for (const w of CRYPTO_WORDS) {
    assert.ok(BANNED_WORDS.includes(w), `加密词 ${w} 必须同步在 BANNED_WORDS 中`);
  }
});

// ---------- 2026-10-03：股票复盘（stock_recap）同样零容忍 ----------

test("红线：stock_recap 的加密板块句被剔除（其余板块句保留、顺序不变）", () => {
  const { report: r, stats } = sanitizeCrypto(capReport());
  assert.equal(stats.sectors, 1, "恰好剔除 1 条板块句");
  assert.deepEqual(r.stock_recap?.us?.sectors, [
    "美股三大指数集体收涨，纳指盘中创新高，英伟达盘中刷新纪录高位。",
    "欧洲冬季能源紧张或已启动，CNBC点名两只受益美股。",
  ]);
  assert.equal(r.stock_recap?.aShare?.sectors.length, 1, "无关卡不得被改动");
});

test("红线：overview 命中加密 → 只剥离命中句，不整段删除", () => {
  const { report: r, stats } = sanitizeCrypto(
    capReport({ us: { overview: "纳指收涨。比特币突破新高。债市收益率上行。" } }),
  );
  assert.equal(stats.sentences, 1);
  assert.equal(r.stock_recap?.us?.overview, "纳指收涨。债市收益率上行。", "未命中的句子必须保留");
});

test("红线：overview 整段只剩加密句 → 清空而非留半句", () => {
  const { report: r } = sanitizeCrypto(capReport({ us: { overview: "比特币突破新高。" } }));
  assert.equal(r.stock_recap?.us?.overview, "");
});

test("红线：spoken 命中加密 → 剥句；清空后去掉字段（让口播回落到 overview/sectors 派生）", () => {
  const partial = sanitizeCrypto(
    capReport({ us: { spoken: "美股收涨。比特币走强。" } }),
  ).report;
  assert.equal(partial.stock_recap?.us?.spoken, "美股收涨。");

  const emptied = sanitizeCrypto(capReport({ us: { spoken: "比特币走强。" } })).report;
  assert.ok(
    !("spoken" in (emptied.stock_recap?.us ?? {})),
    "整段被剥空时必须移除字段 —— 否则旧值会被 `...card` 带回来",
  );
});

test("红线：素材来源标题命中加密 → 抹除该引用（meta 其余字段不受影响）", () => {
  const rec = sanitizeCrypto(
    capReport({
      us: {
        meta: { source: "s", date: "2026-10-03", quoteSource: "q" },
        sourceReport: { title: "比特币今日行情", url: "u" },
      },
    }),
  ).report;
  assert.equal(rec.stock_recap?.us?.sourceReport, undefined);
  assert.equal(rec.stock_recap?.us?.meta?.source, "s", "meta 其余字段不得丢");
});

test("幂等 + 不 mutate + 无命中时引用相等", () => {
  const clean = report([{ title: "港股收评：恒指涨0.19%", url: "u" }]);
  const once = sanitizeCrypto(clean);
  assert.equal(once.report, clean, "无命中必须原对象返回（调用方无需判等）");
  assert.deepEqual(once.stats, { stockNews: 0, sectors: 0, sentences: 0 });

  const dirty = sanitizeCrypto(capReport());
  const twice = sanitizeCrypto(dirty.report);
  assert.deepEqual(twice.stats, { stockNews: 0, sectors: 0, sentences: 0 }, "二次过滤应无事可做");
  assert.equal(twice.report, dirty.report);
});

test("红线（端到端）：渲染产物里不得出现加密词（stock_news 与 stock_recap 双路径）", () => {
  const withCryptoNews = { ...capReport(), stock_news: [{ title: "比特币大涨引发关注", url: "u-c" }] };
  const html = renderHtml(withCryptoNews as unknown as DailyReport);
  assert.ok(!html.includes("比特币"), "渲染产物不得包含加密资产内容（含股票复盘板块句）");
  assert.ok(!html.includes("u-c"), "加密动态条目整体不得被渲染");
  assert.ok(html.includes("欧洲冬季能源紧张"), "同一张卡的正常板块句仍应渲染");
});

/* ------------------------------------------------------------------ *
 * 2026-11-02 事故回归：10-30 / 11-01 / 11-02 三天加密内容已渲染上线
 * ------------------------------------------------------------------ */

test("红线（2026-11-02 事故）：加密安全事件 / 币安 / 加密盗窃 / 加密股 必须命中", () => {
  // 实测漏网原句（已出现在线上页面 stock_recap.us）
  const leaked = [
    "纳指跌2.86%，标普跌1.82%，AI交易现裂痕叠加加密安全事件拖累。",
    "币安遭约63亿美元黑客攻击，创加密盗窃纪录，约30亿美元已冻结。",
    "加密股财报分化，加密投资回暖抵消交易疲弱。",
    "Robinhood股价下挫，加密低迷拖累利润，新业务增长被抵消。",
    "Coinbase三季度净利大增66%",
  ];
  for (const s of leaked) {
    assert.ok(hitsCrypto({ title: s }), `应拦截：${s}`);
  }

  const dirty = sanitizeCrypto({
    ...report([]),
    stock_recap: {
      us: {
        overview: "纳指跌2.86%，AI交易现裂痕叠加加密安全事件拖累。",
        sectors: ["币安遭约63亿美元黑客攻击，创加密盗窃纪录。", "AI交易出现裂痕，AMD成少数亮点。"],
        indices: [],
        meta: { source: "CNBC Investing", quoteSource: "新浪行情", date: "2026-11-01" },
      },
    } as unknown as StockRecap,
  } as DailyReport);
  assert.ok(dirty.stats.sectors + dirty.stats.sentences > 0, "事故报告应被清洗");
  assert.ok(!JSON.stringify(dirty.report).includes("加密"), "清洗后不得残留加密字样");
  assert.ok(JSON.stringify(dirty.report).includes("AMD"), "同一张卡的正常板块句仍保留");
});

test("红线反向守护：银行科技稿的「数据加密/加密算法/加密传输」不得被误杀", () => {
  const safe = [
    "该行完成数据加密传输改造，全部通道启用国密算法",
    "量子加密技术试点落地，加密芯片进入测试阶段",
    "加密存储方案通过验收，加密网关完成部署",
    "手机银行采用加密协议保障交易安全",
  ];
  for (const s of safe) {
    assert.ok(!hitsCrypto({ title: s }), `不得误杀：${s}`);
  }
});
