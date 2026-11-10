/**
 * P1 回归（2026-11-10 sc）：企微推送「🏦 广东IPO」行必须与口播段逐字同源。
 *
 * 事故：store.executive.guangdong_ipo.spoken 原本是 exec 的 LLM 稿（从 2 天窗全量池
 * 自行挑企业），口播段由 pickSpokenItems 按 BIZ_VALUE_RANK 确定性选 3 席 → 11-10
 * 实测推送讲「保伦注册生效 / 钶锐锶今天上市」、口播讲「蜂巢辅导备案 / 盛凌辅导验收」，
 * 两条外发通道讲了两拨公司。
 *
 * 修法：组合根在 voice 拼装后调 writeIpoSpokenStore，把口播实际使用的段写回该字段。
 * 本文件锁住：① 字段级 read-modify-write 不清空其它数据；② corrupt/missing 拒写；
 * ③ 端到端「口播 → store → 推送」同源；④ 口播无 IPO 段时推送整行消失。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeIpoSpokenStore } from "../lib/adapters/persistence";
import { assembleBriefingScript } from "../lib/services/voice";
import { buildWecomText } from "../lib/adapters/notify/wecom";
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

test("writeIpoSpokenStore：只改 spoken，保留 executive 其它字段与 store 顶层字段", () => {
  const base = tmpStore({
    hero_line: "定调",
    must_read: [],
    insights: [],
    guangdong_ipo: { spoken: "LLM 旧稿：保伦注册生效、钶锐锶今天上市", note: "原槽位附加字段" },
  });
  const spoken = "口播稿：蜂巢辅导备案；盛凌辅导验收；等4家";
  writeIpoSpokenStore(DATE, spoken, { baseDir: base });

  const s = readStore(base);
  assert.equal(s.executive.guangdong_ipo.spoken, spoken);
  assert.equal(s.executive.guangdong_ipo.note, "原槽位附加字段", "原槽位其它字段应保留");
  assert.equal(s.executive.hero_line, "定调");
  assert.deepEqual(s.stock_recap, { aShare: { overview: "沪指收涨" } }, "stock_recap 不得被清空");
  assert.equal(s.stock_news.length, 1, "stock_news 不得被清空");
  assert.deepEqual(s.deliveries, ["2026-11-09"], "送达记录不得被清空");
});

test("writeIpoSpokenStore：原 guangdong_ipo 缺失 / 为 null → 补建", () => {
  for (const slot of [undefined, null, "bad"]) {
    const base = tmpStore({ hero_line: "定调", must_read: [], insights: [], guangdong_ipo: slot });
    writeIpoSpokenStore(DATE, "口播稿", { baseDir: base });
    assert.equal(readStore(base).executive.guangdong_ipo.spoken, "口播稿");
  }
});

test("writeIpoSpokenStore：store 缺失 / JSON 损坏 / executive 非法 → 拒写", () => {
  // ① 文件根本不存在：不得凭空造半个 store
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), "gz-ipo-missing-"));
  writeIpoSpokenStore(DATE, "口播稿", { baseDir: missing });
  assert.equal(fs.existsSync(storePath(missing)), false, "missing → 不得新建 store.json");

  // ② 损坏：内容保持原样，绝不静默重建
  const corrupt = fs.mkdtempSync(path.join(os.tmpdir(), "gz-ipo-corrupt-"));
  fs.mkdirSync(path.dirname(storePath(corrupt)), { recursive: true });
  fs.writeFileSync(storePath(corrupt), "{broken json", "utf8");
  writeIpoSpokenStore(DATE, "口播稿", { baseDir: corrupt });
  assert.equal(fs.readFileSync(storePath(corrupt), "utf8"), "{broken json", "corrupt → 拒写");

  // ③ executive 不是对象 → 拒写
  const badExec = tmpStore("not-an-object" as unknown as Record<string, unknown>);
  writeIpoSpokenStore(DATE, "口播稿", { baseDir: badExec });
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

test("端到端：口播 → store → 推送行逐字同源，不再讲 LLM 稿里那拨公司", async () => {
  const exec = execWithLlmDraft();
  const briefing = await assembleBriefingScript(reportWith(ipoItems()), { exec });
  assert.ok(briefing, "有定调段时不应整体返回 null");

  const spoken = briefing.parts?.guangdong_ipo ?? "";
  assert.ok(spoken.length > 0, "2 天窗内有候选 → 应产出口播 IPO 段");
  assert.ok(spoken.includes("蜂巢互联"), "商机序最高的辅导备案应进口播");
  assert.ok(!spoken.includes("保伦股份"), "注册生效排第 4，应被 3 席挤出");

  const base = tmpStore(exec as unknown as Record<string, unknown>);
  writeIpoSpokenStore(DATE, spoken, { baseDir: base });

  const store = readStore(base);
  assert.equal(store.executive.guangdong_ipo.spoken, spoken, "store 应逐字等于口播段");
  const push = buildWecomText(
    store.executive.hero_line,
    DATE,
    URL,
    store.executive.guangdong_ipo.spoken,
  );
  assert.ok(push.includes("🏦 广东IPO｜"), "推送应有广东IPO 行");
  assert.ok(push.includes(spoken.slice(0, 20)), "推送行应逐字包含口播段开头");
  assert.ok(!push.includes("钶锐锶"), "推送不得再讲口播没念的企业");
  assert.ok(!push.includes(LLM_IPO_DRAFT), "LLM 旧稿不得泄漏到推送");
});

test("口播无 IPO 段 → 写空串 → 推送整行消失（杜绝口播不念、推送照念）", () => {
  const base = tmpStore({
    hero_line: "定调",
    must_read: [],
    insights: [],
    guangdong_ipo: { spoken: LLM_IPO_DRAFT },
  });
  // 组合根约定：parts 无 guangdong_ipo 时传 ""（本测试等价于该调用）
  writeIpoSpokenStore(DATE, "", { baseDir: base });

  const store = readStore(base);
  assert.equal(store.executive.guangdong_ipo.spoken, "");
  const push = buildWecomText(
    store.executive.hero_line,
    DATE,
    URL,
    store.executive.guangdong_ipo.spoken,
  );
  assert.ok(!push.includes("🏦 广东IPO"), "口播没念 IPO → 推送不得出该行");
  assert.ok(!push.includes("钶锐锶"));
});
