/**
 * 只重跑「交易面板」一段（Yahoo 行情 + 技术面分析 + LLM 解读），
 * 把结果打补丁回已存在的 `daily_reports/<date>/<date>.json`。
 *
 * 用途：主流程日报没问题、但交易解读解析失败/字段为空时，
 * 不必再花一整轮 daily（~5 分钟、多次 LLM 调用）。
 *
 * 2.0 适配：
 *  - 抓取走适配器 `lib/adapters/market-yahoo.ts`（服务层零 IO）；
 *  - LLM 走 `LlmAdapter`（组合根装配，服务层零 SDK）；
 *  - **剥离加密**：gzinfo 的 `fetchCryptoFearGreed` / `fetchCryptoGlobal`
 *    两步按硬性规定（加密资产永久剔除）整体移除。
 *  - 唯一存储路径为 `daily_reports/<date>/`（2.0 口径，非 gzinfo 的 data/history/reports）。
 *
 * Usage:
 *   npm run regen:trading
 *   npm run regen:trading -- 2026-09-11
 *
 * 跑完再执行 `npm run render` 刷新 HTML。
 */
import fs from "node:fs";
import path from "node:path";
import { todayKey } from "../lib/utils/time";
import { fetchTickerData } from "../lib/adapters/market-yahoo";
import { analyzeWatchlist } from "../lib/services/market/trading-runner";
import { generateTradingCommentary } from "../lib/services/market/commentary";
import { LlmAdapter } from "../lib/adapters/llm";

async function main() {
  const date = process.argv[2] || todayKey();
  const base = path.resolve(process.cwd(), "daily_reports", date, date);
  const jsonPath = `${base}.json`;
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`报告 JSON 不存在：${jsonPath}（先跑 \`npm run daily\`）`);
  }
  const report = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

  console.log("[regen-trading] 抓取 watchlist 行情…");
  const t0 = Date.now();
  const tickers = await analyzeWatchlist(fetchTickerData);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[regen-trading] 行情完成：${tickers.length} 个标的（${secs}s）`);
  if (tickers.length === 0) {
    throw new Error("watchlist 全部抓取失败，中止（不写盘，避免覆盖成空段）");
  }

  console.log("[regen-trading] 生成交易解读…");
  const llm = new LlmAdapter();
  // LlmPort.complete 直接返回文本（契约：Promise<string>）
  const runner = (system: string, user: string) => llm.complete({ system, prompt: user, stage: "trading" });
  const commentary = await generateTradingCommentary({ tickers, now: new Date() }, runner);

  // 打补丁：交易段整体替换（技术面 + LLM 解读），其余字段不动
  const next = {
    ...report,
    trading: { tickers, commentary, updatedAt: new Date().toISOString() },
  };
  fs.writeFileSync(jsonPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  console.log(
    `[regen-trading] ✅ 已更新 ${jsonPath}：${tickers.length} 标的 + 解读（` +
      `market_overview ${commentary.market_overview.length} 字）`,
  );
}

main().catch((e) => {
  console.error(`[regen-trading] FAIL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
