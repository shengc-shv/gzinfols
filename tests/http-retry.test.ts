/**
 * HTTP 适配器重试口径（2026-10-04 sc「R5 重试 3 次」）。
 *
 * 守护的行为：
 *  - ✅ 5xx / 429 / 网络错误 / 超时 → **总尝试 3 次**（退避 800ms → 2000ms）
 *  - ⛔ 其余 4xx → **只试 1 次**（客户端错误，重试只会放大压力）
 *  - 成功即返回，不多余重试
 *  - 3 次都失败 → 抛出**最后一次**错误（调用方 `Promise.allSettled` 负责隔离）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FetchAdapter } from "../lib/adapters/http";

/** 替换 globalThis.fetch，按脚本依次返回；记录调用次数。 */
function stubFetch(handlers: Array<() => Promise<unknown>>) {
  const orig = globalThis.fetch;
  const calls: string[] = [];
  let i = 0;
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url));
    const h = handlers[Math.min(i, handlers.length - 1)]!;
    i++;
    return h();
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

const res = (code: number, body = "") =>
  Promise.resolve({ ok: code >= 200 && code < 300, status: code, text: async () => body });
const netErr = () => Promise.reject(new Error("ECONNRESET"));

test("5xx：重试到 3 次后抛出（不无限重试）", async () => {
  const s = stubFetch([() => res(503)]);
  try {
    await assert.rejects(() => new FetchAdapter().getText("https://x.test/a"), /HTTP 503/);
    assert.equal(s.calls.length, 3, `应恰好尝试 3 次，实际 ${s.calls.length}`);
  } finally {
    s.restore();
  }
});

test("4xx（除 429）：只试 1 次 —— 客户端错误重试无意义", async () => {
  const s = stubFetch([() => res(404)]);
  try {
    await assert.rejects(() => new FetchAdapter().getText("https://x.test/b"), /HTTP 404/);
    assert.equal(s.calls.length, 1, `404 不应重试，实际 ${s.calls.length} 次`);
  } finally {
    s.restore();
  }
});

test("429（限流）：重试到 3 次", async () => {
  const s = stubFetch([() => res(429)]);
  try {
    await assert.rejects(() => new FetchAdapter().getText("https://x.test/c"), /HTTP 429/);
    assert.equal(s.calls.length, 3, `429 应重试，实际 ${s.calls.length} 次`);
  } finally {
    s.restore();
  }
});

test("网络错误：重试到 3 次", async () => {
  const s = stubFetch([netErr]);
  try {
    await assert.rejects(() => new FetchAdapter().getText("https://x.test/d"), /ECONNRESET/);
    assert.equal(s.calls.length, 3, `网络错误应重试，实际 ${s.calls.length} 次`);
  } finally {
    s.restore();
  }
});

test("首次成功：只调 1 次并返回正文", async () => {
  const s = stubFetch([() => res(200, "BODY")]);
  try {
    const out = await new FetchAdapter().getText("https://x.test/e");
    assert.equal(out, "BODY");
    assert.equal(s.calls.length, 1);
  } finally {
    s.restore();
  }
});

test("第 2 次成功：共 2 次后成功（不继续重试）", async () => {
  const s = stubFetch([() => res(500), () => res(200, "OK2")]);
  try {
    const out = await new FetchAdapter().getText("https://x.test/f");
    assert.equal(out, "OK2");
    assert.equal(s.calls.length, 2, `应在第 2 次成功，实际 ${s.calls.length} 次`);
  } finally {
    s.restore();
  }
});
