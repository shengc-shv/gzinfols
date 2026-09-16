/**
 * 红筹「会前版本」报告页加锁测试（plan-redchip-crawl-push §5.3 / T5·T6）。
 *
 * 用**真实子进程**跑 `scripts/build-site.mjs`（与 tests/build-site.test.ts 同款手法）：
 * 只喂合成 `data/redchip/leads.json` + changelog，断言页面确实产出且内容正确。
 * 覆盖三个关键契约：
 *   ① T5 覆盖率：每条 verdict ≠ non-redchip 的线索都必须有页（「点开不空」）；
 *   ② T6 深度版不冲突：deep/ 存在时仍保留会前版本（入口由 resolver 决定指向）；
 *   ③ 零 LLM + 安全：页面为纯静态拼接，且用户可控字段必须转义（防注入）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "build-site.mjs");

const LEAD_RED = {
  leadId: "108870",
  appId: "108870",
  nameCn: "深圳市海柔創新智能科技集團股份有限公司",
  nameEn: "Hai Robotics Innovation Group Co., Ltd.",
  board: "主板",
  status: "处理中",
  submitDate: "2026-09-13",
  domicile: "开曼群岛",
  isOffshore: true,
  gdCityHits: 9,
  gdCityMentions: 127,
  isGdConnected: true,
  vie: "none",
  verdict: "redchip",
  discoveredAt: "2026-09-15T08:00:00+08:00",
  lastChangedAt: "2026-09-15T09:00:00+08:00",
  sourceUrl: "https://www1.hkexnews.hk/app/sehk/2026/108870/documents/sehk26091300124.pdf",
  gdEvidence: [{ text: "we operated two manufacturing facilities located in Dongguan, Guangdong Province", page: 118 }],
  archNotes: ["开曼群岛注册；主要运营实体位于广东"],
};

const LEAD_NON = {
  leadId: "555555",
  appId: "555555",
  nameCn: "某境内企业股份有限公司",
  nameEn: "",
  board: "GEM",
  status: "处理中",
  submitDate: "2026-09-14",
  domicile: "中国(境内)",
  isOffshore: false,
  gdCityHits: 41,
  isGdConnected: true,
  vie: "none",
  verdict: "non-redchip",
  discoveredAt: "2026-09-15T08:00:00+08:00",
};

/** 注入防护夹具：名称里带标签，必须被转义。 */
const LEAD_INJECTED = {
  ...LEAD_RED,
  leadId: "108999",
  appId: "108999",
  nameCn: "<script>alert(1)</script>",
  verdict: "unverified",
};

function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redchip-report-"));
  const write = (rel: string, content: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
  };
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "assets", "og-image.png"), path.join(dir, "assets", "og-image.png"));

  write(
    "data/redchip/leads.json",
    JSON.stringify(
      [
        LEAD_RED,
        LEAD_NON,
        LEAD_INJECTED,
      ],
      null,
      2,
    ),
  );
  write(
    "data/redchip/changelog.jsonl",
    [
      JSON.stringify({ at: "2026-09-14T08:00:00+08:00", type: "added", appId: "108870" }),
      JSON.stringify({ at: "2026-09-15T09:00:00+08:00", type: "changed", appId: "108870", field: "状态", from: "处理中", to: "已受理" }),
    ].join("\n") + "\n",
  );
  // projects 必须非空：总览页据此渲染清单与「报告」列（空数组 → 空态页，验证不到链接）
  write(
    "data/redchip/latest.json",
    JSON.stringify({
      capturedAt: "2026-09-15T08:30:00+08:00",
      count: 3,
      projects: [LEAD_RED, LEAD_NON, LEAD_INJECTED],
    }),
  );
  write("daily_reports/2026-09-15/2026-09-15.html", "<!doctype html><html><body><p>x</p></body></html>");
  return dir;
}

test("会前报告页：逐条产出（T5）+ 深度版共存（T6）+ 字段转义（防注入）", () => {
  const dir = makeFixture();
  try {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `build-site 应成功退出：\n${r.stdout}\n${r.stderr}`);

    const read = (rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");
    const exists = (rel: string) => fs.existsSync(path.join(dir, rel));

    // ① T5：红筹线索有页；non-redchip 不产页
    assert.ok(exists("site/redchip/r/108870.html"), "红筹线索必须有会前版本报告页");
    assert.equal(exists("site/redchip/r/555555.html"), false, "non-redchip 不产报告页（§3.1）");
    assert.ok(exists("site/redchip/index.html"), "红筹总览页仍应生成");
    assert.ok(r.stdout.includes("redchip/r/*.html"), "应打印报告页产出日志");

    const page = read("site/redchip/r/108870.html");
    // 抬头 + 判定依据 + 水印（红线「线索 ≠ 结论」）
    assert.ok(page.includes("深圳市海柔創新智能科技集團股份有限公司"));
    assert.ok(page.includes("Hai Robotics Innovation Group Co., Ltd."));
    assert.ok(page.includes("红筹线索"));
    assert.ok(page.includes("会前版本 · 待深度核验"), "必须有「会前版本 · 待深度核验」水印");
    assert.ok(page.includes("判定依据"));
    // 架构穿透 / 广东连接证据 / 时间线 / 官方入口
    assert.ok(page.includes("开曼群岛"));
    assert.ok(page.includes("Dongguan, Guangdong Province"), "应包含广东连接原文摘录");
    assert.ok(page.includes("p.118"), "摘录应带页码");
    assert.ok(page.includes("集团实体语境下广东城市命中 <strong>9</strong> 次"));
    assert.ok(page.includes("全文裸提及 127 次"));
    assert.ok(page.includes("2026-09-13") && page.includes("递表"), "时间线应含递表行");
    assert.ok(page.includes("状态：处理中 → 已受理"), "时间线应含变更行（来自 changelog）");
    assert.ok(page.includes("hkexnews.hk/app/sehk/2026/108870/documents/sehk26091300124.pdf"), "应给回原文 PDF 直链");
    assert.ok(page.includes("抓取时刻：2026-09-15T08:30:00+08:00"));

    // ③ 转义：不得出现可执行标签
    const injected = read("site/redchip/r/108999.html");
    assert.ok(!injected.includes("<script>alert(1)</script>"), "用户可控字段必须被转义");
    assert.ok(injected.includes("&lt;script&gt;"), "应转义为 HTML 实体");

    // ④ 总览页「报告」列：只链接**确实生成了页面**的线索（防死链）
    const index = read("site/redchip/index.html");
    assert.ok(index.includes("<th>报告</th>"), "总览页应有「报告」列");
    assert.ok(index.includes('href="r/108870.html"'), "红筹线索应链接到会前版本报告");
    assert.ok(
      !index.includes('href="r/555555.html"'),
      "non-redchip 不产页 → 总览页不得给出指向它的链接（否则死链）",
    );
    assert.ok(!index.includes("<script>alert(1)</script>"), "总览页同样必须转义用户可控字段");

    // ② T6：预置人工深度版 —— 会前版本仍存在，且入口由 resolver 决定（此处仅验证共存）
    const deepDir = path.join(dir, "site", "redchip", "deep");
    fs.mkdirSync(deepDir, { recursive: true });
    fs.writeFileSync(path.join(deepDir, "108870.html"), "<html>deep</html>", "utf8");
    const r2 = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    assert.equal(r2.status, 0);
    assert.ok(exists("site/redchip/deep/108870.html"), "人工深度版不得被构建覆盖");
    assert.ok(exists("site/redchip/r/108870.html"), "会前版本与会前/深度版共存");

    // ⑤ 入口优先级：深度版存在时，总览页「报告」列应指向 deep（manual > deep > r）
    const index2 = read("site/redchip/index.html");
    assert.ok(
      index2.includes('href="deep/108870.html"'),
      "深度版存在时入口优先指向 deep（与 report-resolver 同口径 manual > deep > r）",
    );
    assert.ok(!index2.includes('href="r/108870.html"'), "存在深度版时不应再指向会前版本");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
