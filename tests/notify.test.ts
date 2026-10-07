/**
 * 外发渠道单元测试（自 gzinfo tests/notify-wechat.test.ts 移植并扩展，2026-09-15；
 * 2026-09-17 移除公众号与企微自建应用用例 —— 两通道已永久下线，仅保留群机器人）。
 *
 * 覆盖：群机器人 webhook 发送与错误收集 / 文案组装（markdown 与 text）。
 *
 * 全部走注入的 fake fetch —— 零真实网络、零 mock 全局。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildWecomMarkdown,
  buildWecomText,
  marketLinesOf,
  pushWecomWebhook,
} from "../lib/adapters/notify/wecom";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

/** 按 URL 子串匹配返回预置 JSON 的 fake fetch */
function jsonFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: FetchInput) => {
    const u = String(input);
    for (const [pat, body] of Object.entries(routes)) {
      if (u.includes(pat)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as typeof fetch;
}

test("pushWecomWebhook: text 默认（个人微信可读）+ 失败收集，@all 语序不变", async () => {
  let body: Record<string, unknown> | null = null;
  const ok = (async (input: FetchInput, init?: FetchInit) => {
    body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    return new Response(JSON.stringify({ errcode: 0 }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const r = await pushWecomWebhook("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k", "内容", "https://x", ok);
  assert.equal(r.ok, true);
  assert.equal(r.sent, 1);
  const sent = body as unknown as Record<string, unknown>;
  assert.equal(sent.msgtype, "text");
  assert.deepEqual(sent.text, { content: "内容" });

  const bad = jsonFetch({ "/cgi-bin/webhook/send?": { errcode: 93000, errmsg: "invalid webhook key" } });
  const r2 = await pushWecomWebhook("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=bad", "x", "https://x", bad);
  assert.equal(r2.ok, false);
  assert.match(r2.failed[0].reason, /errcode=93000/);
});

test("文案组装：markdown / text 都含定调、广东IPO 行与链接，且不含 markdown 语法污染 text", () => {
  const md = buildWecomMarkdown("定调A", "2026-09-01", "https://x/2026-09-01/2026-09-01.html", "海柔创新递表");
  assert.ok(md.includes("📢 今日分行简报已生成"));
  assert.ok(md.includes("> **【今日定调】** 定调A"));
  assert.ok(md.includes("🏦 广东IPO｜海柔创新递表"));
  assert.ok(md.includes("[点击查看完整简报 →](https://x/2026-09-01/2026-09-01.html)"));

  const txt = buildWecomText("定调A", "2026-09-01", "https://x/2026-09-01/2026-09-01.html", "海柔创新递表");
  assert.ok(txt.includes("【今日定调】定调A"));
  assert.ok(txt.includes("https://x/2026-09-01/2026-09-01.html"));
  // text 版不得含 markdown 标记（微信端会原样显示成噪音）
  assert.ok(!txt.includes("**") && !txt.includes("[") && !txt.includes("# "));

  // 无定调兜底
  assert.ok(buildWecomText("", "2026-09-01", "https://x").includes("今日暂无定调"));
  assert.ok(buildWecomMarkdown("", "2026-09-01", "https://x").includes("今日暂无定调"));
  // 超长 IPO 行截断 80 字
  const longIpo = buildWecomText("A", "2026-09-01", "https://x", "广".repeat(100));
  assert.ok(longIpo.includes("…"));
});

// ---------------------------------------------------------------------------
// 2026-10-07 sc 口径：新增「风险行」（30 字截断）与「股市通报行」（每市场一行），均可选
// ---------------------------------------------------------------------------

test("风险行：有主题才出现，30 字截断；无风险 → 整行不出现（可选）", () => {
  const withRisk = buildWecomText("定调A", "2026-10-01", "https://x", undefined, {
    riskTopic: "韩国多家银行客户数据泄露",
  });
  assert.ok(withRisk.includes("🚨 风险提示｜韩国多家银行客户数据泄露"));

  // 30 字截断
  const long = buildWecomText("定调A", "2026-10-01", "https://x", undefined, {
    riskTopic: "风".repeat(40),
  });
  assert.ok(long.includes(`🚨 风险提示｜${"风".repeat(30)}…`), `应截到 30 字：${long}`);

  const noRisk = buildWecomText("定调A", "2026-10-01", "https://x", undefined, { riskTopic: "" });
  assert.ok(!noRisk.includes("风险提示"), "无风险主题 → 不出风险行");
  // 完全不传 extra（既有调用点）→ 同样不出
  assert.ok(!buildWecomText("A", "2026-10-01", "https://x").includes("风险提示"));
});

test("股市行：三市场各一行，未开市状态取自数据自带的 fresh 标记", () => {
  const lines = marketLinesOf({
    aShare: { indices: [{ name: "上证指数", value: "3842.20", changePct: "+0.31%" }] },
    hk: { indices: [{ name: "恒生指数", value: "24280.56", changePct: "+1.00%" }] },
    us: { indices: [{ name: "纳斯达克", value: "27599.89", changePct: "+0.45%" }] },
    marketStatus: {
      markets: {
        aShare: { fresh: false, dataDate: "2026-09-30" },
        hk: { fresh: true, dataDate: "2026-10-06" },
        us: { fresh: true, dataDate: "2026-10-06" },
      },
    },
  });
  assert.deepEqual(lines, [
    "📈 A股｜未开市（最近 9月30日 收盘）",
    "📈 港股｜恒指 ▲1.00%",
    "📈 美股｜纳指 ▲0.45%",
  ]);
});

test("股市行：涨跌符号与指数简称（▲涨 / ▼跌，中国口径不依赖颜色）", () => {
  const [line] = marketLinesOf({
    aShare: {
      indices: [
        { name: "上证指数", changePct: "+0.31%" },
        { name: "深证成指", changePct: "-0.11%" },
        { name: "创业板指", changePct: "-0.23%" },
      ],
    },
  });
  assert.equal(line, "📈 A股｜上证 ▲0.31% · 深成 ▼0.11% · 创业板 ▼0.23%");
});

test("股市行：无 indices 退到 overview（50 字截断）；完全没有数据写「暂无数据」而非「未开市」", () => {
  const lines = marketLinesOf({ us: { overview: "三大指数集体收涨，标普领涨。" } });
  assert.equal(lines[2], "📈 美股｜三大指数集体收涨，标普领涨。");

  const noData = marketLinesOf({});
  assert.deepEqual(noData, ["📈 A股｜暂无数据", "📈 港股｜暂无数据", "📈 美股｜暂无数据"]);
  // 整个 stock_recap 缺失 → 整块不出现（可选）
  assert.deepEqual(marketLinesOf(null), []);
  assert.deepEqual(marketLinesOf(undefined), []);
});

test("组装顺序：定调 → 股市 → 风险 → 广东IPO → 链接；各类缺省时自动收缩", () => {
  const full = buildWecomText("定调A", "2026-10-07", "https://x", "广东IPO一行", {
    riskTopic: "某风险主题",
    stockRecap: { aShare: { indices: [{ name: "上证指数", changePct: "+0.31%" }] } },
  });
  const iHero = full.indexOf("【今日定调】");
  const iMarket = full.indexOf("📈 A股");
  const iRisk = full.indexOf("🚨 风险提示");
  const iIpo = full.indexOf("🏦 广东IPO");
  const iLink = full.indexOf("👉 点击查看完整简报");
  assert.ok(
    iHero < iMarket && iMarket < iRisk && iRisk < iIpo && iIpo < iLink,
    `顺序应为 定调 → 股市 → 风险 → IPO → 链接：\n${full}`,
  );

  // markdown 版同样含股市/风险行，且不带 4 个市场以外的噪音
  const md = buildWecomMarkdown("定调A", "2026-10-07", "https://x", undefined, {
    riskTopic: "某风险主题",
    stockRecap: { hk: { indices: [{ name: "恒生科技", changePct: "-0.94%" }] } },
  });
  assert.ok(md.includes("📈 港股｜恒生科技 ▼0.94%"));
  assert.ok(md.includes("🚨 风险提示｜某风险主题"));
});
