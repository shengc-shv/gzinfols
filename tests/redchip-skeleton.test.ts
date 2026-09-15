/**
 * 红筹骨架链路加锁测试：样本 → 判定 → 存储 → diff。
 * 全部离线（固定样本 + 临时目录），不发起网络请求。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applicationProofUrlOf,
  docUrlOf,
  loadSampleListing,
  multiFilesUrlOf,
  type ListingRecord,
} from "../lib/adapters/redchip/hkex-client";
import {
  classifyProject,
  countGdCityHits,
  countGdCityMentions,
  extractDomicile,
  isOffshoreDomicile,
} from "../lib/services/redchip/classify";
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

test("② 词表与阈值：离岸法域识别 + 广东城市计数（含实体语境门槛）", () => {
  assert.equal(isOffshoreDomicile("Cayman Islands"), true);
  assert.equal(isOffshoreDomicile("Bermuda"), true);
  assert.equal(isOffshoreDomicile("People's Republic of China"), false);
  // 语境过滤后：无「所属表达」的裸罗列不计入判定
  assert.equal(countGdCityHits("广州 广州 广州"), 0, "裸罗列不算运营连接");
  assert.equal(countGdCityHits("本集团于广州、广州、广州设有生产基地"), 3, "本集团语境应计入");
  assert.equal(countGdCityHits("北京 上海"), 0);
  // 裸提及保留可追溯（不受语境门槛影响）
  assert.equal(countGdCityMentions("广州 广州 广州"), 3);
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

test("⑤ 文档选取：取 ls[] 的「申请版本」，绝不用 w（警告页）", () => {
  const rec: ListingRecord = {
    id: 108870,
    d: "13/09/2026",
    a: "Hai Robotics Innovation Group Co., Ltd. - W",
    // ⚠️ 实网实测：w 指向 1 页「警告聲明」，不含注册地句式
    w: "sehk/2026/108870/documents/warn26091300122.pdf",
    ls: [
      {
        d: "13/09/2026",
        nS1: "OC Announcement - Appointment",
        u1: "sehk/2026/108870/documents/sehk26091300188.pdf",
      },
      {
        d: "13/09/2026",
        nF: "Application Proof (1st submission)",
        nS1: "Full Version",
        nS2: "Multi-Files",
        u1: "sehk/2026/108870/documents/sehk26091300124.pdf",
        u2: "sehk/2026/108870/2026091300119.htm",
      },
    ],
  };
  assert.equal(
    applicationProofUrlOf(rec),
    "https://www1.hkexnews.hk/app/sehk/2026/108870/documents/sehk26091300124.pdf",
  );
  assert.equal(docUrlOf(rec), applicationProofUrlOf(rec), "docUrlOf 应等于申请版本");
  assert.ok(!String(docUrlOf(rec)).includes("warn"), "绝不可回落 w 指向的警告页");
  assert.equal(
    multiFilesUrlOf(rec),
    "https://www1.hkexnews.hk/app/sehk/2026/108870/2026091300119.htm",
  );
  // 无申请版本条目 → undefined（宁缺毋滥，不去抽警告页）
  assert.equal(applicationProofUrlOf({ id: 1, w: "sehk/2026/1/documents/warn1.pdf" }), undefined);
  // 中文清单同样识别
  assert.equal(
    applicationProofUrlOf({
      id: 2,
      ls: [{ nF: "申請版本（第一次呈交）", nS1: "全文檔案", u1: "sehk/2026/2/documents/sehk1_c.pdf" }],
    }),
    "https://www1.hkexnews.hk/app/sehk/2026/2/documents/sehk1_c.pdf",
  );
});

test("⑥ 注册地抽取：紧凑化可容忍词内插空格，并识别 PRC/离岸", () => {
  // PDF 抽取常在词内插空格（pypdf/pdfjs 同款问题）
  assert.equal(extractDomicile("Incorporated in the Cayman Isl ands with limited liability"), "开曼群岛");
  assert.equal(
    extractDomicile(
      "A joint stock company incorporated in the People's Republic of China with limited liability",
    ),
    "中国(境内)",
  );
  assert.equal(extractDomicile("Incorporated in Bermuda with limited liability"), "百慕大");
  assert.equal(extractDomicile("Incorporated in Hong Kong with limited liability"), "香港");
  // 正文远处的提及（超封面窗口）→ 不采信（防「股东基金在开曼」带偏注册地）
  const far = "x".repeat(25_000) + "incorporated in the Cayman Islands with limited liability";
  assert.equal(extractDomicile(far), undefined, "超封面窗口的正文提及不采信");
});

test("⑦ 英文通道：广东城市按英文词计数（英文版申请版本文本可用）", () => {
  const en =
    "Our headquarters are in Shenzhen, with offices in Dongguan and Guangzhou. " +
    "The group operates in Guangdong Province.";
  assert.ok(countGdCityHits(en) >= GD_CITY_HIT_THRESHOLD, "英文城市名应被计数");
  assert.equal(countGdCityHits("Beijing and Shanghai only"), 0);
});

test("⑧ 语义归属：董事住址 / 交易所名称不得计入广东连接", () => {
  // 实网原文（108870 招股书）：董事住址里的 Shenzhen 不是运营实体
  const 住址 =
    "Directors and senior management: Chen Yuqi, Unit 20B02, Building 11 Qinchengda Paradise Gongyuan Road Bao'an District Shenzhen Guangdong Province PRC Chinese Mr.";
  // 实网原文：这里的「深圳」来自深交所名称，纯噪音
  const 交易所 = "It is a subsidiary of a company listed on the Shenzhen Stock Exchange.";
  // 实网原文：真正的「广东运营实体」证据
  const 真证据 =
    "As of June 30, 2026, we operated two manufacturing facilities located in Dongguan, Guangdong Province.";

  assert.equal(countGdCityHits(住址), 0, "董事住址不算运营连接");
  assert.equal(countGdCityHits(交易所), 0, "深交所名称不算运营连接");
  assert.ok(countGdCityMentions(住址) > 0, "裸提及仍应可追溯（供展示/核对）");
  assert.equal(countGdCityHits([住址, 交易所, 真证据].join(" ")), 1, "只认实体语境句（Dongguan 1 次）");
  assert.ok(
    countGdCityMentions([住址, 交易所, 真证据].join(" ")) > countGdCityHits([住址, 交易所, 真证据].join(" ")),
    "裸提及应严格多于实体语境命中（差额即噪音）",
  );
});

test("⑨ 反例锁：离岸注册 + 广东词只出现在董事住址 → 必须 non-redchip", () => {
  const p = classifyProject({
    appId: "NEG-1",
    docText:
      "Incorporated in the Cayman Islands with limited liability. " +
      "Directors: Mr. A, Unit 1203 Block E Xin'an Street Bao'an District Shenzhen Guangdong Province PRC Chinese Mr. " +
      "Mr. B, Room 301 Tower B Nanshan District Shenzhen Guangdong Province PRC Chinese Ms. " +
      "Mr. C, Unit 18I Jiuyue Yaxuan Bao'an District Shenzhen Guangdong Province PRC Chinese Mr.",
    discoveredAt: "2026-09-15T08:00:00+08:00",
  });
  assert.equal(p.isOffshore, true, "开曼注册 → 离岸成立");
  assert.equal(p.gdCityHits, 0, "住址里的深圳不计入运营连接");
  assert.ok((p.gdCityMentions ?? 0) >= 3, "裸提及仍记录（3 位董事住址）");
  assert.equal(p.isGdConnected, false);
  assert.equal(p.verdict, "non-redchip", "不得因住址噪音误判为红筹（阈值必须真正生效）");
});

test("⑩ 邻近窗口：同一句内但远离所属表达的城市名不计入", () => {
  // 实网形态（108866）：招股书表格被抽成一条超长「句子」，城市名离 `Our Group` 很远
  const far = "Our Group " + "x".repeat(400) + " Yangjiang";
  assert.equal(countGdCityHits(far), 0, "超窗口的远处城市名不计入");
  assert.equal(countGdCityHits("Our Group operates in Yangjiang, Guangdong Province."), 1, "邻近城市名应计入");
});
