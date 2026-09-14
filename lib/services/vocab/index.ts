/**
 * 共享词表 barrel（2026-09-14 Phase 2b）。
 *
 * 组装层（assemble/group.ts）与渲染层共用的语言原语、文案表、分类/子分类标签、
 * 站点过滤正则与排序函数。新代码从此处引入，避免依赖 render 层造成反向依赖。
 */
export * from "./locale";
export * from "./strings";
export * from "./labels";
export * from "./off-topic";
export * from "./sort";
