/**
 * 渲染语言（REPORT_LOCALE）注入点。
 *
 * gzinfo 从 env 直读；2.0 服务层禁止读 env —— 由组合根/scripts 启动时调
 * `setReportLocale(process.env.REPORT_LOCALE)` 写入。ESM live binding：
 * 各渲染子模块 `import { REPORT_LOCALE }` 会看到更新后的值。
 * 未注入时默认 zh（简体中文为主产出，en 文案为 gzinfo 既有能力保留）。
 */
export let REPORT_LOCALE: "zh" | "en" = "zh";

export function setReportLocale(v: string | undefined): void {
  if (v === "en" || v === "zh") REPORT_LOCALE = v;
}
