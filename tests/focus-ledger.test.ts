/**
 * 经营重点台账 + 版本归档（二期 WP7）守护。
 *
 * 锁住四条口径：
 *  - 同日重跑**整天覆盖**，不追加（否则出现「同一天两份命中」的假增长）；
 *  - 多日累积、日期降序、不裁旧（年度重点的价值就在跨年观察节奏）；
 *  - `hits` 只记 M2/M3，M1 只进 `count`；必读/商机/风险落位按 url 标注；
 *  - 三态读取：文件不存在可写回，**坏 JSON 拒绝写回**（历史不得被静默清空）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFocusDay, annotateFocus } from "../lib/services/assemble/focus-metadata";
import {
  archiveFocusVersion,
  emptyFocusLedger,
  emptyVersionArchive,
  focusLedgerSummary,
  mergeFocusDay,
  MAX_FOCUS_VERSIONS,
} from "../lib/services/business-focus/ledger";
import {
  readFocusLedger,
  writeFocusLedger,
  readVersionArchive,
} from "../lib/adapters/business-focus/ledger-store";
import { recordFocusRun } from "../lib/pipeline/focus-context";
import type { FocusItem } from "../lib/services/business-focus/types";
import type { DailyReport, ReportItem } from "../lib/contracts/report";

function focus(over: Partial<FocusItem> = {}): FocusItem {
  return {
    id: "a26_aum",
    name: "AUM 规模与结构优化",
    description: "",
    layer: "annual",
    grade: "S",
    status: "active",
    priority: 1,
    highlight: true,
    start_date: "2026-01-01",
    end_date: "2026-12-31",
    domains: ["wealth_aum"],
    core_keywords: ["AUM"],
    keywords: [],
    synonyms: [],
    concepts: ["客户分层", "基金", "保险"],
    segments: [],
    products: [],
    exclude_keywords: ["金价"],
    source: "年度经营重点",
    description_for_ai: "",
    config_file: "config/annual-focus.json",
    ...over,
  };
}

function item(title: string, over: Partial<ReportItem> = {}): ReportItem {
  return {
    url: `https://e.com/${encodeURIComponent(title).slice(0, 14)}`,
    title_cn: title,
    source: "测试源",
    source_type: "media",
    date: "11/28",
    summary: "摘要。",
    importance: 2,
    rank: 1,
    tags: [],
    locale: "gz",
    primary_domain: "wealth_aum",
    ...over,
  };
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "focus-ledger-"));
}

test("① buildFocusDay：M2/M3 进 hits，M1 只进 count；必读/商机/风险按 url 标注", () => {
  const strong = item("AUM 规模突破千亿"); // 核心词 + 领域 → M3
  const weak = item("理财经理日常管理", { primary_domain: undefined }); // 无信号 → M0/M1
  const rep: DailyReport = {
    date: "2026-11-28",
    hero_line: "",
    must_read: [{ url: strong.url, title: strong.title_cn, why: "关注 AUM 结构" }],
    insights: [{ topic: "AUM 争夺", tags: [], impact: "中收改善", sources: [{ title: "源", url: strong.url }] }],
    sections: { gz_local: [strong, weak], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  };
  const day = buildFocusDay(rep, [focus()], "f-00000001", "2026-11-28");
  assert.ok(day);
  assert.equal(day.date, "2026-11-28");
  assert.equal(day.version, "f-00000001");
  assert.equal(day.hits.length, 1, "只有实质命中进 hits（弱条目即便 M1 也不占行）");
  const h = day.hits[0];
  assert.equal(h.focusId, "a26_aum");
  assert.equal(h.level, "M3");
  assert.equal(h.section, "gz_local");
  assert.equal(h.inMustRead, true, "同一条既是必读也命中了重点 → 标注落位");
  assert.equal(h.inInsights, true);
  assert.ok(h.itemId.startsWith("itm-"), "有 url 的条目必须有稳定 id");
  assert.ok(h.reason.length > 0, "命中理由要能回原文核对");
  // count 含 M1/M0 之外的相关条目（weak 若判 M1 会进 count）
  const cnt = day.focuses[0];
  assert.equal(cnt.high, 1);
  assert.ok(cnt.count >= cnt.high);
});

test("② 无命中条目不进 hits；无 url 的条目 itemId 留空串（不得用 itm-0 撞成一个 id）", () => {
  const a = item("AUM 规模突破千亿", { url: "" });
  const rep: DailyReport = {
    date: "2026-11-28",
    hero_line: "",
    must_read: [{ url: "", title: a.title_cn, why: "无来源" }],
    insights: [],
    sections: { gz_local: [a], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  };
  const day = buildFocusDay(rep, [focus()], "f-00000001", "2026-11-28");
  assert.equal(day?.hits.length, 1);
  assert.equal(day?.hits[0].itemId, "", "无 url 时留空，不用 itm-0");
  assert.equal(day?.hits[0].inMustRead, true, "必读无 url 时按标题逐字兜底匹配");
});

test("③ 无生效重点 → 不产出台账（不留空壳天，避免「当日 0 命中」的假信号）", () => {
  const rep: DailyReport = {
    date: "2026-11-28",
    hero_line: "",
    must_read: [],
    insights: [],
    sections: { gz_local: [item("AUM 规模突破千亿")], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  };
  assert.equal(buildFocusDay(rep, [], "f-00000001", "2026-11-28"), undefined);
});

test("④ 同日重跑整天覆盖、多日累积、日期降序（不裁旧）", () => {
  const day1 = { date: "2026-11-27", version: "f-a", focuses: [], hits: [{ focusId: "a26_aum" } as never] };
  const day1b = { date: "2026-11-27", version: "f-b", focuses: [], hits: [] };
  const day2 = { date: "2026-11-28", version: "f-b", focuses: [], hits: [{ focusId: "a26_aum" } as never] };

  let l = mergeFocusDay(emptyFocusLedger(), day1);
  assert.equal(l.days.length, 1);
  l = mergeFocusDay(l, day2);
  assert.equal(l.days.length, 2);
  assert.deepEqual(l.days.map((d) => d.date), ["2026-11-28", "2026-11-27"], "日期降序");
  l = mergeFocusDay(l, day1b);
  assert.equal(l.days.length, 2, "同日重跑替换整天，不追加");
  assert.equal(l.days.find((d) => d.date === "2026-11-27")?.version, "f-b", "版本也一起替换");
  assert.equal(l.updatedAt, "2026-11-28");
  assert.deepEqual(focusLedgerSummary(l), { days: 2, hits: 1, latest: "2026-11-28" });
});

test("⑤ 版本归档：同版本只更新 lastSeen（定义以首见为准）、可多版本并存、只增不减", () => {
  const f1 = [focus()];
  let a = emptyVersionArchive();
  a = archiveFocusVersion(a, { version: "f-a", date: "2026-11-27", focuses: f1 });
  assert.equal(a.versions.length, 1);
  assert.equal(a.versions[0].firstSeen, "2026-11-27");
  assert.equal(a.versions[0].lastSeen, "2026-11-27");
  assert.equal(a.versions[0].focuses[0].core_keywords[0], "AUM", "归档存的是定义，不是版本号");

  a = archiveFocusVersion(a, { version: "f-a", date: "2026-11-28", focuses: f1 });
  assert.equal(a.versions.length, 1, "同版本不重复归档");
  assert.equal(a.versions[0].lastSeen, "2026-11-28");

  a = archiveFocusVersion(a, { version: "f-a", date: "2026-11-20", focuses: f1 });
  assert.equal(a.versions[0].firstSeen, "2026-11-20", "补跑更早批次可前移 firstSeen");
  assert.equal(a.versions[0].lastSeen, "2026-11-28", "lastSeen 不因补跑往回拨");

  a = archiveFocusVersion(a, { version: "f-b", date: "2026-11-29", focuses: [focus({ name: "改名后" })] });
  assert.equal(a.versions.length, 2);
  assert.equal(a.versions[0].focuses[0].name, "AUM 规模与结构优化", "旧版本定义不随改名回溯");
  assert.equal(a.versions[1].focuses[0].name, "改名后");
});

test("⑥ 版本归档有上限（配置改得再勤也不无限增长）", () => {
  let a = emptyVersionArchive();
  for (let i = 0; i < MAX_FOCUS_VERSIONS + 5; i++) {
    a = archiveFocusVersion(a, { version: `f-${i}`, date: "2026-11-28", focuses: [] });
  }
  assert.equal(a.versions.length, MAX_FOCUS_VERSIONS);
  assert.equal(a.versions[a.versions.length - 1].version, `f-${MAX_FOCUS_VERSIONS + 4}`, "保留最新的");
});

test("⑦ 三态读取：缺文件=missing 可写回；坏 JSON=corrupt 且拒绝写回（历史不得被静默清空）", () => {
  const dir = tmpdir();
  const file = path.join(dir, "focus-ledger.json");

  const missing = readFocusLedger(file);
  assert.equal(missing.state, "missing");
  assert.deepEqual(missing.data.days, []);

  const day = { date: "2026-11-28", version: "f-a", focuses: [], hits: [{ focusId: "a26_aum" } as never] };
  writeFocusLedger(mergeFocusDay(missing.data, day), file);
  const ok = readFocusLedger(file);
  assert.equal(ok.state, "ok");
  assert.equal(ok.data.days.length, 1);

  fs.writeFileSync(file, '{"days": [', "utf8"); // 半写截断
  const bad = readFocusLedger(file);
  assert.equal(bad.state, "corrupt");
  assert.match(bad.error ?? "", /focus-ledger\.json/);
  // 调用方（recordFocusRun）遇 corrupt 直接 return，不写回 —— 这里断言原文件未被改动
  assert.equal(fs.readFileSync(file, "utf8"), '{"days": [');
});

test("⑧ 版本归档结构不完整也判 corrupt（半写截断常表现为字段缺失）", () => {
  const dir = tmpdir();
  const file = path.join(dir, "versions.json");
  fs.writeFileSync(file, '{"version":1,"updatedAt":"2026-11-28"}', "utf8");
  const r = readVersionArchive(file);
  assert.equal(r.state, "corrupt");
});

test("⑨ 打标与台账同源：report.focus 的计数与台账 focuses 逐条相等（同一批资讯不得两套口径）", () => {
  const rep: DailyReport = {
    date: "2026-11-28",
    hero_line: "",
    must_read: [],
    insights: [],
    sections: {
      gz_local: [item("AUM 规模突破千亿"), item("私行客户分层升级")],
      biz_insight: [],
      policy_market: [],
      tech: [],
      ipo: [],
    },
  };
  const focuses = [focus(), focus({ id: "a26_pb", name: "高端客群经营", core_keywords: ["私行"] })];
  const tagged = annotateFocus(rep, focuses, "f-a");
  const day = buildFocusDay(tagged, focuses, "f-a", "2026-11-28");
  assert.ok(day && tagged.focus);
  assert.deepEqual(
    day.focuses.map((f) => [f.id, f.count, f.high]),
    tagged.focus.items.map((f) => [f.id, f.count, f.high]),
  );
});

test("⑩ recordFocusRun：写台账 + 归档版本；同日重跑不重复、跨日累积", () => {
  const dir = tmpdir();
  const files = { ledger: path.join(dir, "ledger.json"), versions: path.join(dir, "versions.json") };
  const rep: DailyReport = {
    date: "2026-11-28",
    hero_line: "",
    must_read: [],
    insights: [],
    sections: { gz_local: [item("AUM 规模突破千亿")], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  };
  recordFocusRun(rep, [focus()], "f-00000001", undefined, files);
  assert.ok(fs.existsSync(files.ledger) && fs.existsSync(files.versions), "两份文件都落盘");
  const l1 = readFocusLedger(files.ledger);
  assert.equal(l1.state, "ok");
  assert.equal(l1.data.days.length, 1);
  assert.equal(l1.data.days[0].hits.length, 1, "命中明细落盘");

  // 同日重跑：仍是 1 天 1 条（不追加）
  recordFocusRun(rep, [focus()], "f-00000001", undefined, files);
  const l2 = readFocusLedger(files.ledger);
  assert.equal(l2.data.days.length, 1);
  assert.equal(l2.data.days[0].hits.length, 1);

  // 次日：累积成 2 天；版本归档仍 1 版（同版本）
  recordFocusRun({ ...rep, date: "2026-11-29" }, [focus()], "f-00000001", undefined, files);
  const l3 = readFocusLedger(files.ledger);
  assert.equal(l3.data.days.length, 2);
  const v3 = readVersionArchive(files.versions);
  assert.equal(v3.data.versions.length, 1);
  assert.equal(v3.data.versions[0].firstSeen, "2026-11-28");
  assert.equal(v3.data.versions[0].lastSeen, "2026-11-29");
});

test("⑪ recordFocusRun：台账损坏时拒绝写回（历史原样保留），无重点时一个文件都不建", () => {
  const dir = tmpdir();
  const files = { ledger: path.join(dir, "ledger.json"), versions: path.join(dir, "versions.json") };
  fs.writeFileSync(files.ledger, '{"days": ', "utf8");
  const rep: DailyReport = {
    date: "2026-11-28",
    hero_line: "",
    must_read: [],
    insights: [],
    sections: { gz_local: [item("AUM 规模突破千亿")], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  };
  recordFocusRun(rep, [focus()], "f-00000001", undefined, files);
  assert.equal(fs.readFileSync(files.ledger, "utf8"), '{"days": ', "坏文件不得被空台账覆盖");

  const dir2 = tmpdir();
  const files2 = { ledger: path.join(dir2, "ledger.json"), versions: path.join(dir2, "versions.json") };
  recordFocusRun(rep, [], "", undefined, files2);
  assert.ok(!fs.existsSync(files2.ledger) && !fs.existsSync(files2.versions), "引擎关/无配置 → 不留空壳天");
});
