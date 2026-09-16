import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGdIpoSpoken,
  pickGdIpoCompanies } from "../lib/pipeline/side-outputs/side-gd-ipo";
import { companyNameOf } from "../lib/services/classify/gd-ipo-spoken";
import { recordIpoVoicing, ipoShouldSkip, emptyMemory } from "../lib/services/memory/event-memory";
import { assembleBriefingScript } from "../lib/services/voice";
import type { ReportItem, DailyReport } from "../lib/contracts/report";
import type { ExecutiveSummary } from "../lib/services/enrich/executive-summary";

/** 今天的 MM/DD：口播候选有「2 天窗」，硬编码日期会随真实日期漂移而失败。 */
function todayMmdd(): string {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function item(title: string, opts: { tags?: string[]; summary?: string } = {}): ReportItem {
  return {
    url: "https://example.com/" + encodeURIComponent(title),
    title_cn: title,
    source: "test",
    source_type: "official",
    tier: "T1",
    date: todayMmdd(),
    summary: opts.summary ?? "",
    importance: 2,
    rank: 0,
    tags: opts.tags ?? ["粤"],
    locale: "national" } as ReportItem;
}

test("companyNameOf 去掉（拟XX）/[派出机构]等修饰", () => {
  assert.equal(companyNameOf("尚睿科技：IPO已受理（拟A股）"), "尚睿科技");
  assert.equal(companyNameOf("粤芯半导体（广州）[派出机构]：注册生效"), "粤芯半导体");
});

test("buildGdIpoSpoken 跳过 skipCompanies 中的企业", () => {
  const items = [
    item("尚睿科技：IPO已受理（拟A股）"),
    item("粤芯半导体：注册生效（拟科创板）"),
    item("格林美：IPO问询（拟创业板）"),
  ];
  const spoken = buildGdIpoSpoken(items, { skipCompanies: new Set(["尚睿科技"]) });
  assert.ok(spoken.includes("粤芯半导体"), "未被跳过企业应出现");
  assert.ok(!spoken.includes("尚睿科技"), "被跳过企业不应出现");
});

test("pickGdIpoCompanies 返回跳过后的前 2 家", () => {
  const items = [
    item("尚睿科技：IPO已受理（拟A股）"),
    item("粤芯半导体：注册生效（拟科创板）"),
    item("格林美：IPO问询（拟创业板）"),
  ];
  const picked = pickGdIpoCompanies(items, { skipCompanies: new Set(["尚睿科技"]) });
  assert.deepEqual(picked, ["粤芯半导体", "格林美"]);
});

test("ipoShouldSkip：窗口内口播满 2 天即跳过", () => {
  let mem = emptyMemory();
  mem = recordIpoVoicing(mem, ["尚睿科技"], "2026-09-09");
  mem = recordIpoVoicing(mem, ["尚睿科技"], "2026-09-10");
  // D3：最近 2 天内已口播 2 天 → 跳过
  assert.equal(ipoShouldSkip(mem, "尚睿科技", "2026-09-11"), true);
  // 另一企业从未口播 → 不跳过
  assert.equal(ipoShouldSkip(mem, "粤芯半导体", "2026-09-11"), false);
});

test("ipoShouldSkip：仅口播 1 天不跳过（允许连续 2 天播报）", () => {
  let mem = emptyMemory();
  mem = recordIpoVoicing(mem, ["尚睿科技"], "2026-09-10");
  assert.equal(ipoShouldSkip(mem, "尚睿科技", "2026-09-11"), false);
});

test("recordIpoVoicing 超期日期被裁剪（>7 天）", () => {
  let mem = emptyMemory();
  mem = recordIpoVoicing(mem, ["尚睿科技"], "2026-09-01"); // 距 09-10 为 9 天 > 7
  const mem2 = recordIpoVoicing(mem, ["尚睿科技"], "2026-09-10");
  const dates = mem2.ipoVoicing?.["尚睿科技"] ?? [];
  assert.deepEqual(dates, ["2026-09-10"], "超期日期应被丢弃");
});

// ---------------------------------------------------------------------------
// 口播 IPO 段必须与卡面严格同窗同源（2026-09-16 事故回归）
//
// 事故：口播播了「优邦科技」（卡面日期 09/14），但当日 IPO 卡全部落在 09/10–09/14、
// 2 日口播窗（09/15–09/16）内一张都没有 → 「播了 IPO 却没有卡片」。
// 成因：确定性拼装（2 日窗口）为空后，回落到 exec 的 guangdong_ipo 槽位，
// 而该槽位的 IPO 池是 **7 天窗口**（exec-pool.buildIpoPool）→ 窗口外内容被塞进口播；
// 且音频段的 refs 硬编码 []，与卡面建立不了对应。
// 修法：① 窗口内 0 候选 → 整段不播；② refs 带上被播报卡片的 url；
//       ③ exec 回落仅当「提到的企业全在窗口候选内」。
// ---------------------------------------------------------------------------

/** 相对报告日的 MM/DD（daysAgo=0 → 报告日当天）。 */
function mmddFrom(reportDate: string, daysAgo: number): string {
  const base = Date.parse(`${reportDate}T00:00:00Z`);
  const d = new Date(base - daysAgo * 86_400_000);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}

function reportWith(ipoItems: ReportItem[], date: string): DailyReport {
  return {
    date,
    hero_line: "",
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: ipoItems },
  } as unknown as DailyReport;
}

/** 仅含「定调」的执行摘要：用于通过 found===0 的前置校验（不对 IPO 段做任何输入）。 */
const EXEC_HERO_ONLY = {
  hero_line: "定调",
  must_read: [],
  insights: [],
  spoken_hero: "今日定调：这是一段用于通过前置校验的口播内容。",
} as unknown as ExecutiveSummary;

const UBANG_SPOKEN =
  "广东企业优邦科技IPO注册生效，拟登陆创业板，保荐机构为申万宏源承销保荐，注册地为广东，可跟进其上市后募资与员工代发等综合金融需求。";

test("口播IPO：窗口内无候选 → 整段不播（exec 槽位提到窗口外企业也丢弃）〔事故回归〕", async () => {
  const D = "2026-09-16";
  // 卡面日期 09/14：超出 2 日口播窗（09/15–09/16）
  const stale = { ...item("优邦科技：IPO注册生效（拟创业板）"), date: mmddFrom(D, 2) };
  const exec = { ...EXEC_HERO_ONLY, guangdong_ipo: { spoken: UBANG_SPOKEN } } as ExecutiveSummary;

  const res = await assembleBriefingScript(reportWith([stale], D), { exec });

  assert.ok(res, "其它段存在时不应整体返回 null");
  assert.equal(res.parts.guangdong_ipo, undefined, "窗口内无候选 → 不得产出 IPO 口播段");
  assert.equal(res.segments.some((s) => s.id === "ipo"), false, "不得生成 ipo 音频段");
  assert.equal(res.script.includes("优邦科技"), false, "口播稿不得出现窗口外企业");
});

test("口播IPO：窗口内有候选 → 播报，且 ipo 段 refs 带上对应卡片 url", async () => {
  const D = "2026-09-16";
  const fresh = { ...item("优邦科技：IPO注册生效（拟创业板）"), date: mmddFrom(D, 0) };

  const res = await assembleBriefingScript(reportWith([fresh], D), { exec: EXEC_HERO_ONLY });

  assert.ok(res);
  assert.ok(res.parts.guangdong_ipo?.includes("优邦科技"), "窗口内候选应被口播");
  const seg = res.segments.find((s) => s.id === "ipo");
  assert.ok(seg, "应生成 ipo 音频段");
  assert.deepEqual(seg.refs, [fresh.url], "IPO 段 refs 应为卡片 url（不再硬编码空数组）");
});

