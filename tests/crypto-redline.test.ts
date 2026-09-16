/**
 * 加密资产零容忍红线（用户 2026-09-12 拍板，永久）：**不移植、不渲染、不进契约**。
 *
 * 本测试锁住 2026-09-16 实锤修复的漏网路径：`stock_news`（股市动态）由 market 服务
 * 独立构建，**不经过 enrich 管线的违禁词早筛** —— 实证 2026-09-16 报告的 stock_news
 * 出现「加密货币市场遭遇重大利空」并已渲染到线上页面。现由渲染入口统一兜底过滤。
 *
 * 注意「Token贷/词元贷」是银行信贷产品，与加密无关，不在本词表（勿误加）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripCryptoNews, hitsCrypto } from "../lib/services/assemble/safety";
import { renderHtml } from "../lib/services/render";
import { CRYPTO_WORDS, BANNED_WORDS } from "../lib/services/enrich/validator";
import type { DailyReport } from "../lib/contracts/report";

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
