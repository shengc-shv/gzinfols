/**
 * 渲染语言（REPORT_LOCALE）注入点。
 *
 * 2026-09-14 Phase 2b：实现已下沉至 `services/vocab/locale.ts`（解开 assemble → render
 * 反向依赖），此处保留 re-export 以兼容既有 import 路径。新代码请从 "../vocab" 引入。
 */
export { REPORT_LOCALE, setReportLocale } from "../vocab/locale";
