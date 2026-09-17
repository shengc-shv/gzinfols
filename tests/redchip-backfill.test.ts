/**
 * 红筹台账基线回填 + 累积合并锁（2026-09-17）。
 *
 * 背景：`redchip-monitor` 只有「今天 + 昨天」增量窗口 → 在册申请从来没有基线，
 * 且原实现每天用当日窗口**覆盖** leads.json → 线上恒「共 1 家（红筹 0）」。
 * 本例锁住两件事：① 上游行 → 本仓口径的映射正确；② 合并语义（累积、不丢、可复现）。
 *
 * 🔴 红线锁：上游招股书原文含「主要往来银行」行名，本模块输入类型**刻意不含**原文列 ——
 * 本例用「序列化后扫描行名」把这条纪律钉死，防止后来者图省事把原文塞进模型。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mergeProjects,
  pickRedchipRows,
  projectFromUpstreamRow,
  vieOfFlag,
  type UpstreamListingRow,
} from "../lib/services/redchip/backfill";
import type { RedchipProject } from "../lib/contracts/redchip";

function row(over: Partial<UpstreamListingRow> = {}): UpstreamListingRow {
  return {
    appId: "108804",
    nameCn: "錢大媽國際控股有限公司",
    nameEn: "Qdama International Holding Ltd.",
    board: "主板",
    status: "处理中",
    stockCode: "",
    submitDate: "2026-08-21",
    domicile: "开曼群岛",
    gdOpcoCount: 149,
    vieFlag: "否",
    proofUrl: "https://www1.hkexnews.hk/app/sehk/2026/108804/documents/x.pdf",
    ...over,
  };
}

test("① 上游行映射：离岸 ∧ 词频达标 → 红筹线索（口径与 classifyProject 一致）", () => {
  const p = projectFromUpstreamRow(row(), "2026-09-17T12:00:00+08:00");
  assert.equal(p.appId, "108804");
  assert.equal(p.isOffshore, true);
  assert.equal(p.gdCityHits, 149);
  assert.equal(p.isGdConnected, true);
  assert.equal(p.verdict, "redchip");
  assert.equal(p.discoveredAt, "2026-09-17T12:00:00+08:00");
  assert.equal(p.vie, "none");
});

test("② 判定边界：非离岸 / 词频不足 → 一律 non-redchip（宁缺毋滥）", () => {
  // 境内主体（H 股）：不因为「广东词频高」就成了红筹
  const domestic = projectFromUpstreamRow(
    row({ domicile: "中国(境内)", gdOpcoCount: 200 }),
    "2026-09-17T12:00:00+08:00",
  );
  assert.equal(domestic.isOffshore, false);
  assert.equal(domestic.verdict, "non-redchip");

  // 离岸但词频 2（阈值 3）→ 证据不足，不收
  const thin = projectFromUpstreamRow(
    row({ gdOpcoCount: 2 }),
    "2026-09-17T12:00:00+08:00",
  );
  assert.equal(thin.isOffshore, true);
  assert.equal(thin.isGdConnected, false);
  assert.equal(thin.verdict, "non-redchip");

  // 注册地缺失 → 不猜
  const unknown = projectFromUpstreamRow(
    row({ domicile: undefined }),
    "2026-09-17T12:00:00+08:00",
  );
  assert.equal(unknown.isOffshore, false);
  assert.equal(unknown.verdict, "non-redchip");
});

test("③ 台账过滤：只留离岸 ∧ 词频 ≥ 3；境内主体整批不收", () => {
  const rows = [
    row({ appId: "108804", domicile: "开曼群岛", gdOpcoCount: 149 }),
    row({ appId: "107812", domicile: "中国(境内)", gdOpcoCount: 300 }),
    row({ appId: "108850", domicile: "开曼群岛", gdOpcoCount: 2 }),
    row({ appId: "108860", domicile: "百慕大", gdOpcoCount: 3 }),
  ];
  const picked = pickRedchipRows(rows).map((r) => r.appId);
  assert.deepEqual(picked, ["108804", "108860"]);
});

test("④ 累积合并：同 appId 覆盖判定字段，但 discoveredAt 保留最早（台账属性）", () => {
  const older: RedchipProject = {
    ...projectFromUpstreamRow(row({ appId: "108804" }), "2026-08-22T09:00:00+08:00"),
  };
  // 同日重抓：状态推进（处理中 → 已上市），发现时间不该被刷新
  const newer = projectFromUpstreamRow(
    row({ appId: "108804", status: "已上市" }),
    "2026-09-17T12:00:00+08:00",
  );
  const merged = mergeProjects([older], [newer]);
  assert.equal(merged.length, 1, "同 appId 不得产生重复条目");
  assert.equal(merged[0]!.status, "已上市", "新数据须覆盖");
  assert.equal(merged[0]!.discoveredAt, "2026-08-22T09:00:00+08:00", "发现时间保留最早");
});

test("⑤ 累积合并：窗口外线索不被抹掉（原覆盖式写入的根因锁）", () => {
  // 台账里已有 3 家在册；今天窗口只抓到 1 家新递表的
  const prev = [
    projectFromUpstreamRow(
      row({ appId: "108804", submitDate: "2026-08-21" }),
      "2026-08-22T09:00:00+08:00",
    ),
    projectFromUpstreamRow(
      row({ appId: "108259", submitDate: "2026-03-13" }),
      "2026-03-14T09:00:00+08:00",
    ),
    projectFromUpstreamRow(
      row({ appId: "108290", submitDate: "2026-03-13" }),
      "2026-03-14T09:00:00+08:00",
    ),
  ];
  const today = projectFromUpstreamRow(
    row({ appId: "108870", submitDate: "2026-09-13" }),
    "2026-09-17T12:00:00+08:00",
  );
  const merged = mergeProjects(prev, [today]);
  assert.equal(merged.length, 4, "窗口外的 3 家必须保留（否则线上恒「1 家」）");
  assert.deepEqual(
    merged.map((p) => p.appId),
    ["108870", "108804", "108259", "108290"],
    "按递表日倒序（稳定排序，便于 diff）",
  );
});

test("⑥ 合并确定性：同一输入两次合并结果逐字节一致", () => {
  const prev = [projectFromUpstreamRow(row({ appId: "108804" }), "2026-08-22T09:00:00+08:00")];
  const next = [
    projectFromUpstreamRow(row({ appId: "108870" }), "2026-09-17T12:00:00+08:00"),
    projectFromUpstreamRow(row({ appId: "108259" }), "2026-09-17T12:00:00+08:00"),
  ];
  assert.equal(
    JSON.stringify(mergeProjects(prev, next)),
    JSON.stringify(mergeProjects(prev, next)),
  );
  // 空输入不炸
  assert.deepEqual(mergeProjects([], []), []);
});

test("⑦ VIE 枚举映射：是/否/缺省 → current/none/unverified", () => {
  assert.equal(vieOfFlag("是"), "current");
  assert.equal(vieOfFlag("否"), "none");
  assert.equal(vieOfFlag(""), "unverified");
  assert.equal(vieOfFlag(undefined), "unverified");
});

test("⑧ 🔴 红线：模型与产物都不得含招股书原文（往来银行行名）", () => {
  // 上游原文片段里含行名（实测样例），这些字段**根本不在** UpstreamListingRow 类型里。
  // 本断言用「序列化后扫描」把它钉死：即便有人给行对象塞了额外字段，也不能流进产物。
  const hostile = {
    ...row(),
    // 故意塞入不该存在的字段（模拟「顺手把原文带上」的写法）
    gdOpco: "主要往来银行｜中国银行广州番禺支行",
    vieEvidence: "Principal Banks China Merchants Bank Tower No. 7088 Shennan Boulevard",
  } as unknown as UpstreamListingRow;
  const p = projectFromUpstreamRow(hostile, "2026-09-17T12:00:00+08:00");
  const json = JSON.stringify(p);
  for (const w of ["银行", "銀行", "中国银行", "招商", "Principal Banks", "Merchants Bank"]) {
    assert.ok(!json.includes(w), `产物不得含「${w}」：${json}`);
  }
  // 台账级同样扫一遍
  const ledger = JSON.stringify(mergeProjects([], [p]));
  assert.ok(!ledger.includes("银行"), "台账序列化后不得含银行字样");
});
