/**
 * 红筹旁路加锁测试（plan-redchip-crawl-push §5.1 / T2·T5·T6·T7）。
 * 纯函数 + 临时目录（报告探测），不发起网络请求。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import { changesByLead, lastChangedAtMap, toLeads } from "../lib/services/redchip/leads";
import { resolveReports } from "../lib/adapters/redchip/report-resolver";
import { applyRedchip, buildRedchip, buildRedchipPanel } from "../lib/pipeline/side-outputs/side-redchip";
import type { DailyReport, ReportItem } from "../lib/contracts/report";
import type { RedchipChange, RedchipLead } from "../lib/contracts/redchip";
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

/** 真实形态的港交所 IPO 条目（url 自带申请编号）。 */
function hkItem(appId: string, over: Partial<ReportItem> = {}): ReportItem {
  const url = `https://www1.hkexnews.hk/app/sehk/2026/${appId}/2026091300120_c.htm`;
  return {
    url,
    title_cn: "深圳市海柔創新智能科技集團股份有限公司 - W（主板递表·广东企业）",
    source: "港交所",
    source_type: "official",
    date: "09/13",
    summary: "…",
    importance: 2,
    rank: 1,
    tags: ["粤"],
    locale: "national",
    officialUrl: url,
    ipoStage: "stage-reviewing",
    ...over,
  };
}

function report(items: ReportItem[]): DailyReport {
  return {
    date: "2026-09-15",
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: items },
  };
}

const TODAY = "2026-09-15";

test("① 线索归并：leadId / lastChangedAt（取最大 at）/ 报告引用", () => {
  const changes: RedchipChange[] = [
    { at: "2026-09-14T08:00:00+08:00", type: "added", appId: "108870" },
    { at: "2026-09-15T08:00:00+08:00", type: "changed", appId: "108870", field: "状态", from: "a", to: "b" },
    { at: "2026-09-16T08:00:00+08:00", type: "changed", appId: "108870", field: "注册地", from: "c", to: "d" },
    { at: "2026-09-15T09:00:00+08:00", type: "added", appId: "999999" },
  ];
  assert.equal(lastChangedAtMap(changes).get("108870"), "2026-09-16T08:00:00+08:00");
  assert.equal(lastChangedAtMap(changes).get("999999"), "2026-09-15T09:00:00+08:00");
  assert.deepEqual(
    changesByLead(changes).get("108870")?.map((c) => c.field ?? c.type),
    ["added", "状态", "注册地"],
    "时间线应按时间正序",
  );

  const reports = new Map([
    ["108870", [{ kind: "deep" as const, url: "redchip/deep/108870.html", title: "t", generatedAt: "2026-09-15T08:00:00+08:00" }]],
  ]);
  const leads = toLeads([{ ...lead() }], changes, reports);
  assert.equal(leads[0].leadId, "108870");
  assert.equal(leads[0].lastChangedAt, "2026-09-16T08:00:00+08:00");
  assert.equal(leads[0].reports?.[0].kind, "deep");
  assert.equal(leads[0].verdict, "redchip", "判定字段原样透传");
});

test("② 报告探测：manual > deep > r 优先级，且只报告真实存在的文件", () => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "redchip-site-"));
  try {
    const mk = (dir: string, id: string) => {
      fsSync.mkdirSync(path.join(root, "redchip", dir), { recursive: true });
      fsSync.writeFileSync(path.join(root, "redchip", dir, `${id}.html`), "<html></html>");
    };
    mk("r", "108870");
    mk("deep", "108870");
    mk("manual", "108867");

    const refs = resolveReports(["108870", "108867", "999999"], { siteRoot: root });
    assert.deepEqual(refs.get("108870")?.map((r) => r.kind), ["deep", "pre-meeting"]);
    assert.deepEqual(refs.get("108867")?.map((r) => r.kind), ["manual"]);
    assert.equal(refs.get("999999"), undefined, "无文件 → 不出现在 map 里");

    // 目录穿越防护
    assert.equal(resolveReports(["../etc/passwd"], { siteRoot: root }).size, 0);
  } finally {
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});

test("③ T2：匹配到条目 → 挂徽章（含报告入口与按钮文案）", () => {
  const out = applyRedchip(report([hkItem("108870")]), {
    leads: [lead()],
    changes: [],
    reports: new Map(),
    today: TODAY,
  });
  const it = out.report.sections.ipo[0];
  assert.ok(it.redchip, "应挂徽章");
  assert.equal(it.redchip.label, "红筹线索");
  assert.equal(it.redchip.reportUrl, "redchip/r/108870.html", "缺 depth/manual 时回落确定性会前版路径");
  assert.equal(it.redchip.reportKind, "pre-meeting");
  assert.deepEqual([...out.matchedIds], ["108870"]);
});

test("④ T6：存在深度版 → 卡片入口指向深度版（覆盖会前版本）", () => {
  const reports = new Map([
    ["108870", [{ kind: "deep" as const, url: "redchip/deep/108870.html", title: "t", generatedAt: "x" }]],
  ]);
  const out = applyRedchip(report([hkItem("108870")]), {
    leads: [lead()],
    changes: [],
    reports,
    today: TODAY,
  });
  assert.equal(out.report.sections.ipo[0].redchip?.reportUrl, "redchip/deep/108870.html");
  assert.equal(out.report.sections.ipo[0].redchip?.reportKind, "deep");
});

test("⑤ T7：匹配失败 → 条目不打标，但线索仍进面板（matched=false）", () => {
  const unrelated = lead({
    leadId: "555555",
    appId: "555555",
    nameCn: "某境外控股有限公司",
    nameEn: "Some Offshore Holdings Limited",
    submitDate: "2026-09-14",
  });
  const out = buildRedchip(report([hkItem("108870")]), {
    leads: [unrelated],
    changes: [],
    reports: new Map(),
    today: TODAY,
  });
  assert.equal(out.sections.ipo[0].redchip, undefined, "无状态源红线：编号与名称都对不上就不打标");
  assert.equal(out.redchipPanel?.entries.length, 1, "线索不得静默消失");
  assert.equal(out.redchipPanel?.entries[0].matched, false);
});

test("⑤b 兜底生效：编号不同但企业名相同 → 仍算匹配（证明企业名兜底可用）", () => {
  const sameName = lead({ leadId: "555555", appId: "555555" });
  const out = applyRedchip(report([hkItem("108870")]), {
    leads: [sameName],
    changes: [],
    reports: new Map(),
    today: TODAY,
  });
  assert.ok(out.report.sections.ipo[0].redchip, "同名企业应经归一化企业名兜底命中");
  assert.deepEqual([...out.matchedIds], ["555555"]);
});

test("⑥ 面板：窗口过滤（日差 ≤ 7）+ 判定档过滤 + 递表日倒序", () => {
  const inputs = {
    leads: [
      lead({ leadId: "A", appId: "A", submitDate: "2026-09-14" }),
      lead({ leadId: "B", appId: "B", submitDate: "2026-09-13" }),
      lead({ leadId: "C", appId: "C", submitDate: "2026-09-01" }), // 日差 14 → 出窗
      lead({ leadId: "D", appId: "D", verdict: "non-redchip" }), // 不打标
    ],
    changes: [] as RedchipChange[],
    reports: new Map(),
    today: TODAY,
    capturedAt: "2026-09-15T08:00:00+08:00",
  };
  const panel = buildRedchipPanel(inputs, new Set(["A"]));
  assert.deepEqual(panel.entries.map((e) => e.leadId), ["A", "B"], "倒序 + 出窗/不打标者被排除");
  assert.equal(panel.capturedAt, "2026-09-15T08:00:00+08:00");
  assert.equal(panel.entries[0].matched, true);
});

test("⑦ 降级：无线索 / 无 IPO 条目 → 原样返回（不产空面板、不报错）", () => {
  const r = report([hkItem("108870")]);
  const noLeads = buildRedchip(r, { leads: [], changes: [], reports: new Map(), today: TODAY });
  assert.equal(noLeads, r, "无线索 → 同一对象返回");

  const emptyIpo = buildRedchip(report([]), {
    leads: [lead()],
    changes: [],
    reports: new Map(),
    today: TODAY,
  });
  assert.equal(emptyIpo.redchipPanel?.entries.length, 1, "无 IPO 条目时线索仍应进面板可见");
});

test("⑧ added/changed 标记透传到徽章与面板", () => {
  const changes: RedchipChange[] = [
    { at: "2026-09-15T08:00:00+08:00", type: "added", appId: "108870" },
    { at: "2026-09-15T08:00:00+08:00", type: "changed", appId: "108870", field: "状态", from: "处理中", to: "已受理" },
  ];
  const out = buildRedchip(report([hkItem("108870")]), {
    leads: [lead()],
    changes,
    reports: new Map(),
    today: TODAY,
  });
  assert.equal(out.sections.ipo[0].redchip?.isNew, true);
  assert.deepEqual(out.sections.ipo[0].redchip?.changedFields, ["状态"]);
  assert.equal(out.redchipPanel?.entries[0].isNew, true);
  assert.deepEqual(out.redchipPanel?.entries[0].changedFields, ["状态"]);
});

test("⑨ 台账入口：窗口内无动向时，面板转为「安静态」但必须给出台账计数与入口", () => {
  // 回填基线后的真实形态：台账有在册线索，但都不在 7 天展示窗口内。
  // 此时若整块消失，读者会把「近期无新动向」误读成「没有红筹商机」。
  const archived = lead({
    leadId: "108804",
    appId: "108804",
    nameCn: "錢大媽國際控股有限公司",
    submitDate: "2026-08-21",
  });
  const out = buildRedchip(report([]), {
    leads: [archived],
    changes: [],
    reports: new Map(),
    today: TODAY,
  });
  assert.equal(out.redchipPanel?.entries.length, 0, "窗口外线索不进列表（避免每天重复罗列）");
  assert.equal(out.redchipPanel?.ledgerCount, 1, "台账总数必须给出，否则等于「静默消失」");

  const html = renderRedchipPanel(out.redchipPanel);
  assert.ok(html.includes("redchip-ledger"), "安静态须渲染台账入口");
  assert.ok(html.includes("红筹商机台账"), "入口文案须点明是台账");
  assert.ok(html.includes("../redchip/index.html"), "入口须指向站点红筹总览页");
  assert.ok(!html.includes("redchip-list"), "安静态不得渲染空列表");
  assert.ok(html.includes("非结论"), "红线文案（线索 ≠ 结论）不得丢");
});

test("⑩ 台账为空 → 不渲染任何红筹区块（与「空板块自动隐藏」口径一致）", () => {
  const out = buildRedchip(report([]), {
    leads: [],
    changes: [],
    reports: new Map(),
    today: TODAY,
  });
  assert.equal(out.redchipPanel, undefined, "无线索时不写字段");
  assert.equal(renderRedchipPanel(undefined), "");
  assert.equal(renderRedchipPanel({ entries: [] }), "");
  assert.equal(renderRedchipPanel({ entries: [], ledgerCount: 0 }), "");
});
