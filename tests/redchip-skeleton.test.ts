/**
 * 红筹骨架链路加锁测试：样本 → 判定 → 存储 → diff。
 * 全部离线（固定样本 + 临时目录），不发起网络请求。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadSampleListing } from "../lib/adapters/redchip/hkex-client";
import { classifyProject, countGdCityHits, isOffshoreDomicile } from "../lib/services/redchip/classify";
import { diffSnapshots } from "../lib/services/redchip/diff";
import {
  appendChanges,
  readChanges,
  readLatest,
  setRedchipBaseDir,
  writeLatest,
} from "../lib/adapters/redchip/snapshot-store";
import type { RedchipProject, RedchipSnapshot } from "../lib/contracts/redchip";
import { GD_CITY_HIT_THRESHOLD } from "../lib/contracts/redchip";

const SAMPLE = "fixtures/redchip-sample.json";

function classifyAll(): RedchipProject[] {
  return loadSampleListing(SAMPLE).map((r) =>
    classifyProject({
      appId: String(r.id ?? ""),
      nameCn: r.a,
      nameEn: r.aEn,
      board: r.w,
      status: r.s,
      submitDate: r.sD ?? r.d,
      docText: r.docText,
      sourceUrl: r.docUrl,
      discoveredAt: "2026-09-14T07:30:00+08:00",
    }),
  );
}

test("① 判定口径：离岸 ∧ 广东词频≥" + GD_CITY_HIT_THRESHOLD + " 才判红筹", () => {
  const byId = new Map(classifyAll().map((p) => [p.appId, p]));
  // 离岸 + 词频 4 → 红筹
  assert.equal(byId.get("SAMPLE-001")?.verdict, "redchip");
  assert.equal(byId.get("SAMPLE-001")?.isOffshore, true);
  assert.ok((byId.get("SAMPLE-001")?.gdCityHits ?? 0) >= GD_CITY_HIT_THRESHOLD);
  // 境内注册（PRC）→ 非红筹（即使广东词频达标）
  assert.equal(byId.get("SAMPLE-002")?.verdict, "non-redchip");
  assert.equal(byId.get("SAMPLE-002")?.isOffshore, false);
  // 离岸但词频不足 → 非红筹
  assert.equal(byId.get("SAMPLE-003")?.verdict, "non-redchip");
  assert.ok((byId.get("SAMPLE-003")?.gdCityHits ?? 0) < GD_CITY_HIT_THRESHOLD);
  // 无文档 → 未核验（宁缺毋滥，不臆造）
  assert.equal(byId.get("SAMPLE-004")?.verdict, "unverified");
});

test("② 词表与阈值：离岸法域识别 + 广东城市计数", () => {
  assert.equal(isOffshoreDomicile("Cayman Islands"), true);
  assert.equal(isOffshoreDomicile("Bermuda"), true);
  assert.equal(isOffshoreDomicile("People's Republic of China"), false);
  assert.equal(countGdCityHits("广州 广州 广州"), 3);
  assert.equal(countGdCityHits("北京 上海"), 0);
});

test("③ diff：首次全量 added，二次幂等 0 变更", () => {
  const snap: RedchipSnapshot = { capturedAt: "2026-09-14T07:30:00+08:00", count: 4, projects: classifyAll() };
  const first = diffSnapshots(null, snap);
  assert.equal(first.length, 4);
  assert.ok(first.every((c) => c.type === "added"));
  const second = diffSnapshots(snap, snap);
  assert.equal(second.length, 0, "同一快照再次比对应无变更（幂等）");
});

test("④ 存储：快照与变更日志可写可读（临时目录隔离）", () => {
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "redchip-skel-"));
  setRedchipBaseDir(tmp);
  try {
    assert.equal(readLatest(), null, "初始无快照");
    const snap: RedchipSnapshot = { capturedAt: "2026-09-14T07:30:00+08:00", count: 4, projects: classifyAll() };
    writeLatest(snap);
    assert.equal(readLatest()?.count, 4);
    appendChanges(diffSnapshots(null, snap));
    assert.equal(readChanges().length, 4, "changelog 应落 4 条 added");
  } finally {
    setRedchipBaseDir(undefined);
    fsSync.rmSync(tmp, { recursive: true, force: true });
  }
});
