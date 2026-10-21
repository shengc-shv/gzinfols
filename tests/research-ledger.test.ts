/**
 * 研报台账合并单测（2026-10-19）。
 *
 * 覆盖 sc 要求的三个合并动作：跨期去重 / 窗口收敛 / 首见保留。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeResearchLedger,
  emptyResearchLedger,
  cutDate,
  groupByPublishedDate,
  RESEARCH_LEDGER_DAYS,
} from "../lib/services/research/ledger";
import type { ResearchPanelItem } from "../lib/contracts/research";

const it = (title: string, day: string, url = `https://r/${encodeURIComponent(title)}`): ResearchPanelItem => ({
  title,
  url,
  org: "中金公司",
  publishedAt: day,
});

test("首次合并：条目入库并记首见日", () => {
  const led = mergeResearchLedger(emptyResearchLedger(), [it("银行深度A", "2026-10-19")], {
    today: "2026-10-19",
  });
  assert.equal(led.items.length, 1);
  assert.equal(led.items[0].firstSeen, "2026-10-19");
  assert.equal(led.updatedAt, "2026-10-19");
});

test("跨期去重：同一 url 被连续多天窗口重复捞到，只存一份且首见不变", () => {
  let led = mergeResearchLedger(emptyResearchLedger(), [it("银行深度A", "2026-10-18")], {
    today: "2026-10-18",
  });
  led = mergeResearchLedger(led, [it("银行深度A", "2026-10-18")], { today: "2026-10-19" });
  led = mergeResearchLedger(led, [it("银行深度A", "2026-10-18")], { today: "2026-10-20" });
  assert.equal(led.items.length, 1);
  assert.equal(led.items[0].firstSeen, "2026-10-18");
});

test(`窗口收敛：超过 ${RESEARCH_LEDGER_DAYS} 天的条目被裁掉，窗口内的保留`, () => {
  const led = mergeResearchLedger(
    emptyResearchLedger(),
    [it("很老的研报", cutDate("2026-10-19", RESEARCH_LEDGER_DAYS + 1)), it("昨天的研报", "2026-10-18")],
    { today: "2026-10-19" },
  );
  assert.equal(led.items.length, 1);
  assert.equal(led.items[0].title, "昨天的研报");
});

test("元数据保留：同 url 再次入库不覆盖首见版本（防同文两版并存）", () => {
  const sameUrl = "https://r/same-article";
  const first = { ...it("银行深度A", "2026-10-19", sameUrl), org: "首见机构" };
  let led = mergeResearchLedger(emptyResearchLedger(), [first], { today: "2026-10-19" });
  const changed = { ...it("银行深度A（改标题）", "2026-10-19", sameUrl), org: "另一机构" };
  led = mergeResearchLedger(led, [changed], { today: "2026-10-20" });
  assert.equal(led.items.length, 1);
  assert.equal(led.items[0].org, "首见机构");
});

test("排序与分组：按发布日期降序，groupByPublishedDate 同口径", () => {
  const led = mergeResearchLedger(
    emptyResearchLedger(),
    [it("A", "2026-10-17"), it("B", "2026-10-19"), it("C", "2026-10-19")],
    { today: "2026-10-19" },
  );
  assert.deepEqual(led.items.map((x) => x.publishedAt), ["2026-10-19", "2026-10-19", "2026-10-17"]);
  const g = groupByPublishedDate(led.items);
  assert.equal(g.length, 2);
  assert.equal(g[0].date, "2026-10-19");
  assert.equal(g[0].items.length, 2);
});

test("同标题不同 infoCode（源重复发布）只留一条", () => {
  const a = it("银行深度：RAROC 五因子", "2026-10-19", "https://r/infocode-1");
  const b = it("银行深度：RAROC五因子", "2026-10-19", "https://r/infocode-2"); // 空格差异 + 不同 url
  const led = mergeResearchLedger(emptyResearchLedger(), [a, b], { today: "2026-10-19" });
  assert.equal(led.items.length, 1);
  assert.equal(led.items[0].url, "https://r/infocode-1");
});

test("幂等：同一批数据合并两次结果不变", () => {
  const batch = [it("A", "2026-10-19"), it("B", "2026-10-18")];
  const once = mergeResearchLedger(emptyResearchLedger(), batch, { today: "2026-10-19" });
  const twice = mergeResearchLedger(once, batch, { today: "2026-10-19" });
  assert.deepEqual(twice, once);
});

// —— 台账 IO 三态（2026-10-19 加固）：坏文件绝不能被当成「空台账」→ 覆盖写回 ——
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readResearchLedger, writeResearchLedger } from "../lib/adapters/research/ledger-store";

function tmpLedgerFile(content?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "research-ledger-"));
  const f = path.join(dir, "research-ledger.json");
  if (content !== undefined) fs.writeFileSync(f, content, "utf8");
  return f;
}

test("台账不存在 → missing（首跑允许在空台账上合并）", () => {
  const f = tmpLedgerFile();
  const r = readResearchLedger(f);
  assert.equal(r.state, "missing");
  assert.equal(r.ledger.items.length, 0);
});

test("台账正常 → ok，条目完整读回", () => {
  const f = tmpLedgerFile(JSON.stringify({ version: 1, updatedAt: "2026-10-19", items: [it("A", "2026-10-19")] }));
  const r = readResearchLedger(f);
  assert.equal(r.state, "ok");
  assert.equal(r.ledger.items.length, 1);
});

test("台账坏 JSON / 半写截断 → corrupt（调用方据此拒绝写回）", () => {
  const full = JSON.stringify({ version: 1, updatedAt: "2026-10-19", items: [it("A", "2026-10-19"), it("B", "2026-10-18")] });
  const f = tmpLedgerFile(full.slice(0, Math.floor(full.length * 0.7)));
  const r = readResearchLedger(f);
  assert.equal(r.state, "corrupt");
  assert.ok(r.error && r.error.length > 0, "corrupt 必须带错误原因供告警");
  // 关键：原文件必须原样保留（腐坏内容也比被空台账覆盖好）
  assert.equal(fs.readFileSync(f, "utf8"), full.slice(0, Math.floor(full.length * 0.7)));
});

test("结构不符（items 非数组）→ corrupt，不冒充空台账", () => {
  const f = tmpLedgerFile(JSON.stringify({ version: 1, items: { oops: 1 } }));
  assert.equal(readResearchLedger(f).state, "corrupt");
});

test("写入可指定路径（测试注入），内容可回读", () => {
  const f = tmpLedgerFile();
  // 台账条目比面板条目多一个 firstSeen（首见抓取日）
  writeResearchLedger(
    { version: 1, updatedAt: "2026-10-19", items: [{ ...it("C", "2026-10-19"), firstSeen: "2026-10-19" }] },
    f,
  );
  const r = readResearchLedger(f);
  assert.equal(r.state, "ok");
  assert.equal(r.ledger.items[0].title, "C");
});

test("老条目补缺失 pdfUrl（2026-10-21：确定性派生值，不覆盖已有值）", () => {
  const url = "https://data.eastmoney.com/report/zw_industry.jshtml?infocode=AP202610191830674433";
  const pdf = "https://pdf.dfcfw.com/pdf/H3_AP202610191830674433_1.pdf";
  // 老台账：同 url 已存在但无 pdfUrl
  const existing = mergeResearchLedger(emptyResearchLedger(), [it("银行深度A", "2026-10-19", url)], {
    today: "2026-10-19",
  });
  assert.equal(existing.items[0].pdfUrl, undefined, "老条目入库时本就没有该字段");

  const again = mergeResearchLedger(existing, [{ ...it("银行深度A", "2026-10-19", url), pdfUrl: pdf }], {
    today: "2026-10-20",
  });
  assert.equal(again.items.length, 1, "同 url 不重复入库");
  assert.equal(again.items[0].pdfUrl, pdf, "缺失字段应被补上");
  assert.equal(again.items[0].firstSeen, "2026-10-19", "补字段不得改动首见日");
});

test("老条目补 id 与 pdfUrl（2026-10-21：确定性派生值，幂等）", () => {
  const url = "https://data.eastmoney.com/report/zw_industry.jshtml?infocode=AP202610191830674433";
  const existing = mergeResearchLedger(emptyResearchLedger(), [it("银行深度A", "2026-10-19", url)], {
    today: "2026-10-19",
  });
  assert.equal(existing.items[0].id, "rs-AP202610191830674433", "新条目入库即带 id");

  // 老条目（无 id/pdfUrl）再合并一次 → 两项都补上，且不重复入库
  const again = mergeResearchLedger(existing, [it("银行深度A", "2026-10-19", url)], {
    today: "2026-10-20",
  });
  assert.equal(again.items.length, 1);
  assert.equal(again.items[0].id, "rs-AP202610191830674433");
  assert.equal(again.items[0].firstSeen, "2026-10-19", "补字段不得改动首见日");
});
