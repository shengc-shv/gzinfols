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
