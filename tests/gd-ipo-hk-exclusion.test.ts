/**
 * 「单纯赴港上市不播报」加锁测试（2026-09-16 用户口径）。
 *
 * 背景：港股通道已由红筹对接（红筹线索有徽章 + 穿透报告页 + 播报提权）。
 * 非红筹的港交所递表/上市对分行零售条线没有可执行价值 → **不进口播与顶部横滑**；
 * 底部「广东IPO动态」完整列表**不受影响**（仍 7 天窗全量，供参考与红筹页回溯）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildGdIpoSpoken,
  gdIpoCandidates,
  isPlainHkListing,
  topGdIpo,
} from "../lib/services/classify/gd-ipo-spoken";
import type { ReportItem } from "../lib/contracts/report";
import type { RedchipBadge } from "../lib/contracts/redchip";

function hkItem(title: string, appId: string, over: Partial<ReportItem> = {}): ReportItem {
  const url = `https://www1.hkexnews.hk/app/sehk/2026/${appId}/2026091300120_c.htm`;
  return {
    url,
    title_cn: title,
    source: "港交所",
    source_type: "official",
    date: "09/15",
    summary: "",
    importance: 2,
    rank: 1,
    tags: ["粤"],
    locale: "national",
    officialUrl: url,
    ipoStage: "stage-reviewing",
    ...over,
  };
}

function aShareItem(title: string): ReportItem {
  return {
    url: "https://www.szse.cn/listing/projectdynamic/ipo/index.html#prj1",
    title_cn: title,
    source: "深交所",
    source_type: "official",
    date: "09/15",
    summary: "注册地：广东",
    importance: 2,
    rank: 1,
    tags: ["粤"],
    locale: "national",
    ipoStage: "stage-reviewing",
  };
}

const redchipBadge: RedchipBadge = {
  leadId: "108870",
  label: "红筹线索",
  verdict: "redchip",
  isNew: false,
  domicile: "开曼群岛",
  gdCityHits: 5,
};

test("① isPlainHkListing：港交所条目 ∧ 非红筹 → true；红筹/非港股 → false", () => {
  assert.equal(isPlainHkListing(hkItem("某公司（主板递表）", "108868")), true);
  assert.equal(
    isPlainHkListing(hkItem("某红筹（主板递表）", "108870", { redchip: redchipBadge })),
    false,
    "红筹线索照常播报",
  );
  assert.equal(isPlainHkListing(aShareItem("某公司：IPO注册生效")), false, "A 股条目不在此规则范围");
});

test("② 口播：只有单纯赴港上市 → 不播（返回空串）", () => {
  const items = [
    hkItem("翱捷科技（主板递表）", "108868"),
    hkItem("浙江和夏科技（GEM递表）", "108869"),
  ];
  assert.equal(buildGdIpoSpoken(items, { today: "2026-09-16" }), "", "单纯赴港不播");
});

test("③ 口播：红筹港股仍在播，单纯赴港被剔除", () => {
  const rc = hkItem("海柔创新（主板递表）", "108870", { redchip: redchipBadge });
  const plain = hkItem("翱捷科技（主板递表）", "108868");
  const aShare = aShareItem("云英谷科技：IPO辅导备案");
  const s = buildGdIpoSpoken([plain, rc, aShare], { today: "2026-09-16" });
  assert.ok(s.includes("海柔创新"), "红筹照常播");
  assert.ok(s.includes("云英谷"), "A 股照常播");
  assert.ok(!s.includes("翱捷科技"), "单纯赴港不播");
});

test("④ 横滑（excludePlainHk: true）同口径剔除；底部列表（缺省 false）保留", () => {
  const items = [hkItem("翱捷科技（主板递表）", "108868"), aShareItem("云英谷科技：IPO辅导备案")];
  const slide = topGdIpo(items, undefined, 3, undefined, { uniqueCompany: true, excludePlainHk: true });
  assert.deepEqual(slide.map((i) => i.title_cn), ["云英谷科技：IPO辅导备案"]);
  const list = topGdIpo(items, undefined, 9999, 7, { uniqueCompany: false });
  assert.equal(list.length, 2, "底部完整列表不受影响（仍列赴港条目）");
  assert.equal(gdIpoCandidates(items, undefined, 7).length, 2, "未显式排除时保持原行为");
});

test("⑤ 红筹条目仍受提权（与已实现的 T4 一致）：同一池内红筹排前", () => {
  const rc = hkItem("海柔创新（主板递表）", "108870", { redchip: redchipBadge, ipoStage: "stage-reviewing" });
  const normal = aShareItem("某公司：IPO注册生效");
  const out = gdIpoCandidates([normal, rc], undefined, undefined, { excludePlainHk: true });
  assert.equal(out[0].title_cn, "海柔创新（主板递表）", "红筹（在审+提权）应越过非红筹（注册生效）");
});
