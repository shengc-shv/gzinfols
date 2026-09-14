/**
 * 渲染 i18n（M3-C 拆分自 lib/output/render.ts）：文案表 TEXTS_ZH/TEXTS_EN、STR 解析、
 * 子类目顺序与标签。
 *
 * 2026-09-14 Phase 2b：实现已下沉至 `services/vocab`（解开 assemble → render 反向依赖），
 * 此处保留 re-export 以兼容既有 import 路径。新代码请从 "../vocab" 引入。
 */
export { STR, TEXTS_ZH, TEXTS_EN } from "../vocab/strings";
export { SUBCATEGORY_LABELS, SUBCATEGORY_ORDER } from "../vocab/labels";
