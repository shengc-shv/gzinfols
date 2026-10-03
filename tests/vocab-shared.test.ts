/**
 * 共享词表层 `services/vocab` 的单测（2026-10-03 架构审查 P1-3 落地）。
 *
 * ## 为什么补这个文件
 *
 * `lib/services/vocab/` 是**业务口径的源头**（部门标签映射、日期精度判定、报告语言），
 * 且被 assemble / render 共用 —— 但审查发现它此前**零测试覆盖**。
 * 口径写错了不会立刻报错，只会表现为「卡片时间少了个时分」或「部门标签没打上」，
 * 属于典型的静默劣化。
 *
 * 本文件只锁「有业务含义、且容易被环境差异坑到」的两处；纯静态词表（labels/strings）
 * 不测 —— 它们写错了在报告里一眼能看见，测了只是维护负担。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { hasDeptTag, isDateOnly } from "../lib/services/vocab/sort";
import { REPORT_LOCALE, setReportLocale } from "../lib/services/vocab/locale";
import { V2EX_OFF_TOPIC_RE } from "../lib/services/vocab/off-topic";
import type { ArticleInput } from "../lib/contracts/article";

/**
 * `isDateOnly` 锁的是**两种「只有日期」的存储形态**（时区红线：只认北京时间）：
 *  - 国内源存 UTC 零点（`T00:00:00Z` = 北京 08:00）；
 *  - ftchinese 存北京时间零点（`T16:00:00Z` = 北京次日 00:00）。
 * 两者都必须判为「只有日期」；有真实时分的 RSS 源两者都不命中 → 卡片展示时分。
 *
 * 这条一旦回归，用户看到的就是「10月3日的新闻全都没写时间」——静默且难以归因。
 */
test("isDateOnly：UTC 零点与北京零点两种存储形态都算「只有日期」", () => {
  assert.equal(isDateOnly(new Date("2026-10-03T00:00:00.000Z")), true, "国内源形态（= 北京 08:00，UTC 零点）");
  assert.equal(isDateOnly(new Date("2026-10-02T16:00:00.000Z")), true, "ftchinese 形态（= 北京 10-03 00:00）");
  assert.equal(isDateOnly(new Date("2026-10-03T16:00:00.000Z")), true, "同为北京零点（次日 00:00）也是 date-only");
  assert.equal(isDateOnly(new Date("2026-10-03T07:30:00.000Z")), false, "北京 15:30，有真实时分 → 展示时分");
  assert.equal(isDateOnly(new Date("2026-10-03T01:00:00.000Z")), false, "北京 09:00，有真实时分");
  assert.equal(isDateOnly(undefined), false, "缺时间按「不是 date-only」处理（不误降级）");
});

test("hasDeptTag：4 大零售部门标签映射（财富/私行/客群/信贷）", () => {
  for (const sub of ["gz-wealth", "cn-wealth", "gz-credit", "cn-credit", "gz-private", "cn-private", "gz-customer", "cn-customer"]) {
    assert.equal(hasDeptTag({ subcategory: sub } as ArticleInput), true, `${sub} 应命中部门标签`);
  }
  assert.equal(hasDeptTag({ subcategory: "tech" } as ArticleInput), false, "非零售部门不命中");
  assert.equal(hasDeptTag({ subcategories: ["tech", "gz-credit"] } as ArticleInput), true, "多标签时任一命中即可");
  assert.equal(hasDeptTag({} as ArticleInput), false, "无标签不命中");
});

/**
 * ⚠️ 本测试**只读**，不修改全局 `REPORT_LOCALE` —— `node --test` 会**跨文件并行**，
 * 改模块级全局会给并行的渲染类测试造成不稳定竞态（2026-10-03 自查发现）。
 * 注入本身由组合根在启动时调用 `setReportLocale`，无需在此模拟。
 */
test("报告语言：默认 zh，且提供组合根注入入口（服务层不读 env）", () => {
  assert.equal(REPORT_LOCALE, "zh", "默认简体中文（未注入时的基线）");
  assert.equal(typeof setReportLocale, "function", "注入入口存在，供组合根启动时调用");
});

/**
 * 社区源杂谈词表是**站点级**过滤 —— `assemble/group.ts` 里有源守卫：
 * `if ((a.sourceId === "v2ex-hot" || a.sourceId === "linuxdo") && V2EX_OFF_TOPIC_RE.test(a.title)) continue;`
 *
 * ⚠️ 词表里含「买房/房贷/存款/工资/失业」等**财经高频词**，一旦有人把守卫的源判断删掉
 * （或把它挪到全局过滤），「居民存款余额创新高」这类正常财经内容会被静默丢弃。
 * 本测试锁定「词表会命中财经词」这个事实，让守卫被删时至少有据可查。
 */
test("已知风险：杂谈词表会命中财经高频词 —— 依赖 group.ts 的源守卫兜住", () => {
  assert.equal(V2EX_OFF_TOPIC_RE.test("居民存款余额创新高"), true, "「存款」命中词表");
  assert.equal(V2EX_OFF_TOPIC_RE.test("多家银行明确房贷贴息操作细节"), true, "「房贷」命中词表");
  // 政策类正常内容不应命中 —— 这几条是「守卫必须存在」的理由
  assert.equal(V2EX_OFF_TOPIC_RE.test("广州优化住房政策支持刚改需求"), false, "「住房」不在杂谈词表");
  assert.equal(V2EX_OFF_TOPIC_RE.test("公募基金规模达39.63万亿元"), false, "正常基金新闻不命中");
  assert.equal(V2EX_OFF_TOPIC_RE.test("港股三大指数集体重挫"), false, "正常市场新闻不命中");
});
