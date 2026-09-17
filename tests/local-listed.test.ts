/**
 * 上市字典本地冻结快照 + 新鲜度阈值分档（T1-A / T1-B，2026-09-17）。
 *
 * 背景：深交所接口在 GitHub 海外 runner 上恒 `fetch failed`（本机国内直连 200），
 * 线上上市字典长期为空 → 「候选升级为已上市」静默失效 + 每日刷告警。
 * 对策：本地抓快照入库（`data/local-listed.json`），远端在线优先、快照补位；
 * 同时把 IPO 类源的新鲜度阈值放宽（天然稀疏，3 天必然天天误报）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildLocalListedSnapshot,
  countByExchange,
  isValidListing,
  mergeLocalListings,
  readLocalListedFile,
  writeLocalListedFile,
} from "../lib/adapters/local-listed";
import type { StoredListing } from "../lib/adapters/local-listed";
import { createListedChecker, WINDOW_DAYS } from "../lib/adapters/crawlers/sources/listed-check";
import { STALE_LAG_DAYS, STALE_LAG_DAYS_IPO, checkStale } from "../lib/adapters/crawlers/sources/staleness";
import { todayKeyOf, prevDateKey } from "../lib/utils/time";

const L = (code: string, listedDate: string, exchange: StoredListing["exchange"] = "SZSE"): StoredListing => ({
  code,
  name: `公司${code}`,
  listedDate,
  exchange,
});

function withTmpFile(fn: (p: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listed-"));
  const p = path.join(dir, "local-listed.json");
  try {
    fn(p);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("① 时间真实性：无官方上市日期的记录一律不入库", () => {
  assert.equal(isValidListing({ code: "1", name: "甲", listedDate: "", exchange: "SSE" }), false);
  assert.equal(isValidListing({ code: "1", name: "甲", listedDate: "2026-09-10", exchange: "SSE" }), true);
  assert.equal(isValidListing({ code: "", name: "甲", listedDate: "2026-09-10", exchange: "SSE" }), false);
});

test("② 快照写入/读取往返，且超窗旧记录不入库", () => {
  const cutoff = "2026-09-10";
  const { file, stats } = buildLocalListedSnapshot(
    [L("a", "2026-09-12"), L("b", "2026-09-01")],
    { cutoff, windowDays: WINDOW_DAYS },
  );
  // b 在窗口下界之前 → 即便「新抓到」也不入库（窗口由调用方按北京时间给出）
  assert.equal(stats.total, 1, "超窗记录不得入库");
  assert.equal(file.listings[0].code, "a");
  assert.deepEqual(file.counts, { SZSE: 1 });

  withTmpFile((p) => {
    writeLocalListedFile(file, p);
    const back = readLocalListedFile(p);
    assert.ok(back.file, "写后应能读回");
    assert.equal(back.file?.listings.length, 1);
  });
});

test("③ 快照补位：在线优先，本地只补缺口；超窗不补", () => {
  withTmpFile((p) => {
    const { file } = buildLocalListedSnapshot(
      [L("online", "2026-09-12"), L("local", "2026-09-11"), L("old", "2026-08-01")],
      { cutoff: "2026-09-01", windowDays: 30 },
    );
    writeLocalListedFile(file, p);

    const into = new Map<string, StoredListing>([["online", L("online", "2026-09-12", "SSE")]]);
    const res = mergeLocalListings(into, { filePath: p, cutoff: "2026-09-10", now: new Date() });
    assert.equal(res.added, 1, "只补在线没有的那条（old 超窗不补）");
    assert.equal(into.get("online")?.exchange, "SSE", "在线条目不得被本地覆盖");
    assert.equal(into.get("local")?.exchange, "SZSE");
    assert.equal(into.has("old"), false, "超窗记录不得补位");
  });
});

test("④ cutoff 按北京时区取日期键（CI 的 UTC runner 不得算错一天）", () => {
  const checker = createListedChecker();
  // 北京 2026-09-17 00:30（UTC 仍是 09-16 16:30）——旧实现用运行环境本地时区会算成 09-09
  const beijing = new Date("2026-09-16T16:30:00Z");
  assert.equal(checker.cutoffDate(beijing), prevDateKey(todayKeyOf(beijing), WINDOW_DAYS));
  assert.equal(checker.cutoffDate(beijing), "2026-09-10", "北京 09-17 减 7 天应为 09-10");
});

test("⑤ 新鲜度阈值分档：IPO 类放宽到 10 天，新闻类仍为 3 天", () => {
  assert.ok(STALE_LAG_DAYS_IPO > STALE_LAG_DAYS, "IPO 阈值须宽于新闻类（否则天天误报）");
  const lag5 = prevDateKey(todayKeyOf(new Date()), 5); // 滞后 5 天：新闻类该报、IPO 类不该报
  assert.equal(checkStale("t", [lag5], { lagDays: STALE_LAG_DAYS }), true, "新闻类 5 天须告警");
  assert.equal(checkStale("t", [lag5], { lagDays: STALE_LAG_DAYS_IPO }), false, "IPO 类 5 天不得告警");
  // 「0 条日期」是真故障信号，不受阈值放宽影响
  assert.equal(checkStale("t", [], { lagDays: STALE_LAG_DAYS_IPO }), true, "0 条日期一律告警");
});

test("⑥ countByExchange 确定性输出（git diff 稳定）", () => {
  assert.deepEqual(countByExchange([L("a", "2026-09-12", "SSE"), L("b", "2026-09-11", "BSE"), L("c", "2026-09-11", "SSE")]), {
    BSE: 1,
    SSE: 2,
  });
});
