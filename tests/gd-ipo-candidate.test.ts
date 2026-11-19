/**
 * 「广东企业 IPO 动态」内容判定（2026-08-30）单测：
 *  - isGdIpoCandidate：媒体源报道（粤芯注册生效）命中；普通政策/非广东企业不误伤。
 *  - detectGdIpo（播报兜底）：名单企业名命中的标题（无「广东/广州」字样）不再漏。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isGdIpoCandidate } from "../lib/services/render/cards";
import { detectGdIpo } from "../lib/services/voice";
import { IPO_PROGRESS_RE as HEURISTICS_IPO_RE } from "../lib/services/enrich/heuristics";
import { IPO_PROGRESS_RE as VOICE_IPO_RE } from "../lib/services/voice";

test("isGdIpoCandidate: 粤芯注册生效报道命中（名单企业名 + 阶段词，标题无广东/广州字样）", () => {
  assert.equal(
    isGdIpoCandidate("证监会同意粤芯半导体技术股份有限公司首次公开发行股票注册"),
    true,
  );
  assert.equal(isGdIpoCandidate("粤芯半导体：注册生效，拟登陆创业板"), true);
  assert.equal(isGdIpoCandidate("小鹏汽车：港股IPO上市首日", "小鹏汽车敲钟上市"), true);
});

test("isGdIpoCandidate: 广东城市词 + IPO 阶段词命中", () => {
  assert.equal(isGdIpoCandidate("广州企业珠江实业拟IPO上市辅导备案"), true);
  assert.equal(isGdIpoCandidate("广东企业再添IPO：深圳某公司提交注册"), true);
});

test("isGdIpoCandidate: 普通政策/活动新闻不误伤（无阶段强词）", () => {
  // 泛化「上市/IPO」裸词不进（刻意排除「上市培育/IPO 培训」类政务活动）
  assert.equal(isGdIpoCandidate("广州召开企业上市培育工作会议"), false);
  assert.equal(isGdIpoCandidate("广州市举办IPO培训讲座"), false);
  // 非广东企业 IPO 不进
  assert.equal(isGdIpoCandidate("宁德时代提交创业板注册申请"), false);
  assert.equal(isGdIpoCandidate("贵州茅台拟IPO"), false);
  // 广东企业但非 IPO 事件不进
  assert.equal(isGdIpoCandidate("比亚迪发布2026年半年报"), false);
});

test("isGdIpoCandidate: 赛事/招聘「路演」不是 IPO 线索（2026-11-19 回归）", () => {
  // 11-19 实锤：「"赢在广州"复赛路演走进华农，超千岗位送进校园」同时含广东锚+裸「路演」，
  // 被误判为 IPO 并进 sections.ipo + 口播 + 企微推送。裸「路演」必须改为配对词。
  assert.equal(isGdIpoCandidate("“赢在广州”复赛路演走进华农，超千岗位送进校园"), false);
  assert.equal(isGdIpoCandidate("科创项目集中亮相！两大青年创业赛复赛路演在广州举办"), false);
  assert.equal(isGdIpoCandidate("创业项目路演对接会在深圳举行，百余岗位现场招聘"), false);
  assert.equal(isGdIpoCandidate("广州双选会路演活动走进高校，提供上千岗位"), false);
  // 裸「路演」单词即便带广东锚也不命中
  assert.equal(isGdIpoCandidate("广州某公司举办路演活动"), false);
});

test("isGdIpoCandidate: 真 IPO 路演配对词仍召回（去裸词不降召回）", () => {
  assert.equal(isGdIpoCandidate("云豹智能IPO路演，注册地广东深圳，拟登陆创业板"), true);
  assert.equal(isGdIpoCandidate("国泰海通保荐，首次公开发行股票网上路演，注册地广东广州"), true);
  assert.equal(isGdIpoCandidate("粤芯半导体新股路演推介会即将举行"), true);
});

test("detectGdIpo: 名单企业名命中的标题（无广东/广州字样）能捞到播报线索", () => {
  const items = [
    { title_cn: "粤芯半导体：注册申请材料已受理（拟创业板）", summary: "东财在审表更新" },
    { title_cn: "非广东企业IPO动态", summary: "某某全国企业" },
  ];
  const clues = detectGdIpo(items as never);
  assert.equal(clues.length, 1);
  assert.ok(clues[0].includes("粤芯半导体"));
});

test("detectGdIpo: 空输入 → 空线索", () => {
  assert.deepEqual(detectGdIpo([]), []);
});

test("IPO_PROGRESS_RE: enrich 与 voice 两份口径逐字一致，且路演为配对词（2026-11-19）", () => {
  // 两份正则必须逐字相同（voice 注释自称「逐字移植」）；一旦漂移，卡片归栏与口播判定会打架。
  assert.equal(VOICE_IPO_RE.source, HEURISTICS_IPO_RE.source);
  // 裸「路演」绝不命中（赛事/招聘误配源）；配对词命中。
  assert.equal(HEURISTICS_IPO_RE.test("复赛路演走进华农"), false);
  assert.equal(HEURISTICS_IPO_RE.test("创业赛路演"), false);
  for (const phrase of [
    "IPO路演", "ipo路演", "新股路演", "首发路演", "网上路演",
    "网下路演", "发行路演", "路演推介", "路演询价",
  ]) {
    assert.equal(HEURISTICS_IPO_RE.test(phrase), true, `${phrase} 应命中`);
  }
});
