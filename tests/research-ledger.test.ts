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
