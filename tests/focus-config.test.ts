/**
 * 经营重点配置（二期 WP1）守护。
 *
 * 锁住规格 2.5 的校验规则与 10.2 的降级要求：
 *  - 非法配置**逐条丢弃 + 告警**，不整份废弃、不抛错；
 *  - 过期 / 未启用的重点绝不参与加权；
 *  - 文件缺失或损坏时必须能区分「没配置」与「配错了」，并让引擎安全降级；
 *  - 同一份配置的版本指纹稳定（同内容同版本，任一处改动即变）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFocusConfig, isFocusEffective, isFocusInWindow } from "../lib/services/business-focus/config-loader";
import { normalizeFocusFile } from "../lib/services/business-focus/config-validator";
import type { FocusFileInput } from "../lib/services/business-focus/types";
import { readFocusConfigFiles } from "../lib/adapters/business-focus/config-store";

const TODAY = "2026-11-28";

function file(layer: FocusFileInput["layer"], items: unknown[], extra: Record<string, unknown> = {}): FocusFileInput {
  return { file: `config/${layer}-focus.json`, layer, state: "ok", data: { version: `${layer}.v1`, focus_items: items, ...extra } };
}

function item(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "x1",
    name: "测试重点",
    level: "quarterly",
    grade: "A",
    status: "active",
    priority: 1.5,
    highlight: false,
    start_date: "2026-10-01",
    end_date: "2026-12-31",
    domains: ["wealth_aum"],
    keywords: ["资产配置"],
    ...over,
  };
}

test("① 真实三份配置可加载：无损坏、无 error 级问题、生效清单与业务确认一致", () => {
  const files = readFocusConfigFiles();
  const r = loadFocusConfig(files, { today: TODAY });
  assert.equal(r.degraded, false, "三份配置文件都应存在且可解析");
  assert.deepEqual(r.issues, [], "配置不应有校验问题");
  assert.ok(r.items.length >= 8, `配置条目过少：${r.items.length}`);
  // 业务确认口径（2026-11-28）：年度三个方向 = AUM / 高端客群（私行）/ 小微普惠；
  // 季度围绕它们收窄 + 风险侧保留消保。代发与「重点监管政策跟踪」保持 inactive
  // （前者窗口内无事件，后者一旦放宽会把宏观政策稿全部 +30）。
  assert.deepEqual(
    r.active.map((x) => x.id).sort(),
    ["a26_aum", "a26_inclusive_sme", "a26_private_banking", "q4_consumer_protection", "q4_high_end_aum", "q4_housing_finance", "q4_inclusive_sme"],
    "生效清单 = 年度三方向 + 季度四条",
  );
  const inactive = r.items.filter((x) => x.status === "inactive").map((x) => x.id);
  assert.ok(inactive.includes("q4_payroll_to_wealth"), "代发转化未启用");
  assert.ok(inactive.includes("t26_policy_tracking"), "政策跟踪未启用");
  assert.match(r.version, /^f-[0-9a-f]{8}$/, "版本号形如 f-xxxxxxxx");
  for (const it of r.items) {
    assert.ok(["annual", "quarterly", "temporary"].includes(it.layer));
    assert.ok(it.domains.length > 0, `${it.id} 缺关联领域`);
    assert.ok(it.core_keywords.length + it.keywords.length + it.synonyms.length > 0, `${it.id} 缺关键词`);
  }
});

test("② 生效窗口：窗口内参与，过期/未到期不参与，缺结束日视为长期", () => {
  assert.equal(isFocusInWindow({ start_date: "2026-10-01", end_date: "2026-12-31" }, "2026-11-28"), true);
  assert.equal(isFocusInWindow({ start_date: "2026-10-01", end_date: "2026-10-31" }, "2026-11-28"), false);
  assert.equal(isFocusInWindow({ start_date: "2026-12-01", end_date: "" }, "2026-11-28"), false);
  assert.equal(isFocusInWindow({ start_date: "", end_date: "" }, "2026-11-28"), true);
  assert.equal(isFocusEffective({ status: "inactive", start_date: "", end_date: "" }, TODAY), false);

  const r = loadFocusConfig([file("quarterly", [item({ id: "in", status: "active" }), item({ id: "out", end_date: "2026-10-31" }), item({ id: "off", status: "inactive" })])], { today: TODAY });
  assert.deepEqual(r.active.map((x) => x.id), ["in"], "只有 active 且在窗口内的才生效");
  assert.equal(r.items.length, 3, "未生效的仍在全量清单里（供页面显示已配置未启用）");
});

test("③ 日期倒挂：跳过该条并告警，不影响同文件其它条目", () => {
  const r = loadFocusConfig(
    [file("quarterly", [item({ id: "bad", start_date: "2026-12-31", end_date: "2026-10-01" }), item({ id: "ok" })])],
    { today: TODAY },
  );
  assert.deepEqual(r.items.map((x) => x.id), ["ok"]);
  assert.ok(r.issues.some((i) => i.id === "bad" && /晚于/.test(i.message)), "必须留下配置问题记录");
});

test("④ 非法字段逐条兜底：level/grade/status/priority/日期/领域/空关键词", () => {
  const r = loadFocusConfig(
    [
      file("quarterly", [
        item({ id: "lvl", level: "monthly" }),
        item({ id: "grade", grade: "Z" }),
        item({ id: "status", status: "on" }),
        item({ id: "prio", priority: 99 }),
        item({ id: "date", start_date: "2026/10/01" }),
        item({ id: "dom", domains: ["not_a_domain"] }),
        item({ id: "kw", keywords: [], core_keywords: [], synonyms: [] }),
      ]),
    ],
    { today: TODAY },
  );
  const kept = r.items.map((x) => x.id);
  assert.deepEqual(kept, ["lvl", "grade", "status", "prio", "date"], "领域为空/关键词为空的条目必须直接丢弃");
  assert.equal(r.items[0].layer, "quarterly", "非法 level 按文件层兜底");
  assert.equal(r.items[1].grade, "B", "非法 grade 降为 B");
  assert.equal(r.items[2].status, "inactive", "非法 status 按 inactive（宁可不加权）");
  assert.equal(r.items[3].priority, 1.5, "priority 越界用层级默认值");
  assert.equal(r.items[4].start_date, "", "非法日期忽略该字段而不是整条丢弃");
  assert.deepEqual(r.active.map((x) => x.id), ["lvl", "grade", "prio", "date"], "只有 status 非法的条目被降级为不生效");
  assert.ok(r.issues.length >= 7, `问题记录应逐条留存，实际 ${r.issues.length}`);
});

test("⑤ 跨文件 id 重复：保留先出现层级，后者丢弃并告警", () => {
  const r = loadFocusConfig(
    [
      file("annual", [item({ id: "dup", level: "annual", start_date: "2026-01-01" })]),
      file("quarterly", [item({ id: "dup", level: "quarterly" })]),
    ],
    { today: TODAY },
  );
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].layer, "annual");
  assert.ok(r.issues.some((i) => i.id === "dup" && /重复/.test(i.message)));
});

test("⑥ 文件缺失 / 损坏：degraded=true、active 为空、绝不抛错", () => {
  const missing: FocusFileInput = { file: "config/annual-focus.json", layer: "annual", state: "missing" };
  const corrupt: FocusFileInput = { file: "config/quarterly-focus.json", layer: "quarterly", state: "corrupt", error: "Unexpected token" };
  const ok = file("temporary", [item({ id: "t1", level: "temporary" })]);
  const r = loadFocusConfig([missing, corrupt, ok], { today: TODAY });
  assert.equal(r.degraded, true);
  assert.deepEqual(r.active.map((x) => x.id), ["t1"], "坏层按空处理，好层照常生效");
  assert.ok(r.issues.some((i) => /不存在/.test(i.message)));
  assert.ok(r.issues.some((i) => /解析失败/.test(i.message)));
});

test("⑦ 版本指纹：同内容稳定、改一处即变、告警不影响版本", () => {
  const a = loadFocusConfig([file("quarterly", [item()])], { today: TODAY });
  const b = loadFocusConfig([file("quarterly", [item()])], { today: TODAY });
  assert.equal(a.version, b.version, "同一份配置必须得到同一版本号");
  const c = loadFocusConfig([file("quarterly", [item({ keywords: ["资产配置", "新增词"] })])], { today: TODAY });
  assert.notEqual(a.version, c.version, "改关键词必须换版本");
  const d = loadFocusConfig([file("quarterly", [item({ status: "inactive" })])], { today: TODAY });
  assert.notEqual(a.version, d.version, "启停重点必须换版本（否则历史无法追溯当时为何加权）");
});

test("⑧ 归一化不 mutate 入参配置，且缺省值可预期", () => {
  const raw = item({ grade: undefined, status: undefined, highlight: undefined, description: undefined });
  const snapshot = JSON.stringify(raw);
  const out = normalizeFocusFile(file("quarterly", [raw]));
  assert.equal(JSON.stringify(raw), snapshot, "校验不得改动调用方传入的对象");
  assert.equal(out.items[0].grade, "B");
  assert.equal(out.items[0].status, "inactive");
  assert.equal(out.items[0].highlight, false);
  assert.equal(out.items[0].description, "");
});
