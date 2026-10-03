/**
 * 红筹呈现「来源 / 新鲜度 / 降级」守护（2026-10-03）。
 *
 * 背景（实测）：报告面板的「数据截至」只来自 `data/redchip/latest.json`，
 * 而它被 `.gitignore` 拦住 → CI 侧 8 期报告该字段全空，「数字与日期对不上」。
 *
 * 本文件把修复后的四条口径钉死：
 *   ① `capturedAt` 解析链（meta → latest → 台账派生）；
 *   ② 台账派生时的**措辞降级**（「台账更新至」≠「数据截至」）；
 *   ③ 窗口判据必须认 `lastChangedAt`（否则「8 月递表、今天受理」永远出窗）；
 *   ④ 缺失 / 过期 / 源失败**必须显式说明**，不得静默。
 *
 * 纯函数 + 临时目录，不发起网络请求。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RedchipLead } from "../lib/contracts/redchip";
import { inRedchipListWindow, leadWindowKeys } from "../lib/services/classify/redchip";
import { latestLeadAt, ledgerMarketCounts, mergeLeadSets } from "../lib/services/redchip/leads";
import { redchipFreshnessNote } from "../lib/services/redchip/provenance";
import { setRedchipBaseDir } from "../lib/adapters/redchip/snapshot-store";
import {
  buildRedchipPanel,
  resolveRedchipCaptured,
} from "../lib/pipeline/side-outputs/side-redchip";
import { renderRedchipPanel } from "../lib/services/render/redchip-panel";

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

const TODAY = "2026-10-03";

/** 临时目录隔离（适配器 `setRedchipBaseDir` 覆盖仓库根）。 */
function withTmpDir(fn: (dir: string) => void): void {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "redchip-meta-"));
  try {
    setRedchipBaseDir(root);
    fn(root);
  } finally {
    setRedchipBaseDir(undefined);
    fsSync.rmSync(root, { recursive: true, force: true });
  }
}

test("① latestLeadAt：取 lastChangedAt / discoveredAt 的最大值（不拿抓取时刻兜底）", () => {
  assert.equal(
    latestLeadAt([
      lead({ discoveredAt: "2026-08-20T08:00:00+08:00" }),
      lead({ leadId: "b", appId: "b", discoveredAt: "2026-09-01T08:00:00+08:00", lastChangedAt: "2026-10-03T06:38:05+08:00" }),
      lead({ leadId: "c", appId: "c", discoveredAt: "2026-09-10T08:00:00+08:00" }),
    ]),
    "2026-10-03T06:38:05+08:00",
  );
  assert.equal(latestLeadAt([]), undefined, "无线索 → undefined（呈现层须说「无时间戳」，不得编造）");
});

test("② ledgerMarketCounts：只统计可展示线索，`market` 缺省视为 hk（与 ledgerCount 同口径）", () => {
  const counts = ledgerMarketCounts([
    lead(),
    lead({ leadId: "b", appId: "b" }),
    lead({ leadId: "c", appId: "c", market: "us" }),
    lead({ leadId: "d", appId: "d", verdict: "non-redchip" }), // 不打标 → 不计数
  ]);
  assert.deepEqual(counts, { hk: 2, us: 1 }, "non-redchip 进不了『在册』，否则两个数字对不上");
});

test("③ 窗口判据必须认 lastChangedAt（8 月递表、10 月被受理 → 仍在窗内）", () => {
  const moved = lead({ submitDate: "2026-08-21", lastChangedAt: "2026-10-03T06:38:05+08:00" });
  assert.deepEqual(leadWindowKeys(moved).sort(), ["2026-08-21", "2026-10-03"]);
  assert.ok(inRedchipListWindow(moved, TODAY), "只有递表日 → 恒出窗（这正是线上「动向恒空」的根因）");

  const stale = lead({ submitDate: "2026-08-21" });
  assert.deepEqual(leadWindowKeys(stale), ["2026-08-21"]);
  assert.equal(inRedchipListWindow(stale, TODAY), false, "无变更记录 + 递表日出窗 → 不进动向列表");

  const noDate = lead({ submitDate: undefined, discoveredAt: "", lastChangedAt: undefined });
  assert.deepEqual(leadWindowKeys(noDate), []);
  assert.equal(inRedchipListWindow(noDate, TODAY), false, "无任何日期 → 不进窗口（时间红线）");
});

test("④ 新鲜度口径：正常 → 无提示；过期 / 源失败 / 无时间戳 → 必须显式说明", () => {
  assert.equal(
    redchipFreshnessNote({ capturedAt: "2026-10-03T06:38:05+08:00", today: TODAY }),
    undefined,
    "当天数据不打扰读者",
  );
  assert.match(
    redchipFreshnessNote({ capturedAt: "2026-09-17T12:41:00+08:00", today: TODAY }) ?? "",
    /已 16 天未更新/,
  );
  assert.match(
    redchipFreshnessNote({ capturedAt: "2026-10-03T06:38:05+08:00", today: TODAY, failedSources: ["us"] }) ?? "",
    /本期未取到美股数据/,
  );
  assert.match(
    redchipFreshnessNote({ today: TODAY }) ?? "",
    /未取得红筹数据时间戳/,
    "拿不到时间就如实说拿不到，不编造",
  );
});

test("⑤ capturedAt 解析链：meta（入库）优先 → latest → 台账派生（措辞降级）", () => {
  // ① 三者都在 → 取**较新**的抓取时刻，来源标记 snapshot
  withTmpDir((root) => {
    fsSync.mkdirSync(path.join(root, "data/redchip"), { recursive: true });
    fsSync.writeFileSync(
      path.join(root, "data/redchip/meta.json"),
      JSON.stringify({
        updatedAt: "2026-10-03T06:38:05+08:00",
        sources: { hk: { capturedAt: "2026-10-03T06:38:05+08:00", ok: true, scanned: 120, redchip: 2 } },
      }),
    );
    fsSync.writeFileSync(
      path.join(root, "data/redchip/latest.json"),
      JSON.stringify({ capturedAt: "2026-09-17T12:41:00+08:00", count: 1, projects: [] }),
    );
    const r = resolveRedchipCaptured([lead()]);
    assert.equal(r.capturedAt, "2026-10-03T06:38:05+08:00");
    assert.equal(r.capturedSource, "snapshot");
  });

  // ② 只有 latest（本地工作区形态）→ 仍算 snapshot
  withTmpDir((root) => {
    fsSync.mkdirSync(path.join(root, "data/redchip"), { recursive: true });
    fsSync.writeFileSync(
      path.join(root, "data/redchip/latest.json"),
      JSON.stringify({ capturedAt: "2026-09-17T12:41:00+08:00", count: 1, projects: [] }),
    );
    const r = resolveRedchipCaptured([lead()]);
    assert.equal(r.capturedAt, "2026-09-17T12:41:00+08:00");
    assert.equal(r.capturedSource, "snapshot");
  });

  // ②b 🔴 回归守卫：本地残留的**旧** latest.json 不得盖住台账里更新的记录
  //    （用户最初报的症状：面板「数据截至 2026-09-17」而台账明明有 10-03 的变更）
  withTmpDir((root) => {
    fsSync.mkdirSync(path.join(root, "data/redchip"), { recursive: true });
    fsSync.writeFileSync(
      path.join(root, "data/redchip/latest.json"),
      JSON.stringify({ capturedAt: "2026-09-17T12:41:41+08:00", count: 1, projects: [] }),
    );
    const r = resolveRedchipCaptured([lead({ lastChangedAt: "2026-10-03T06:38:05+08:00" })]);
    assert.equal(r.capturedAt, "2026-10-03T06:38:05+08:00", "只要有更晚的证据，就必须呈现更晚的日期");
    assert.equal(r.capturedSource, "ledger", "此刻的措辞须降级为「台账更新至」");
  });

  // ③ CI 形态：latest / meta 都不在（.gitignore 拦住 meta 之外的运行时产物）→ 台账派生
  withTmpDir(() => {
    const r = resolveRedchipCaptured([lead({ lastChangedAt: "2026-10-03T06:38:05+08:00" })]);
    assert.equal(r.capturedAt, "2026-10-03T06:38:05+08:00");
    assert.equal(r.capturedSource, "ledger", "台账派生必须与「抓取时刻」区分开");
  });

  // ④ 什么都拿不到 → 不编造
  withTmpDir(() => {
    const r = resolveRedchipCaptured([lead({ discoveredAt: "" })]);
    assert.equal(r.capturedAt, undefined);
    assert.equal(r.capturedSource, undefined);
  });

  // ⑤ 源失败要冒泡到 failedSources
  withTmpDir((root) => {
    fsSync.mkdirSync(path.join(root, "data/redchip"), { recursive: true });
    fsSync.writeFileSync(
      path.join(root, "data/redchip/meta.json"),
      JSON.stringify({
        updatedAt: "2026-10-03T06:38:05+08:00",
        sources: {
          hk: { capturedAt: "2026-10-03T06:38:05+08:00", ok: true, scanned: 120, redchip: 2 },
          us: { capturedAt: "2026-10-02T06:00:00+08:00", ok: false, scanned: 0, redchip: 0 },
        },
      }),
    );
    assert.deepEqual(resolveRedchipCaptured([lead()]).failedSources, ["us"]);
  });
});

test("⑥ 面板 provenance：在册 / 数据时刻 / 市场分布 / 降级一次齐备", () => {
  const panel = buildRedchipPanel(
    {
      leads: [lead({ submitDate: "2026-08-21", lastChangedAt: "2026-10-03T06:38:05+08:00" })],
      changes: [],
      reports: new Map(),
      today: TODAY,
      capturedAt: "2026-09-17T12:41:00+08:00",
      capturedSource: "ledger",
      failedSources: ["us"],
    },
    new Set(),
  );
  assert.equal(panel.ledgerCount, 1);
  assert.equal(panel.lastChangedAt, "2026-10-03T06:38:05+08:00");
  assert.deepEqual(panel.ledgerByMarket, { hk: 1 });
  assert.equal(panel.capturedSource, "ledger");
  assert.match(panel.freshnessNote ?? "", /已 16 天未更新/);
  assert.match(panel.freshnessNote ?? "", /本期未取到美股数据/);
  assert.equal(panel.entries.length, 1, "认 lastChangedAt 后，8 月递表的在册线索也能作为「本期动向」露出");
  assert.equal(panel.entries[0].changedAt, "2026-10-03T06:38:05+08:00");
});

test("⑦ 渲染措辞：ledger 派生写「台账更新至」，snapshot 写「数据截至」（不得混用）", () => {
  const base = { entries: [], ledgerCount: 3, ledgerByMarket: { hk: 3 } };
  const derived = renderRedchipPanel({
    ...base,
    capturedAt: "2026-10-03T06:38:05+08:00",
    capturedSource: "ledger",
    freshnessNote: "⚠️ 本期未取到美股数据",
  });
  assert.match(derived, /台账更新至 2026-10-03 06:38/);
  assert.ok(!derived.includes("数据截至"), "台账派生不得冒充抓取时刻");
  assert.match(derived, /近 7 日动向 0 家/);
  assert.match(derived, /来源：港股 3 家/);
  assert.match(derived, /redchip-fresh/);
  assert.match(derived, /累计/, "在册数须点明是累计口径");

  const snap = renderRedchipPanel({
    ...base,
    capturedAt: "2026-10-03T06:38:05+08:00",
    capturedSource: "snapshot",
  });
  assert.match(snap, /数据截至 2026-10-03 06:38/);

  const unknown = renderRedchipPanel({ ...base });
  assert.match(unknown, /无数据时间戳/, "拿不到时间也不能静默");
});

// ---------- 2026-10-03：台账 schema 归一 + 按 appId 逐条合并 ----------

test("⑧ mergeLeadSets：并集不丢条目 + 同 appId 取新者 + 字段互补 + discoveredAt 取最早", () => {
  // 线下爬虫那一份（较新：10-03 提交，但字段较少 —— 现实里新脚本常只写自己关心的字段）
  const crawler = [
    lead({
      leadId: "A",
      appId: "A",
      status: "已受理",
      domicile: undefined,
      discoveredAt: "2026-10-03T06:34:10+08:00",
      lastChangedAt: "2026-10-03T06:34:10+08:00",
    }),
    lead({ leadId: "C", appId: "C", submitDate: "2026-10-01" }),
  ];
  // CI 那一份（较旧：保留了 domicile 与更早的 discoveredAt）
  const ci = [
    lead({ leadId: "A", appId: "A", status: "处理中", domicile: "开曼群岛", discoveredAt: "2026-09-15T08:00:00+08:00" }),
    lead({ leadId: "B", appId: "B", submitDate: "2026-09-30" }),
  ];

  const merged = mergeLeadSets([crawler, ci]);
  assert.equal(merged.length, 3, "并集：三边新增都不得丢");
  const a = merged.find((l) => l.appId === "A")!;
  assert.equal(a.status, "已受理", "同 appId 取新者（lastChangedAt 更晚）");
  assert.equal(a.domicile, "开曼群岛", "新者缺的字段用旧者补 —— 否则新脚本会抹掉信息");
  assert.equal(a.discoveredAt, "2026-09-15T08:00:00+08:00", "discoveredAt 是台账属性，取最早");
  assert.deepEqual(
    merged.map((l) => l.appId).slice(0, 2),
    ["C", "B"],
    "排序须稳定：递表日倒序",
  );
});

test("⑨ mergeLeadSets：单份输入也归一 `market`（这就是「统一 schema」的落地）", () => {
  const merged = mergeLeadSets([[lead({ market: undefined }), lead({ leadId: "b", appId: "b", market: "us" })]]);
  assert.deepEqual(merged.map((l) => l.market).sort(), ["hk", "us"], "缺省 hk，已显式写出的保持原值");
});

test("⑩ 面板：近窗内「非红筹但广东相关」进 gdAdjacent（不进 entries / 不打徽章）", () => {
  const panel = buildRedchipPanel(
    {
      leads: [
        // 红筹：isOffshore ∧ 广东达标 —— 应进 entries，不进 gdAdjacent
        lead({ leadId: "R", appId: "R", submitDate: "2026-10-01" }),
        // 广东达标但境内注册 → 非红筹（判定未过离岸）→ 进 gdAdjacent
        lead({
          leadId: "G",
          appId: "G",
          verdict: "non-redchip",
          isOffshore: false,
          domicile: "中国(境内)",
          gdCityHits: 9,
          isGdConnected: true,
          submitDate: "2026-10-02",
        }),
        // 广东**不**达标（词频 <3）→ 不算广东相关 → 两边都不进
        lead({
          leadId: "N",
          appId: "N",
          verdict: "non-redchip",
          isOffshore: false,
          domicile: "中国(境内)",
          gdCityHits: 1,
          isGdConnected: false,
          submitDate: "2026-10-02",
        }),
        // 广东达标但已出窗（递表 08-21、无变更）→ 两边都不进
        lead({
          leadId: "O",
          appId: "O",
          verdict: "non-redchip",
          isOffshore: false,
          domicile: "中国(境内)",
          gdCityHits: 7,
          isGdConnected: true,
          submitDate: "2026-08-21",
        }),
      ],
      changes: [],
      reports: new Map(),
      today: TODAY,
      capturedAt: "2026-10-03T06:00:00+08:00",
    },
    new Set(),
  );

  assert.deepEqual(panel.entries.map((e) => e.leadId), ["R"], "非红筹不得进红筹列表");
  assert.deepEqual(panel.gdAdjacent?.map((g) => g.leadId), ["G"], "只有「非红筹 ∧ 广东实体语境达标 ∧ 在窗内」三条同时成立者");
  assert.equal(panel.gdAdjacent?.[0].domicile, "中国(境内)", "须写清它们为何不是红筹");
  assert.equal(panel.gdAdjacent?.[0].gdCityHits, 9);
});

test("⑪ 渲染：广东相关申请以折叠清单呈现，且明确「不参与卡片与口播」", () => {
  const html = renderRedchipPanel({
    entries: [],
    ledgerCount: 38,
    ledgerByMarket: { hk: 38 },
    gdAdjacent: [
      {
        leadId: "G",
        nameCn: "某广东科技股份有限公司",
        nameEn: "Gd Tech Co., Ltd.",
        submitDate: "2026-10-02",
        domicile: "中国(境内)",
        gdCityHits: 9,
        sourceUrl: "https://example.com/a.pdf",
      },
    ],
  });
  assert.match(html, /redchip-adjacent/);
  assert.match(html, /另有 1 家近 7 日新增的<b>广东相关申请<\/b>/);
  assert.match(html, /某广东科技股份有限公司/);
  assert.match(html, /注册地 中国\(境内\)/);
  assert.match(html, /不参与卡片与口播/);
  assert.ok(!html.includes("redchip-list"), "只有广东相关申请时，不得渲染空的红筹列表");

  // 只有它、连台账都没有 → 仍须渲染（否则爬虫这部分工作完全不可见）
  const only = renderRedchipPanel({
    entries: [],
    gdAdjacent: [{ leadId: "G", nameCn: "某广东科技", nameEn: "", gdCityHits: 5 }],
  });
  assert.match(only, /redchip-adjacent/);
});
