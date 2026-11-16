/**
 * P1 回归（2026-11-10 sc）：企微推送「🏦 广东IPO」行必须与口播讲同一拨企业，
 * 且要**精简**——不带「今天的」、工商全称、「XX行业」这类口播体裁。
 *
 * 事故：store.executive.guangdong_ipo.spoken 原本是 exec 的 LLM 稿（从 2 天窗全量池
 * 自行挑企业），口播段由 pickSpokenItems 按 BIZ_VALUE_RANK 确定性选 3 席 → 11-10
 * 实测推送讲「保伦注册生效 / 钶锐锶今天上市」、口播讲「蜂巢辅导备案 / 盛凌辅导验收」，
 * 两条外发通道讲了两拨公司。
 *
 * 修法：组合根在 voice 拼装后，把同一批 selected 压成「简称+阶段标签」写回 push_line；
 * spoken（LLM 稿）保留不动，避免重跑污染口播第 ③ 兜底的输入。
 * 本文件锁住：① 字段级 read-modify-write 不清空其它数据；② corrupt/missing 拒写；
 * ③ 端到端「口播 → store → 推送」企业集同源 + 精简体裁；④ 口播无 IPO 段时推送整行消失；
 * ⑤ 真实工商全称的简称剥离。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeIpoPushLineStore } from "../lib/adapters/persistence";
import { assembleBriefingScript } from "../lib/services/voice";
import { buildWecomText } from "../lib/adapters/notify/wecom";
import { buildGdIpoPushLine, ipoCompanyShortOf, pickSpokenItems } from "../lib/services/classify/gd-ipo-spoken";
import type { DailyReport, ReportItem } from "../lib/contracts/report";
import type { ExecutiveSummary } from "../lib/services/enrich/executive-summary";

const DATE = "2026-11-10";
const URL = "https://example.com/report";

/** 造一份带其它顶层字段的 store，验证写回不会整份覆盖。 */
function tmpStore(executive: Record<string, unknown>): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gz-ipo-push-"));
  const dir = path.join(base, "history", DATE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "store.json"),
    JSON.stringify(
      {
        date: DATE,
        updatedAt: "2026-11-10T00:00:00.000Z",
        executive,
        stock_recap: { aShare: { overview: "沪指收涨" } },
        stock_news: [{ title: "保留字段" }],
        deliveries: ["2026-11-09"],
      },
      null,
      2,
    ),
    "utf8",
  );
  return base;
}

function storePath(base: string): string {
  return path.join(base, "history", DATE, "store.json");
}

function readStore(base: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(storePath(base), "utf8"));
}

test("writeIpoPushLineStore：只加 push_line，保留 spoken 与 store 顶层字段", () => {
  const base = tmpStore({
    hero_line: "定调",
    must_read: [],
    insights: [],
    guangdong_ipo: { spoken: "LLM 旧稿：保伦注册生效、钶锐锶今天上市", note: "原槽位附加字段" },
  });
  const line = "蜂巢互联辅导备案、盛凌电子辅导完成（共4家）";
  writeIpoPushLineStore(DATE, line, { baseDir: base });

  const s = readStore(base);
  assert.equal(s.executive.guangdong_ipo.push_line, line);
  assert.equal(
    s.executive.guangdong_ipo.spoken,
    "LLM 旧稿：保伦注册生效、钶锐锶今天上市",
    "spoken 必须原样保留（口播第 ③ 兜底的输入，重跑不得漂移）",
  );
  assert.equal(s.executive.guangdong_ipo.note, "原槽位附加字段", "原槽位其它字段应保留");
  assert.equal(s.executive.hero_line, "定调");
  assert.deepEqual(s.stock_recap, { aShare: { overview: "沪指收涨" } }, "stock_recap 不得被清空");
  assert.equal(s.stock_news.length, 1, "stock_news 不得被清空");
  assert.deepEqual(s.deliveries, ["2026-11-09"], "送达记录不得被清空");
});

test("writeIpoPushLineStore：原 guangdong_ipo 缺失 / 为 null → 补建", () => {
  for (const slot of [undefined, null, "bad"]) {
    const base = tmpStore({ hero_line: "定调", must_read: [], insights: [], guangdong_ipo: slot });
    writeIpoPushLineStore(DATE, "精简行", { baseDir: base });
    assert.equal(readStore(base).executive.guangdong_ipo.push_line, "精简行");
  }
});

test("writeIpoPushLineStore：store 缺失 / JSON 损坏 / executive 非法 → 拒写", () => {
  // ① 文件根本不存在：不得凭空造半个 store
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), "gz-ipo-missing-"));
  writeIpoPushLineStore(DATE, "精简行", { baseDir: missing });
  assert.equal(fs.existsSync(storePath(missing)), false, "missing → 不得新建 store.json");

  // ② 损坏：内容保持原样，绝不静默重建
  const corrupt = fs.mkdtempSync(path.join(os.tmpdir(), "gz-ipo-corrupt-"));
  fs.mkdirSync(path.dirname(storePath(corrupt)), { recursive: true });
  fs.writeFileSync(storePath(corrupt), "{broken json", "utf8");
  writeIpoPushLineStore(DATE, "精简行", { baseDir: corrupt });
  assert.equal(fs.readFileSync(storePath(corrupt), "utf8"), "{broken json", "corrupt → 拒写");

  // ③ executive 不是对象 → 拒写
  const badExec = tmpStore("not-an-object" as unknown as Record<string, unknown>);
  writeIpoPushLineStore(DATE, "精简行", { baseDir: badExec });
  assert.equal(readStore(badExec).executive, "not-an-object", "executive 非法 → 拒写");
});

/** 口播候选：3 条辅导类（商机序最高）+ 1 条注册生效（排第 4，被 3 席挤出）。 */
function ipoItems(): ReportItem[] {
  const rows: Array<[string, string, string]> = [
    ["蜂巢互联：IPO辅导备案（拟创业板）", "11/10", "注册地：广东深圳市｜状态：辅导备案"],
    ["盛凌电子：辅导验收（拟北交所）", "11/10", "注册地：广东深圳市｜状态：辅导验收"],
    ["天华机器：辅导验收（拟创业板）", "11/10", "注册地：广东深圳市｜状态：辅导验收"],
    ["保伦股份：IPO注册生效（拟主板）", "11/09", "注册地：广东广州市｜状态：注册生效"],
  ];
  return rows.map(([title_cn, date, summary]) => ({
    url: `https://example.com/${encodeURIComponent(title_cn)}`,
    title_cn,
    summary,
    date,
    tags: ["粤"],
    source: "test",
    source_type: "official",
    tier: "T1",
    importance: 2,
    rank: 0,
    locale: "national",
  }) as unknown as ReportItem);
}

function reportWith(items: ReportItem[]): DailyReport {
  return {
    date: DATE,
    hero_line: "",
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: items },
  } as unknown as DailyReport;
}

/** LLM 稿刻意提到一拨口播根本不会念的企业（11-10 线上真实形态）。 */
const LLM_IPO_DRAFT = "保伦股份IPO注册生效、钶锐锶今天上市，两家粤企登陆资本市场。";

function execWithLlmDraft(): ExecutiveSummary {
  return {
    hero_line: "定调",
    must_read: [],
    insights: [],
    spoken_hero: "今日定调：这是一段用于通过前置校验的口播内容。",
    guangdong_ipo: { spoken: LLM_IPO_DRAFT },
  } as unknown as ExecutiveSummary;
}

test("端到端：口播 → store.push_line → 推送行同源且精简（不带口播体裁）", async () => {
  const exec = execWithLlmDraft();
  const briefing = await assembleBriefingScript(reportWith(ipoItems()), { exec });
  assert.ok(briefing, "有定调段时不应整体返回 null");

  const spoken = briefing.parts?.guangdong_ipo ?? "";
  assert.ok(spoken.length > 0, "2 天窗内有候选 → 应产出口播 IPO 段");
  assert.ok(spoken.includes("蜂巢互联"), "商机序最高的辅导备案应进口播");
  assert.ok(!spoken.includes("保伦股份"), "注册生效排第 4，应被 3 席挤出");

  const line = briefing.ipoPushLine ?? "";
  assert.ok(line.length > 0, "有口播 IPO 段就应有推送精简行");
  assert.ok(line.length < 80, `精简行应显著短于口播稿（实得 ${line.length} 字）`);
  for (const company of ["蜂巢互联", "盛凌电子", "天华机器"]) {
    assert.ok(line.includes(company), `推送行应点名口播念到的 ${company}`);
  }
  assert.ok(!line.includes("保伦股份"), "推送不得再讲口播没念的企业");
  assert.ok(!line.includes("钶锐锶"));
  assert.ok(!line.includes(LLM_IPO_DRAFT), "LLM 旧稿不得泄漏到推送");
  // sc 11-10 口径：口播体裁不进推送
  assert.ok(!line.includes("今天的") && !line.includes("昨天"), "不得带相对日口播前缀");
  assert.ok(!line.includes("行业"), "不得带「XX行业」听觉冗余");
  assert.ok(!line.includes("注册地") && !line.includes("目前"), "不得带注册地/进展描述");
  assert.ok(line.includes("（共4家）"), "候选 4 家、只念 3 家 → 标注总数");

  const base = tmpStore(exec as unknown as Record<string, unknown>);
  writeIpoPushLineStore(DATE, line, { baseDir: base });

  const store = readStore(base);
  assert.equal(store.executive.guangdong_ipo.push_line, line, "store 应逐字等于精简行");
  assert.equal(store.executive.guangdong_ipo.spoken, LLM_IPO_DRAFT, "spoken 原稿不得被覆盖");
  // notify-daily.ts 的取值口径：push_line ?? spoken ?? ""
  const ipoLine = store.executive.guangdong_ipo.push_line ?? store.executive.guangdong_ipo.spoken ?? "";
  const push = buildWecomText(store.executive.hero_line, DATE, URL, ipoLine);
  assert.ok(push.includes("🏦 广东IPO｜"), "推送应有广东IPO 行");
  assert.ok(push.includes(line), "精简行应完整进推送（不被 80 字硬切）");
  assert.ok(!push.includes("钶锐锶"), "推送不得再讲口播没念的企业");
});

test("口播无 IPO 段 → push_line 写空串 → 推送整行消失（杜绝口播不念、推送照念）", () => {
  const base = tmpStore({
    hero_line: "定调",
    must_read: [],
    insights: [],
    guangdong_ipo: { spoken: LLM_IPO_DRAFT },
  });
  // 组合根约定：briefing 无 ipoPushLine 时传 ""（本测试等价于该调用）
  writeIpoPushLineStore(DATE, "", { baseDir: base });

  const store = readStore(base);
  assert.equal(store.executive.guangdong_ipo.push_line, "");
  const ipoLine = store.executive.guangdong_ipo.push_line ?? store.executive.guangdong_ipo.spoken ?? "";
  const push = buildWecomText(store.executive.hero_line, DATE, URL, ipoLine);
  assert.ok(!push.includes("🏦 广东IPO"), "口播没念 IPO → 推送不得出该行");
  assert.ok(!push.includes("钶锐锶"));
});

/** 11-10 线上真实标题：无冒号分隔、工商全称 + 进展词直接连写。 */
function realTitleItems(): ReportItem[] {
  const rows: Array<[string, string]> = [
    ["深圳蜂巢互联科技股份有限公司辅导备案", "深圳蜂巢互联科技完成辅导备案，深圳科技企业进入上市准备期。"],
    ["深圳盛凌电子股份有限公司北交所上市辅导验收", "深圳盛凌电子北交所上市辅导验收，深圳电子企业上市进程推进。"],
    ["深圳天华机器设备股份有限公司 (辅导验收) [深圳证监局]", "IPO辅导备案 | 状态: 辅导验收 | 报告: 辅导工作完成报告"],
    ["保伦股份：IPO注册生效（拟主板）", "广州保伦股份IPO注册生效、拟主板。"],
  ];
  return rows.map(([title_cn, summary]) => ({
    url: `https://example.com/${encodeURIComponent(title_cn)}`,
    title_cn,
    summary,
    date: "11/10",
    tags: ["粤"],
  }) as unknown as ReportItem);
}

test("真实工商全称 → 推送用简称，不带「股份有限公司 / 今天的 / 行业」", () => {
  const items = realTitleItems();
  assert.equal(ipoCompanyShortOf(items[0]), "蜂巢互联科技");
  assert.equal(ipoCompanyShortOf(items[1]), "盛凌电子");
  assert.equal(ipoCompanyShortOf(items[2]), "天华机器设备");
  assert.equal(ipoCompanyShortOf(items[3]), "保伦股份");

  const pick = pickSpokenItems(items, { today: DATE });
  const line = buildGdIpoPushLine(pick.selected, { totalCandidates: pick.totalCandidates });
  assert.ok(line.includes("蜂巢互联科技") && line.includes("盛凌电子") && line.includes("天华机器设备"));
  assert.ok(!line.includes("股份有限公司") && !line.includes("有限公司"), "不得带工商全称后缀");
  assert.ok(!line.includes("深圳"), "不得带地区前缀");
  assert.ok(!line.includes("辅导验收"), "阶段标签用徽章真源「辅导完成」，不带标题里的进展词");
  assert.ok(line.length < 80);
});

test("spokenText 截断保护：只列真正被念到的企业；全不匹配时回退全部", () => {
  const pick = pickSpokenItems(ipoItems(), { today: DATE });
  const truncated = "今天的蜂巢互联，注册地广东深圳市，科技行业，目前辅导备案";
  const short = buildGdIpoPushLine(pick.selected, {
    totalCandidates: pick.totalCandidates,
    spokenText: truncated,
  });
  assert.ok(short.includes("蜂巢互联"));
  assert.ok(!short.includes("盛凌电子") && !short.includes("天华机器"), "被截断没念到的不得进推送");
  assert.ok(short.includes("（共4家）"));

  const fallback = buildGdIpoPushLine(pick.selected, {
    totalCandidates: pick.totalCandidates,
    spokenText: "LLM 兜底稿：另有进展，未点名任何企业。",
  });
  assert.equal(fallback.split("、").length, 3, "兜底路径不得让推送行消失");
});

test("buildGdIpoPushLine 边界：无选中 → 空串；候选全念完 → 不加「共N家」", () => {
  assert.equal(buildGdIpoPushLine([]), "");
  const pick = pickSpokenItems(ipoItems().slice(0, 3), { today: DATE });
  const line = buildGdIpoPushLine(pick.selected, { totalCandidates: pick.totalCandidates });
  assert.ok(!line.includes("共"), "3 席全念完不应再标总数");
});
