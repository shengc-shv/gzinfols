/**
 * 交易面板（B6 批次，2026-09-12 移植自 gzinfo lib/trading/*）。
 *
 * 覆盖三件事：
 *  ① 技术指标纯函数在已知输入下的正确性（SMA / RSI / MACD 长度与边界）；
 *  ② analyzeTicker 的多头/超买/接近 52 周高 判定；
 *  ③ **合规**：watchlist 与 AssetGroup 不得出现 crypto（加密资产永久剔除）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sma, ema, rsi, macd, detectRecentCross, last } from "../lib/services/market/indicators";
import {
  WATCHLIST,
  ASSET_GROUP_ORDER,
  getAssetGroupLabels,
  getDisplayName,
} from "../lib/services/market/watchlist";
import { analyzeTicker } from "../lib/services/market/signals";
import type { TickerRawData } from "../lib/contracts/market";

test("① 技术指标：SMA / EMA / RSI / MACD 长度与取值", () => {
  const v = [1, 2, 3, 4, 5];
  // 输出长度 = values.length - period + 1
  assert.deepEqual(sma(v, 2), [1.5, 2.5, 3.5, 4.5]);
  assert.equal(sma(v, 99).length, 0, "period 大于序列长度时返回空");
  assert.equal(ema(v, 2).length, v.length - 2 + 1);
  const r = rsi(Array.from({ length: 30 }, (_, i) => 100 + i), 14);
  assert.equal(r.length, 30 - 14, "RSI 输出长度 = closes.length - period");
  assert.ok((r.at(-1) ?? 0) > 70, `单调上涨序列 RSI 应超买，实际 ${r.at(-1)}`);
  const m = macd(Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 5));
  assert.equal(m.macd.length, 40 - 26 + 1, "MACD 线长度 = 慢线 EMA 长度");
  assert.equal(m.signal.length, m.macd.length - 9 + 1);
  assert.equal(m.histogram.length, m.signal.length);
  assert.equal(last([1, 2, 3]), 3);
  assert.equal(last([]), undefined);
});

/** 构造 N 根线性上涨 K 线（用于趋势判定）。 */
function risingRaw(n: number, price: number): TickerRawData {
  return {
    symbol: "TEST",
    currency: "CNY",
    exchangeName: "SH",
    regularMarketPrice: price,
    fiftyTwoWeekHigh: price * 1.01,
    fiftyTwoWeekLow: price * 0.5,
    candles: Array.from({ length: n }, (_, i) => {
      const c = price * (0.5 + (0.5 * i) / n);
      return {
        date: new Date(Date.UTC(2025, 0, 1) + i * 86_400_000),
        open: c,
        high: c * 1.01,
        low: c * 0.99,
        close: c,
        volume: 1000,
      };
    }),
  };
}

test("② analyzeTicker：上涨序列判多头 + 超买 + 接近 52 周高", () => {
  const a = analyzeTicker(WATCHLIST[0], risingRaw(220, 200));
  assert.equal(a.trend, "bullish");
  assert.ok(a.rsi14 !== null && a.rsi14 > 70, `RSI 应超买，实际 ${a.rsi14}`);
  assert.equal(a.rsiState, "overbought");
  const types = a.signals.map((s) => s.type);
  assert.ok(types.includes("rsi-overbought"), `应含 rsi-overbought，实际 ${types}`);
  assert.ok(types.includes("near-52w-high"), `应含 near-52w-high，实际 ${types}`);
  assert.ok(types.includes("above-sma50-sma200"), `应含多头排列，实际 ${types}`);
});

test("② detectRecentCross：交叉检测返回天数", () => {
  const fast = [1, 1, 3, 4];
  const slow = [2, 2, 2, 2];
  const d = detectRecentCross(fast, slow);
  assert.ok(d !== null, "应检测到上穿");
  assert.equal(d!.direction, "up");
  assert.ok(d!.daysAgo >= 0);
  // 无交叉（快慢线始终同向）→ null
  assert.equal(detectRecentCross([3, 4, 5], [1, 2, 3]), null);
});

test("③ 合规：watchlist 与分组标签不含 crypto", () => {
  for (const t of WATCHLIST) {
    assert.notEqual(t.group, "crypto", `${t.symbol} 不得属于 crypto 分组`);
  }
  assert.ok(!ASSET_GROUP_ORDER.includes("crypto" as never), "分组顺序不得含 crypto");
  for (const locale of ["zh", "en"] as const) {
    const labels = getAssetGroupLabels(locale);
    assert.ok(!("crypto" in labels), `${locale} 分组标签不得含 crypto`);
  }
  // 展示名双语回退
  const withEn = WATCHLIST.find((t) => t.displayNameEn);
  assert.ok(withEn, "至少有一个标的带英文展示名");
  assert.equal(getDisplayName(withEn!, "zh"), withEn!.displayName);
  assert.equal(getDisplayName(withEn!, "en"), withEn!.displayNameEn);
});
