/**
 * 监控标的清单与分组标签 —— 移植自 gzinfo lib/trading/watchlist.ts。
 *
 * 2.0 调整：
 *  - 类型（AssetGroup / TickerDef）上移 `contracts/market.ts`（被服务层与适配器共用）；
 *  - **剔除 crypto 分组**（2026-09-12 硬性规定：加密资产永久剔除）；
 *  - locale 由调用方注入（服务层不直读 env）。
 */
import type { AssetGroup, TickerDef } from "../../contracts/market";

export function getDisplayName(t: TickerDef, locale: "zh" | "en"): string {
  return locale === "en" ? (t.displayNameEn ?? t.displayName) : t.displayName;
}

const ASSET_GROUP_LABELS_ZH: Record<AssetGroup, string> = {
  "us-equity": "美股 / ETF",
  "china-equity": "中概 / 港股",
  "commodity-fx": "商品 / 外汇",
  macro: "宏观信号",
};

const ASSET_GROUP_LABELS_EN: Record<AssetGroup, string> = {
  "us-equity": "US Stocks / ETF",
  "china-equity": "China / HK",
  "commodity-fx": "Commodities / FX",
  macro: "Macro",
};

export function getAssetGroupLabels(
  locale: "zh" | "en",
): Record<AssetGroup, string> {
  return locale === "en" ? ASSET_GROUP_LABELS_EN : ASSET_GROUP_LABELS_ZH;
}

export const ASSET_GROUP_ORDER: AssetGroup[] = [
  // 零售决策视角：A股风向 → 汇率/商品 → 宏观利率 → 全球/风险
  "china-equity",
  "commodity-fx",
  "macro",
  "us-equity",
];

export const WATCHLIST: TickerDef[] = [
  // === A股大盘（基金/权益产品营销窗口、客户投资意愿）===
  { symbol: "000001.SS", displayName: "上证指数", group: "china-equity" },
  { symbol: "000300.SS", displayName: "沪深300", group: "china-equity" },
  // === 汇率 / 商品（外币理财、结售汇、通胀与避险配置）===
  { symbol: "USDCNY=X", displayName: "美元 / 人民币", displayNameEn: "USD / CNY", group: "commodity-fx" },
  { symbol: "GC=F", displayName: "黄金", displayNameEn: "Gold", group: "commodity-fx" },
  { symbol: "CL=F", displayName: "WTI 原油", displayNameEn: "WTI Crude", group: "commodity-fx" },
  // === 宏观信号（利率/风险情绪：理财收益预期、债市）===
  { symbol: "^TNX", displayName: "10Y 美债收益率 (%)", displayNameEn: "10Y Treasury Yield (%)", group: "macro" },
  { symbol: "^VIX", displayName: "VIX 恐慌指数", displayNameEn: "VIX (Volatility)", group: "macro" },
  // === 全球风向（S&P500）===
  { symbol: "SPY", displayName: "S&P 500", group: "us-equity" },
  // 2026-08-21 用户：移除加密资产（境内零售无产品线、无业务参考价值）
];
