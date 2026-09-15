/**
 * 红筹徽章加锁测试（plan-redchip-crawl-push §2.2 / §3.3 / Trigger T2·T4·T5·T6）。
 * 全部离线纯函数。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { redchipBadgeOf } from "../lib/services/classify/redchip";
import type { RedchipChange, RedchipLead } from "../lib/contracts/redchip";

function lead(over: Partial<RedchipLead> = {}): RedchipLead {
  return {
    leadId: "108870",
    appId: "108870",
    nameCn: "深圳市海柔創新智能科技集團股份有限公司",
    nameEn: "Hai Robotics Innovation Group Co., Ltd.",
    board: "主板",
    status: "处理中",
    submitDate: "2026-09-13",
    domicile: "开曼群岛",
    isOffshore: true,
    gdCityHits: 5,
    isGdConnected: true,
    vie: "none",
    verdict: "redchip",
    discoveredAt: "2026-09-15T08:00:00+08:00",
    sourceUrl: "https://www1.hkexnews.hk/app/sehk/2026/108870/documents/sehk26091300124.pdf",
    ...over,
  };
}

const TODAY = "2026-09-15";

test("① T2：non-redchip 不打标；窗口外不打标", () => {
  assert.equal(redchipBadgeOf(lead({ verdict: "non-redchip" }), { today: TODAY }), undefined);
  // 提交日 09-01，相对 09-15 日差 14 > 7 → 出展示窗
  assert.equal(redchipBadgeOf(lead({ submitDate: "2026-09-01" }), { today: TODAY }), undefined);
});

test("② redchip 窗内 → 徽章含文案/编号/注册地/词频（口播所需字段齐全）", () => {
  const b = redchipBadgeOf(lead(), { today: TODAY });
  assert.ok(b);
  assert.equal(b.label, "红筹线索");
  assert.equal(b.leadId, "108870");
  assert.equal(b.verdict, "redchip");
  assert.equal(b.domicile, "开曼群岛");
  assert.equal(b.gdCityHits, 5);
  assert.equal(b.isNew, false, "未传 isNew → 默认 false");
});

test("③ veredict=unverified → 待核文案；仍可打标（进卡片）", () => {
  const b = redchipBadgeOf(lead({ verdict: "unverified", domicile: undefined }), { today: TODAY });
  assert.ok(b);
  assert.equal(b.label, "红筹线索·待核");
});

test("④ added → isNew 角标；changed → 字段标记 + 人话摘要（§3.3）", () => {
  const b1 = redchipBadgeOf(lead(), { today: TODAY, isNew: true });
  assert.equal(b1?.isNew, true);

  const changes: RedchipChange[] = [
    { at: "2026-09-15T08:00:00+08:00", type: "changed", appId: "108870", field: "状态", from: "处理中", to: "已受理" },
    { at: "2026-09-15T08:00:00+08:00", type: "changed", appId: "108870", field: "注册地", from: "开曼群岛", to: "百慕大" },
    // 干扰项：别的线索 / removed 类型不得混入
    { at: "2026-09-15T08:00:00+08:00", type: "changed", appId: "999999", field: "状态", from: "a", to: "b" },
    { at: "2026-09-15T08:00:00+08:00", type: "removed", appId: "108870" },
  ];
  const b2 = redchipBadgeOf(lead(), { today: TODAY, changes });
  assert.deepEqual(b2?.changedFields, ["状态", "注册地"]);
  assert.equal(b2?.changeSummary, "状态 处理中→已受理；注册地 开曼群岛→百慕大");
});

test("⑤ T5/T6：报告入口 —— 缺省无入口；传入 pre-meeting 为默认；deep 覆盖生效", () => {
  assert.equal(redchipBadgeOf(lead(), { today: TODAY })?.reportUrl, undefined);

  const pre = redchipBadgeOf(lead(), { today: TODAY, reportUrl: "redchip/r/108870.html" });
  assert.equal(pre?.reportUrl, "redchip/r/108870.html");
  assert.equal(pre?.reportKind, "pre-meeting", "未指定 kind → 默认会前版本");

  const deep = redchipBadgeOf(lead(), {
    today: TODAY,
    reportUrl: "redchip/deep/108870.html",
    reportKind: "deep",
  });
  assert.equal(deep?.reportKind, "deep", "深度版存在时应覆盖会前版本");
});

test("⑥ T4 提权所需信号：徽章存在即可被排序层识别（不占额外名额）", () => {
  // 排序层只依赖「item.redchip 是否存在」；此处锁定该契约不变式：
  // 有徽章 → 存在；无徽章（non-redchip / 窗口外）→ 不存在。
  assert.ok(redchipBadgeOf(lead(), { today: TODAY }));
  assert.equal(redchipBadgeOf(lead({ verdict: "non-redchip" }), { today: TODAY }), undefined);
});
