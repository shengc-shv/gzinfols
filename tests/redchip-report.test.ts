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

/** 美股红筹码夹具（2026-10-22 真实命中：Sensing4D AI Ltd，CIK 2087307，F-1 开曼）。 */
const LEAD_US = {
  leadId: "us-2087307",
  appId: "us-2087307",
  nameCn: "Sensing4D AI Ltd",
  nameEn: "",
  board: "美股",
  status: "F-1/F-1A",
  submitDate: "2026-10-21",
  domicile: "开曼群岛",
  isOffshore: true,
  gdCityHits: 16,
  gdCityMentions: 107,
  isGdConnected: true,
  vie: "historical",
  verdict: "redchip",
  discoveredAt: "2026-10-22T09:55:20+08:00",
  sourceUrl: "https://www.sec.gov/Archives/edgar/data/2087307/000121390026111161/ea0256781-12.htm",
  market: "us",
};

/**
 * @param opts.usSnapshotProjects 美股链路快照的项目清单——默认 [LEAD_US]（有命中）；
 *   传 [] 模拟**零命中日**（窗口无新红筹递表），用于锁累计口径不清盘。
 * @param opts.usSnapshotCapturedAt 美股快照抓取时刻，默认与 LEAD_US.discoveredAt 一致。
 */
function makeFixture(opts?: { usSnapshotProjects?: unknown[]; usSnapshotCapturedAt?: string }): string {
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
        // 美股线索进**共享台账**（market:"us" 区分，与 redchip-us.ts 的合并口径一致）
        LEAD_US,
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
  // 港股链路快照（data/redchip/latest.json）：总览页自 2026-10-22 起**不再读它**（改累计
  // 台账口径，见下方 meta.json 注释）；此处仍保留，仅供报告页「抓取时刻」回退路径使用。
  // projects 必须非空：总览页据此渲染清单与「报告」列（空数组 → 空态页，验证不到链接）
  write(
    "data/redchip/latest.json",
    JSON.stringify({
      capturedAt: "2026-09-15T08:30:00+08:00",
      count: 3,
      projects: [LEAD_RED, LEAD_NON, LEAD_INJECTED],
    }),
  );
  // 抓取元信息（入库）：总览页快照时间标注的双源来源（与日报面板「数据截至」同口径）。
  // us.capturedAt 与美股快照同步（真实脚本同一 run 写同一时间戳），故跟随夹具参数。
  write(
    "data/redchip/meta.json",
    JSON.stringify({
      updatedAt: "2026-10-22T09:55:20+08:00",
      sources: {
        hk: { capturedAt: "2026-09-15T08:30:00+08:00", ok: true, scanned: 100, redchip: 1 },
        us: {
          capturedAt: opts?.usSnapshotCapturedAt ?? "2026-10-22T09:55:20+08:00",
          ok: true,
          scanned: 1,
          redchip: 1,
        },
      },
    }),
  );
  // 美股链路快照（data/redchip-us/，与港股两条独立链路）。总览页自 2026-10-22 起两条
  // 链路都改读累计台账、标注改读 meta.json——此快照只剩报告页「抓取时刻」回退职责，
  // 故项目清单可空而总览页不得清盘（累计口径契约，见文末用例）。
  const usSnapshotProjects = opts?.usSnapshotProjects ?? [LEAD_US];
  write(
    "data/redchip-us/latest.json",
    JSON.stringify({
      capturedAt: opts?.usSnapshotCapturedAt ?? "2026-10-22T09:55:20+08:00",
      count: usSnapshotProjects.length,
      projects: usSnapshotProjects,
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

test("美股红筹码：报告页来源标注走 SEC EDGAR（不是港交所披露易）+ 抓取时刻取美股快照", () => {
  const dir = makeFixture();
  try {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `build-site 应成功退出：\n${r.stdout}\n${r.stderr}`);

    const page = fs.readFileSync(path.join(dir, "site/redchip/r/us-2087307.html"), "utf8");
    assert.ok(page.includes("Sensing4D AI Ltd"), "美股线索必须产出会前版本报告页");
    // 来源口径分流（2026-10-22）：F-1 招股书来自 SEC EDGAR，不得写成港交所披露易
    assert.ok(page.includes("F-1 申请版本（SEC EDGAR）"), "官方入口应标注 SEC EDGAR");
    assert.ok(page.includes("数据来源：SEC EDGAR 全文检索"), "页脚来源应标注 SEC EDGAR");
    assert.ok(!page.includes("港交所披露易"), "美股线索页不得出现港股专属来源标注");
    assert.ok(
      page.includes("sec.gov/Archives/edgar/data/2087307"),
      "应给回 SEC Archives 原文直链",
    );
    // 抓取时刻按市场取所属链路：美股线索拿美股快照时间，不是港股快照时间/空值
    assert.ok(page.includes("抓取时刻：2026-10-22T09:55:20+08:00"), "应取美股快照的抓取时刻");
    assert.ok(!page.includes("抓取时刻：2026-09-15T08:30:00+08:00"), "不得错拿港股快照时间");

    // 总览页合并两条链路：美股线索进项目清单，「报告」列可点，快照时间双源并列
    const index = fs.readFileSync(path.join(dir, "site/redchip/index.html"), "utf8");
    assert.ok(index.includes("Sensing4D AI Ltd"), "总览页项目清单应包含美股线索");
    assert.ok(index.includes('href="r/us-2087307.html"'), "美股线索应链接到会前版本报告");
    assert.ok(index.includes("港股 2026-09-15T08:30:00+08:00"), "快照时间应含港股源");
    assert.ok(index.includes("美股 2026-10-22T09:55:20+08:00"), "快照时间应含美股源");
    // 港股线索不受影响：仍拿自己的快照时间与披露易标注
    const hk = fs.readFileSync(path.join(dir, "site/redchip/r/108870.html"), "utf8");
    assert.ok(hk.includes("抓取时刻：2026-09-15T08:30:00+08:00"), "港股线索抓取时刻不变");
    assert.ok(hk.includes("申请版本 PDF（港交所披露易）"), "港股线索来源标注不变");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("红筹总览段累计口径：两条链路都读台账，零命中日不清盘、non-redchip 不入段", () => {
  // 契约（2026-10-22 用户拍板「往体验一致方向修改」）：总览页项目清单两条链路**都**读共享
  // 台账 leads.json 按 market 分列（缺省 hk），而非各自链路的两日窗口快照——
  //   · 港股旧读 data/redchip/latest.json：被 gitignore 且 CI 不跑 monitor → CI 构建恒空；
  //   · 美股旧读 data/redchip-us/latest.json：零命中日把在册线索整段滚掉。
  // 台账同时是报告页与日报面板的唯一数据源，三处口径自此一致。过滤与面板 redchipLabelOf
  // 同口径：verdict ∈ {redchip, unverified} 展示，non-redchip（每日窗口噪声）不进总览段。
  const dir = makeFixture({ usSnapshotProjects: [], usSnapshotCapturedAt: "2026-10-23T07:05:00+08:00" });
  try {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `build-site 应成功退出：\n${r.stdout}\n${r.stderr}`);

    // 报告页照常产出（与总览页解耦：读台账，不读各自链路快照）
    assert.ok(fs.existsSync(path.join(dir, "site/redchip/r/us-2087307.html")), "美股线索报告页仍应产出");
    assert.ok(fs.existsSync(path.join(dir, "site/redchip/r/108870.html")), "港股线索报告页仍应产出");

    const index = fs.readFileSync(path.join(dir, "site/redchip/index.html"), "utf8");
    // ① 港股段：台账累计（38 家量级的口径在夹具里 = LEAD_RED 红筹 + LEAD_INJECTED 待核验）
    assert.ok(index.includes("海柔創新"), "港股段应读累计台账（不再依赖 gitignore 的 latest.json）");
    assert.ok(index.includes("&lt;script&gt;"), "待核验（unverified）线索属可展示口径，应入总览段");
    // ② 美股段：零命中日不清盘
    assert.ok(index.includes("Sensing4D AI Ltd"), "零命中日总览页美股段不得清盘（累计口径）");
    assert.ok(index.includes('href="r/us-2087307.html"'), "在册美股线索的「报告」列链接仍在");
    // ③ non-redchip 是每日窗口噪声，不进总览段（与面板 redchipLabelOf 同口径）
    assert.ok(!index.includes("某境内企业股份有限公司"), "non-redchip 线索不得进总览页项目清单");
    // ④ 统计行：港股 2（台账可展示）+ 美股 1 = 3 家，红筹 2（LEAD_RED + LEAD_US）
    assert.ok(index.includes("共 3 家（红筹 2）"), "统计应同时计入两条链路的台账可展示线索");
    // ⑤ 快照时间标注双源均取入库 meta.json（港股标注在旧口径 CI 构建里根本没有）
    assert.ok(index.includes("港股 2026-09-15T08:30:00+08:00"), "港股标注应取 meta.sources.hk.capturedAt");
    assert.ok(index.includes("美股 2026-10-23T07:05:00+08:00"), "美股标注应取 meta.sources.us.capturedAt");
    // ⑥ 源码级契约：两条链路都必须读累计台账，防各自回退到快照口径
    const src = fs.readFileSync(path.join(ROOT, "scripts", "build-site.mjs"), "utf8");
    assert.match(
      src,
      /const hkProjects = rcLeads\.filter/,
      "港股总览段必须读共享台账（累计口径），不得回退到 data/redchip/latest.json 快照",
    );
    assert.match(
      src,
      /const usProjects = rcLeads\.filter/,
      "美股总览段必须读共享台账（累计口径），不得回退到 data/redchip-us/latest.json 快照",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
