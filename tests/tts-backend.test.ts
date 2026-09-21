/**
 * TTS 后端注册表守护测试（2026-09-21，随「百炼 CosyVoice 后端」引入）
 *
 * 守的是四类**静默错**（不报错但结果错）：
 *  1. 缺省候选链漂移 → 生产行为变了却没人发现（缺省必须仍是 tencent,piper）；
 *  2. 候选链「隐式回退」→ 做 A/B 时拿到非目标后端的音频；
 *  3. 发音策略跨后端复用 → 腾讯 SSML 标签被送给不认它的后端（被念出来 / 报错）；
 *  4. 渲染层徽章落进 else → 公开页面上把百炼标成「开源合成」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  CosyHttpError,
  DEFAULT_BACKEND_CHAIN,
  cosyErrorKind,
  isTtsBackendName,
  looksLikeMp3,
  modelUnavailableReason,
  parseModelChain,
  resolveBackendChain,
  resolveCosyTargets,
  resolvePronounceMode,
  resolveVoice,
  synthCosyvoice,
  synthesizeAudio,
} from "../lib/adapters/tts";
import { renderHtml } from "../lib/services/render";
import type { DailyReport } from "../lib/contracts/report";

/** 临时改 env 并在回调后恢复（这些函数刻意走运行时读，就是为了能这样测）。 */
function withEnv<T>(pairs: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(pairs)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** 临时改 env 并在回调后恢复（异步版）。 */
async function withEnvAsync<T>(
  pairs: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(pairs)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("候选链：缺省 = cosyvoice,tencent,piper（百炼优先 → 腾讯兜底 → Piper 最后）", () => {
  assert.deepEqual([...DEFAULT_BACKEND_CHAIN], ["cosyvoice", "tencent", "piper"]);
  withEnv({ TTS_BACKEND: undefined }, () => {
    assert.deepEqual(resolveBackendChain(), ["cosyvoice", "tencent", "piper"], "未设 TTS_BACKEND → 缺省链");
  });
  assert.deepEqual(resolveBackendChain("   "), ["cosyvoice", "tencent", "piper"], "空白串同样走缺省链");
});

test("候选链：显式指定即**严格**（不会静默换成别的后端）", () => {
  assert.deepEqual(resolveBackendChain("cosyvoice"), ["cosyvoice"], "只写一个就只有一个");
  assert.deepEqual(resolveBackendChain("cosyvoice,piper"), ["cosyvoice", "piper"], "兜底须显式声明");
});

test("候选链：trim / 小写 / 去重 / 忽略空项", () => {
  assert.deepEqual(
    resolveBackendChain(" Tencent , COSYVOICE ,tencent, , piper "),
    ["tencent", "cosyvoice", "piper"],
  );
});

test("候选链：未知后端名必须报错（配置写错不许静默降级）", () => {
  assert.throws(() => resolveBackendChain("cosyvoise"), /未知后端.*cosyvoise/);
  assert.throws(() => resolveBackendChain("tencent,foo"), /未知后端.*foo/);
});

test("isTtsBackendName：只认三个后端名", () => {
  for (const n of ["tencent", "cosyvoice", "piper"]) assert.equal(isTtsBackendName(n), true, n);
  for (const n of ["tencent ", "TENCENT", "cosy", ""]) assert.equal(isTtsBackendName(n), false, n);
});

test("发音策略：默认值按后端解析（腾讯 SSML / 百炼汉字音译 / Piper 原样）", () => {
  withEnv(
    { TTS_PRONOUNCE: undefined, TTS_PRONOUNCE_COSYVOICE: undefined, TTS_PRONOUNCE_PIPER: undefined },
    () => {
      assert.equal(resolvePronounceMode(), "ssml-say-as", "无参 = tencent，兼容旧签名");
      assert.equal(resolvePronounceMode("tencent"), "ssml-say-as");
      assert.equal(resolvePronounceMode("cosyvoice"), "translit", "百炼默认汉字音译，不使用腾讯 SSML");
      assert.equal(resolvePronounceMode("piper"), "asis", "Piper 默认原样透传（与重构前一致）");
    },
  );
});

test("发音策略：SSML 是后端私有方言 → 在不认它的后端上被拦下并退回默认", () => {
  // 若放行，百炼会把 <speak><say-as …></say-as></speak> 当普通文本念出来（或直接报错）
  withEnv({ TTS_PRONOUNCE_COSYVOICE: "ssml-say-as" }, () => {
    assert.equal(resolvePronounceMode("cosyvoice"), "translit", "SSML 模式被拦，退回 translit");
  });
  withEnv({ TTS_PRONOUNCE_PIPER: "ssml-sub" }, () => {
    assert.equal(resolvePronounceMode("piper"), "asis", "SSML 模式被拦，退回 asis");
  });
  // 腾讯自己用 SSML 是合法的，必须放行
  withEnv({ TTS_PRONOUNCE: "ssml-sub" }, () => {
    assert.equal(resolvePronounceMode("tencent"), "ssml-sub");
  });
});

test("发音策略：非法值与合法非 SSML 值的处理", () => {
  withEnv({ TTS_PRONOUNCE_COSYVOICE: "不存在的模式" }, () => {
    assert.equal(resolvePronounceMode("cosyvoice"), "translit", "非法 → 退回默认");
  });
  withEnv({ TTS_PRONOUNCE_COSYVOICE: "punct" }, () => {
    assert.equal(resolvePronounceMode("cosyvoice"), "punct", "合法且安全 → 尊重用户设置");
  });
});

test("mp3 魔数判定：ID3 头 / 帧同步为真，wav / 空 / 短缓冲为假", () => {
  assert.equal(looksLikeMp3(Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00])), true, "ID3");
  assert.equal(looksLikeMp3(Buffer.from([0xff, 0xfb, 0x90, 0x00])), true, "MPEG 帧同步");
  assert.equal(looksLikeMp3(Buffer.from("RIFF....WAVE", "ascii")), false, "wav 不是 mp3");
  assert.equal(looksLikeMp3(Buffer.alloc(0)), false, "空缓冲");
  assert.equal(looksLikeMp3(Buffer.from([0xff])), false, "只有 1 字节");
});

test("synthesizeAudio：TTS_BACKEND 写错时快速失败，且错误信息可指导修复", async () => {
  const prev = process.env.TTS_BACKEND;
  process.env.TTS_BACKEND = "cosyvoise";
  try {
    await assert.rejects(
      () => synthesizeAudio("2026-09-21", "这".repeat(40)),
      /未知后端.*cosyvoise/,
    );
  } finally {
    if (prev === undefined) delete process.env.TTS_BACKEND;
    else process.env.TTS_BACKEND = prev;
  }
});

/** 渲染层徽章回归：新增后端不得落进 else 被标成「开源合成」。 */
test("播放器徽章：三个后端各有独立文案与 class（回归「第三个后端被标成开源合成」）", () => {
  const base = {
    date: "2026-09-21",
    hero_line: "定调",
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  } as unknown as DailyReport;

  const cases: [string, string, string][] = [
    ["tencent", "腾讯合成", "player-badge-tencent"],
    ["cosyvoice", "百炼合成", "player-badge-cosyvoice"],
    ["piper", "开源合成", "player-badge-piper"],
  ];
  for (const [backend, label, cls] of cases) {
    const html = renderHtml(base, {
      audio: { src: "audio/briefing-2026-09-21.mp3", duration: "约 2 分 0 秒", backend: backend as never },
    });
    const badge = /<span class="player-badge[^"]*"[^>]*>([^<]*)<\/span>/.exec(html);
    assert.ok(badge, `${backend} 应产出徽章`);
    assert.equal(badge[1], label, `${backend} 的徽章文案`);
    assert.ok(badge[0].includes(cls), `${backend} 的徽章 class 应为 ${cls}`);
    // 通用守卫：百炼绝不能显示成「开源合成」
    if (backend === "cosyvoice") {
      assert.ok(!badge[1].includes("开源"), "百炼不得被标成开源合成");
    }
  }

  const noBadge = renderHtml(base, {
    audio: { src: "audio/briefing-2026-09-21.mp3", duration: "约 2 分 0 秒" },
  });
  // ⚠️ 不能断言 `includes("player-badge")` —— 产物 <style> 里本来就有 .player-badge 规则，
  // 要按「元素」而非「字符串」判定。
  assert.ok(
    !noBadge.includes('<span class="player-badge'),
    "无 backend → 不产出徽章元素（保持既有行为）",
  );
});

// ---------- 百炼模型链（2026-09-21 用户定案：v3.5-plus → v3.5-flash → 腾讯兜底） ----------

test("模型链解析：缺省即用户口径 v3.5-plus → v3.5-flash", () => {
  assert.deepEqual(
    parseModelChain(undefined).map((t) => t.model),
    ["cosyvoice-v3.5-plus", "cosyvoice-v3.5-flash"],
  );
});

test("模型链解析：支持 `模型@音色ID` 逐模型指定音色（复刻音色绑定目标模型，必须能分开配）", () => {
  assert.deepEqual(parseModelChain("cosyvoice-v3.5-plus@vA,cosyvoice-v3.5-flash@vB"), [
    { model: "cosyvoice-v3.5-plus", voice: "vA" },
    { model: "cosyvoice-v3.5-flash", voice: "vB" },
  ]);
  // 未写 @音色 → 回落到 DASHSCOPE_TTS_VOICE
  assert.deepEqual(parseModelChain("cosyvoice-v3.5-plus,cosyvoice-v3.5-flash@vB", "fallbackV"), [
    { model: "cosyvoice-v3.5-plus", voice: "fallbackV" },
    { model: "cosyvoice-v3.5-flash", voice: "vB" },
  ]);
  assert.deepEqual(parseModelChain(" , cosyvoice-v3-flash , "), [
    { model: "cosyvoice-v3-flash", voice: "" },
  ]);
  assert.throws(() => parseModelChain(" , "), /未解析出任何模型/);
});

test("音色缺省：v3.5 系列没有系统音色 → 不给缺省；v3 系列给 longanyang", () => {
  assert.equal(resolveVoice({ model: "cosyvoice-v3.5-plus", voice: "" }), null, "v3.5 无系统音色");
  assert.equal(resolveVoice({ model: "cosyvoice-v3-flash", voice: "" }), "longanyang", "v3 有缺省");
  assert.equal(resolveVoice({ model: "cosyvoice-v3.5-plus", voice: "vA" }), "vA", "显式音色优先");
});

test("兼容性判定：返回原因而**不抛错**（单个模型不可用不该拖垮整条模型链）", () => {
  withEnv({ DASHSCOPE_TTS_VOICE_FORCE: undefined }, () => {
    assert.equal(modelUnavailableReason("cosyvoice-v3-flash", "longanyang"), null, "v3 + 系统音色可用");
    assert.match(modelUnavailableReason("cosyvoice-v3.5-plus", null) ?? "", /没有系统音色/);
    assert.match(
      modelUnavailableReason("cosyvoice-v3.5-plus", "longanyang") ?? "",
      /看起来是系统音色/,
      "v3.5 + 系统音色 → 给出明确原因",
    );
    assert.equal(modelUnavailableReason("cosyvoice-v3.5-plus", "myvoice-abc"), null, "v3.5 + 复刻音色可用");
  });
  withEnv({ DASHSCOPE_TTS_VOICE_FORCE: "true" }, () => {
    assert.equal(modelUnavailableReason("cosyvoice-v3.5-plus", "longanyang"), null, "强制开关放行");
  });
});

test("resolveCosyTargets：不可用的模型被跳过并留原因，其余照常可用", () => {
  withEnv({ DASHSCOPE_TTS_VOICE_FORCE: undefined }, () => {
    const noVoice = resolveCosyTargets("cosyvoice-v3.5-plus,cosyvoice-v3-flash", "");
    assert.deepEqual(noVoice.usable, [{ model: "cosyvoice-v3-flash", voice: "longanyang" }]);
    assert.equal(noVoice.skipped.length, 1);
    assert.match(noVoice.skipped[0]!, /cosyvoice-v3\.5-plus/);

    const ok = resolveCosyTargets("cosyvoice-v3.5-plus,cosyvoice-v3.5-flash", "myvoice-abc");
    assert.deepEqual(ok.skipped, []);
    assert.deepEqual(ok.usable.map((t) => t.model), ["cosyvoice-v3.5-plus", "cosyvoice-v3.5-flash"]);
  });
});

test("错误分级：4xx→换模型，401/403→换模型无意义，网络/5xx/429→重试", () => {
  assert.equal(cosyErrorKind(new CosyHttpError("x", 400, "QuotaExhausted")), "model");
  assert.equal(cosyErrorKind(new CosyHttpError("x", 401)), "provider");
  assert.equal(cosyErrorKind(new CosyHttpError("x", 403)), "provider");
  assert.equal(cosyErrorKind(new CosyHttpError("x", 429)), "transient");
  assert.equal(cosyErrorKind(new CosyHttpError("x", 503)), "transient");
  assert.equal(cosyErrorKind(new Error("fetch failed")), "transient", "网络异常按瞬时处理");
});

/** 假百炼端点：让指定模型（或 `"all"` = 全部）返回指定状态码，并记录调用到的模型顺序。 */
async function startCosyMock(opts: { status: number; failModels: string[] | "all" }) {
  const mp3 = Buffer.concat([
    Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]),
    Buffer.alloc(6000, 7),
  ]);
  const calls: string[] = [];
  let baseUrl = "";
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith(".mp3")) {
      res.writeHead(200, { "Content-Type": "audio/mpeg" });
      res.end(mp3);
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string };
      calls.push(body.model);
      const shouldFail =
        opts.failModels === "all" || opts.failModels.includes(body.model);
      if (shouldFail) {
        res.writeHead(opts.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: "MockErr", message: "mock failure", request_id: "r" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          request_id: "r",
          output: { finish_reason: "stop", audio: { data: "", url: `${baseUrl}/a.mp3` } },
          usage: { characters: 30 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { server, calls, baseUrl, mp3 };
}

const COSY_SCRIPT = "具备零售AUM商机的，可提前备好卖点和话术。";
const COSY_ENV: Record<string, string | undefined> = {
  DASHSCOPE_API_KEY: "k",
  DASHSCOPE_TTS_VOICE: "myvoice-abc",
  DASHSCOPE_TTS_MODELS: "cosyvoice-v3.5-plus,cosyvoice-v3.5-flash",
  DASHSCOPE_TTS_VOICE_FORCE: undefined,
};

/** 每个用例一个独立临时输出路径。 */
function cosyOut(tag: string): string {
  return path.join(fsSync.mkdtempSync(path.join(os.tmpdir(), `cosy-${tag}-`)), "o.mp3");
}

test("模型链行为：v3.5-plus 失败（400 额度耗尽）→ 自动换 v3.5-flash 并成功", async () => {
  const mock = await startCosyMock({ status: 400, failModels: ["cosyvoice-v3.5-plus"] });
  try {
    await withEnvAsync({ ...COSY_ENV, DASHSCOPE_TTS_ENDPOINT: `${mock.baseUrl}/t` }, async () => {
      const out = cosyOut("chain");
      await synthCosyvoice(COSY_SCRIPT, out, "2026-09-21");
      assert.deepEqual(
        mock.calls,
        ["cosyvoice-v3.5-plus", "cosyvoice-v3.5-flash"],
        "顺序正确，且 400 不触发同模型重试",
      );
      assert.ok(fsSync.readFileSync(out).equals(mock.mp3), "落盘的是第二个模型的音频");
    });
  } finally {
    mock.server.close();
  }
});

test("模型链行为：401 凭据错误 → **不试第二个模型**（同一把 Key，换模型无意义）", async () => {
  const mock = await startCosyMock({ status: 401, failModels: "all" });
  try {
    await withEnvAsync({ ...COSY_ENV, DASHSCOPE_TTS_ENDPOINT: `${mock.baseUrl}/t` }, async () => {
      const out = cosyOut("auth");
      await assert.rejects(() => synthCosyvoice(COSY_SCRIPT, out, "2026-09-21"), /凭据\/权限问题/);
      assert.deepEqual(mock.calls, ["cosyvoice-v3.5-plus"], "只试了第一个就放弃");
    });
  } finally {
    mock.server.close();
  }
});

test("模型链行为：两个模型都失败 → 抛错（交由后端链上的腾讯接手）", async () => {
  const mock = await startCosyMock({
    status: 400,
    failModels: ["cosyvoice-v3.5-plus", "cosyvoice-v3.5-flash"],
  });
  try {
    await withEnvAsync({ ...COSY_ENV, DASHSCOPE_TTS_ENDPOINT: `${mock.baseUrl}/t` }, async () => {
      const out = cosyOut("both");
      await assert.rejects(() => synthCosyvoice(COSY_SCRIPT, out, "2026-09-21"), /模型链全部失败/);
      assert.deepEqual(mock.calls, ["cosyvoice-v3.5-plus", "cosyvoice-v3.5-flash"], "两个都试过");
    });
  } finally {
    mock.server.close();
  }
});

test("模型链行为：没有任何可用模型 → 明确报错并给出修法（不静默无声）", async () => {
  await withEnvAsync(
    { ...COSY_ENV, DASHSCOPE_TTS_VOICE: "", DASHSCOPE_TTS_MODELS: "cosyvoice-v3.5-plus" },
    async () => {
      await assert.rejects(
        () => synthCosyvoice(COSY_SCRIPT, cosyOut("none"), "2026-09-21"),
        /没有可用模型[\s\S]*DASHSCOPE_TTS_VOICE/,
      );
    },
  );
});
