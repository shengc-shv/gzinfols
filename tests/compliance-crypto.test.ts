/**
 * 合规红线：加密资产零容忍（2026-09-12 用户拍板，永久）。
 *
 * 三条防线，任何一条被削弱都能在此暴露：
 *  ① 静态：全仓库不得存在加密板块实现（coingecko / fear-greed / crypto_fear_greed）；
 *  ② 词表：`BANNED_WORDS`（R6 违禁词）必须覆盖全部加密变体；
 *  ③ 行为：命中违禁词的 必读/洞察 在回流 store 时被丢弃（`mergeStoredExecutive`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { BANNED_WORDS } from "../lib/services/enrich/validator";
import { mergeStoredExecutive } from "../lib/services/assemble/merge-executive";
import type { DailyReport } from "../lib/contracts/report";

const ROOT = path.resolve(import.meta.dirname, "..");
/** 加密板块的关键标识：出现即说明违规引入了加密实现。 */
const CRYPTO_MARKERS = ["coingecko", "fear-greed", "fear_greed", "crypto_fear_greed"];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fsSync.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|mjs|js|json|md|yml)$/.test(e.name)) out.push(p);
  }
  return out;
}

test("① 静态：实现面无加密板块（coingecko / fear-greed / crypto_fear_greed）", () => {
  // 只扫「实现面」：lib / scripts / .github / 根配置。
  // 文档（docs、AGENTS.md）与本文档会以「禁止项」名义提到这些名字，属预期，不参与扫描。
  const scanDirs = ["lib", "scripts", ".github"]
    .map((d) => path.join(ROOT, d))
    .filter((d) => fsSync.existsSync(d));
  const files = [
    ...scanDirs.flatMap((d) => walk(d)),
    ...["sources.config.json", "sources.keywords.json", "package.json"]
      .map((f) => path.join(ROOT, f))
      .filter((f) => fsSync.existsSync(f)),
  ];
  const hits: string[] = [];
  for (const f of files) {
    const text = fsSync.readFileSync(f, "utf-8").toLowerCase();
    for (const m of CRYPTO_MARKERS) {
      if (text.includes(m)) hits.push(`${path.relative(ROOT, f)} → ${m}`);
    }
  }
  assert.deepEqual(hits, [], `发现加密板块残留：\n${hits.join("\n")}`);
});

test("② 词表：BANNED_WORDS 覆盖全部加密变体", () => {
  const required = [
    "比特币",
    "BTC",
    "ETH",
    "以太坊",
    "加密货币",
    "虚拟货币",
    "加密资产",
    "加密市场",
    "币圈",
    "加密行情",
  ];
  for (const w of required) {
    assert.ok(BANNED_WORDS.includes(w), `BANNED_WORDS 缺少加密违禁词：${w}`);
  }
});

test("④ 静态（补强）：加密实现的**变体命名**残留 —— 驼峰键名 / CSS 类名 / i18n 文案", () => {
  // 为什么补这一条：2026-09-14 实测发现 `i18n.ts` 仍有 5 条加密 widget 文案
  // （`widgetCryptoFearGreed`「加密恐慌贪婪」/ `widgetBtcDom`「BTC 主导率」…），
  // `theme.ts` 仍有 `.crypto-widget.fg-fear*` 整块「恐慌贪婪」样式 —— 而 ① 的标记词
  // （coingecko / fear-greed / fear_greed / crypto_fear_greed）**恰好扫不到**驼峰与类名，
  // 于是这批残留长期潜伏。本用例用「实现面精确标记 + 剥离注释」把这类变体一并锁死。
  //
  // 剥离注释是必要的：说明「此处已移除 .crypto-widget」的注释本身含敏感词，
  // 不剥离会误报（与 lib/architecture/check.ts 同一教训）。
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  /** 只列「实现残留」特征词：不含 BANNED_WORDS / prompts 合规防线里的正当词（比特币、虚拟货币…）。 */
  const RESIDUE_MARKERS = [
    "crypto-widget",
    "crypto_widget",
    "widgetcrypto",
    "btcdom",
    "feargreed",
    "fear-greed",
    "coingecko",
    "crypto_fear_greed",
    "fg-fear",
    "fg-greed",
    "加密恐慌",
    "加密总市值",
    "恐慌贪婪",
    "活跃币",
    "BTC 主导率",
  ];

  const roots = ["lib", "scripts"].map((d) => path.join(ROOT, d)).filter((d) => fsSync.existsSync(d));
  const hits: string[] = [];
  for (const f of roots.flatMap((d) => walk(d))) {
    const code = stripComments(fsSync.readFileSync(f, "utf-8"));
    for (const m of RESIDUE_MARKERS) {
      if (code.includes(m)) hits.push(`${path.relative(ROOT, f)} → ${m}`);
    }
  }
  assert.deepEqual(hits, [], `发现加密实现残留（变体命名）：\n${hits.join("\n")}`);
});

test("③ 行为：命中违禁词的必读/洞察在回流时被丢弃", () => {
  const base: DailyReport = {
    date: "2026-09-12",
    hero_line: "",
    must_read: [],
    insights: [],
    sections: {
      gz_local: [],
      biz_insight: [],
      policy_market: [],
      tech: [],
      ipo: [],
    },
  };
  const exec = {
    hero_line: "",
    must_read: [
      { title: "正常必读：广州出台科技金融新政", why: "利好分行科创客群", url: "https://example.com/a" },
      { title: "比特币价格异动", why: "涉加密资产，必须剔除", url: "https://example.com/b" },
    ],
    insights: [
      {
        topic: "正常洞察：消费贷贴息扩围",
        impact: "价格战升级",
        action: "统一口径抢抓窗口",
      },
      {
        topic: "加密货币行情回暖",
        impact: "涉加密资产，必须剔除",
        action: "不得出现在简报",
      },
    ],
  };
  const out = mergeStoredExecutive(base, exec);
  const titles = out.must_read.map((m) => m.title).join("|");
  const topics = out.insights.map((i) => i.topic).join("|");
  assert.ok(!titles.includes("比特币"), `加密必读未被剔除：${titles}`);
  assert.ok(!topics.includes("加密货币"), `加密洞察未被剔除：${topics}`);
  assert.ok(titles.includes("正常必读"), "正常必读被误杀");
  assert.ok(topics.includes("正常洞察"), "正常洞察被误杀");
});
