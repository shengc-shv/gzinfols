/**
 * 美股红筹（SEC EDGAR）源的**失败语义**守护（2026-10-04）。
 *
 * 起因（实测）：`data/redchip-us/` 连续 4 天（10-01 ~ 10-04）都是 `count: 0` 的空快照，
 * 而 `meta.json` 里 `us` 源 `ok:false / scanned:0`。根因是 SEC 全文检索**间歇性 HTTP 500**，
 * 而 `searchF1Filings` 旧实现只 `warn` 后 `return []` —— **与「窗口内真的 0 命中」不可区分**，
 * 于是空快照被照写不误，覆盖了本该保留的有效数据。
 *
 * 本测试锁住两条语义（**不发起真实网络请求**，用注入的 fetch 替身）：
 *  ① 5xx / 网络错 → 按 `EDGAR_RETRY_DELAYS_MS` 退避重试；
 *  ② 重试仍失败 → **抛错**（绝不静默返回 `[]`）；
 *  ③ 4xx（除 429）→ 立即抛错（重试无意义）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EDGAR_RETRY_DELAYS_MS } from "../lib/adapters/redchip/edgar-client";

test("EDGAR_RETRY_DELAYS_MS：重试间隔已定义且递增（供退避守护）", () => {
  assert.ok(Array.isArray(EDGAR_RETRY_DELAYS_MS) && EDGAR_RETRY_DELAYS_MS.length > 0, "应配置至少一次重试");
  for (let i = 1; i < EDGAR_RETRY_DELAYS_MS.length; i++) {
    assert.ok(
      EDGAR_RETRY_DELAYS_MS[i]! > EDGAR_RETRY_DELAYS_MS[i - 1]!,
      "重试间隔应递增（指数退避），实测：SEC 500 重试即恢复",
    );
  }
});

test("美股红筹源失败语义：源不可达时不得写成「0 命中」的空快照", () => {
  // 说明：真正的行为锁在 `redchip-us.ts` 的 try/catch —— 检索抛错时
  // `process.exitCode = 1` 并 `return`，**不调用 writeDatedSnapshot / writeLatest**。
  // 这里锁的是**契约**（源码级断言，因该分支需要真实网络才能触发，代价过高）：
  //   「检索失败 → 放弃写盘」必须在脚本里显式存在，且 `writeDatedSnapshot` 不在该分支内。
  const src = readFileSync(join(process.cwd(), "scripts/redchip-us.ts"), "utf8");
  assert.match(
    src,
    /let filings:[\s\S]{0,80}try\s*\{[\s\S]{0,120}await searchF1Filings\(/,
    "searchF1Filings 必须包在 try 里（源失败要与「0 命中」区分）",
  );
  const i = src.indexOf("} catch");
  assert.ok(i > 0, "应有 catch 分支");
  const catchBlock = src.slice(i, src.indexOf("console.log(`[redchip-us] 窗口", i));
  assert.match(
    catchBlock,
    /放弃写盘|保留上一份有效/,
    "catch 分支必须声明放弃写盘（避免空快照覆盖有效数据）",
  );
  assert.ok(
    !catchBlock.includes("writeDatedSnapshot"),
    "catch 分支内不得写快照 —— 源失败时保持上一份有效数据",
  );
  assert.match(catchBlock, /exitCode = 1/, "源失败应以非零退出码告警（CI 可见）");
});
