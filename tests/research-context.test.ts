/**
 * 研报台账写入点单测（2026-11-28 从 side-research 挪到 pipeline/research-context）。
 *
 * 本轮要守的只有一件事：**谁能写这个文件**。
 *  - 只有装配层（scripts/daily.ts）会调 recordResearchRun → e2e / replay 跑管线不再落盘；
 *  - 写入本身仍保留 10-19 的三条加固：corrupt 拒写回、空输入不写壳、失败不抛错。
 *
 * 路径一律注入临时文件：`data/research-ledger.json` 是真实台账，测试绝不许碰。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordResearchRun } from "../lib/pipeline/research-context";
import { readResearchLedger } from "../lib/adapters/research/ledger-store";
import { cutDate, RESEARCH_LEDGER_DAYS } from "../lib/services/research/ledger";
import type { Logger } from "../lib/contracts/pipeline";
import type { ResearchPanelItem } from "../lib/contracts/research";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "research-ctx-"));
}

function item(title: string, day: string, url = `https://r/${encodeURIComponent(title)}`): ResearchPanelItem {
  return { title, url, org: "中金公司", publishedAt: day };
}

function fakeLog(): { log: Logger; infos: string[]; warns: string[] } {
  const infos: string[] = [];
  const warns: string[] = [];
  return {
    infos,
    warns,
    log: {
      info: (_s, m) => void infos.push(m),
      warn: (_s, m) => void warns.push(m),
      error: () => {},
    },
  };
}

test("① 抓到条目 → 写出台账，firstSeen 与 updatedAt 都用报告日期", () => {
  const f = path.join(tmpDir(), "ledger.json");
  const { log } = fakeLog();
  recordResearchRun([item("银行深度A", "2026-11-27")], "2026-11-28", log, f);

  const r = readResearchLedger(f);
  assert.equal(r.state, "ok");
  assert.equal(r.ledger.items.length, 1);
  assert.equal(r.ledger.updatedAt, "2026-11-28");
  assert.equal(r.ledger.items[0].firstSeen, "2026-11-28");
});

test("② 没抓到条目 / 没有日期 → 一个字节都不写（不留空壳天）", () => {
  const dir = tmpDir();
  const f = path.join(dir, "ledger.json");
  const { log } = fakeLog();

  recordResearchRun(undefined, "2026-11-28", log, f);
  recordResearchRun([], "2026-11-28", log, f);
  recordResearchRun([item("A", "2026-11-27")], "", log, f);

  assert.equal(fs.existsSync(f), false, "空输入不得创建文件");
});

test("③ 台账损坏 → 拒绝写回，原文件逐字保留（10-19 静默清空的防线）", () => {
  const dir = tmpDir();
  const f = path.join(dir, "ledger.json");
  const broken = '{"version":1,"updatedAt":"2026-11-27","items":[{"title":"A"';
  fs.writeFileSync(f, broken, "utf8");
  const { log, warns } = fakeLog();

  recordResearchRun([item("新研报", "2026-11-28")], "2026-11-28", log, f);

  assert.equal(fs.readFileSync(f, "utf8"), broken, "坏文件必须原样保留等人工处理");
  assert.equal(warns.length, 1);
  assert.match(warns[0], /拒绝写回/);
});

test("④ 跨期合并：已有条目保留首见日，updatedAt 推进到今天", () => {
  const f = path.join(tmpDir(), "ledger.json");
  const { log } = fakeLog();

  recordResearchRun([item("银行深度A", "2026-11-26")], "2026-11-26", log, f);
  recordResearchRun(
    [item("银行深度A", "2026-11-26"), item("保险深度B", "2026-11-27")],
    "2026-11-28",
    log,
    f,
  );

  const r = readResearchLedger(f);
  assert.equal(r.ledger.items.length, 2, "同 url 不重复入库");
  assert.equal(r.ledger.updatedAt, "2026-11-28");
  const a = r.ledger.items.find((x) => x.title === "银行深度A");
  assert.equal(a?.firstSeen, "2026-11-26", "首见日不得被后续抓取推后");
});

test("⑤ 日志统计：新增按主键差算，重复合并第二次报新增 0（不因窗口滚动算负数）", () => {
  const f = path.join(tmpDir(), "ledger.json");
  const batch = [item("A", "2026-11-27"), item("B", "2026-11-27")];

  const first = fakeLog();
  recordResearchRun(batch, "2026-11-28", first.log, f);
  assert.match(first.infos[0], /新增 2 条/);
  assert.match(first.infos[0], /累计 2 条/);

  const second = fakeLog();
  recordResearchRun(batch, "2026-11-28", second.log, f);
  assert.match(second.infos[0], /新增 0 条/);
});

test("⑥ 窗口滚动：超 90 天的旧条目被裁掉，日志显式说明裁了几条", () => {
  const f = path.join(tmpDir(), "ledger.json");
  const old = cutDate("2026-11-28", RESEARCH_LEDGER_DAYS + 5);
  const { log } = fakeLog();

  // 先让旧条目入库（用旧日期当天写，才不会被窗口裁掉）
  recordResearchRun([item("很老的研报", old)], old, log, f);
  assert.equal(readResearchLedger(f).ledger.items.length, 1);

  const later = fakeLog();
  recordResearchRun([item("今天的研报", "2026-11-28")], "2026-11-28", later.log, f);

  const r = readResearchLedger(f);
  assert.equal(r.ledger.items.length, 1);
  assert.equal(r.ledger.items[0].title, "今天的研报");
  assert.match(later.infos[0], /裁掉 1 条/);
});

test("⑦ 写盘失败 → 只告警，不抛错（台账坏了不能拖垮当天日报）", () => {
  // 把「文件路径」指到一个目录上：writeFileSync 必然失败
  const dir = tmpDir();
  const { log, warns } = fakeLog();
  assert.doesNotThrow(() => recordResearchRun([item("A", "2026-11-27")], "2026-11-28", log, dir));
  assert.equal(warns.length, 1);
  assert.match(warns[0], /研报台账写入失败/);
});

// —— 2026-11-28 新增：报告日不可信时拒绝记账 ——
// 实测背景：用 REPORT_DATE=2026-09-11 跑了一次真实抓取，新浪首页 22 条研报（发布日在 11 月下旬）
// 全被记成 firstSeen=09-11，台账里凭空多出一批「9 月就见过的 11 月研报」。

test("⑧ 发布日期晚于报告日 → 判定用历史日期回跑，整批不入台账", () => {
  const dir = tmpDir();
  const f = path.join(dir, "ledger.json");
  const { log, warns } = fakeLog();

  recordResearchRun(
    [item("11月下旬研报A", "2026-11-27"), item("11月下旬研报B", "2026-11-28")],
    "2026-09-11",
    log,
    f,
  );

  assert.equal(fs.existsSync(f), false, "报告日早于全部发布日期时不得创建台账");
  assert.equal(warns.length, 1);
  assert.match(warns[0], /晚于报告日/);
  assert.match(warns[0], /REPORT_DATE/);
});

test("⑨ 单条日期错标：只跳过该条，其余正常入账（不整批放弃）", () => {
  const f = path.join(tmpDir(), "ledger.json");
  const { log, warns } = fakeLog();

  recordResearchRun(
    [item("正常研报", "2026-11-27"), item("源站错标成未来", "2026-12-30")],
    "2026-11-28",
    log,
    f,
  );

  const r = readResearchLedger(f);
  assert.equal(r.ledger.items.length, 1, "未来条目跳过，正常条目照常入库");
  assert.equal(r.ledger.items[0].title, "正常研报");
  assert.match(warns[0], /1 条发布日期晚于报告日/);
});
