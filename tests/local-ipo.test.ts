/**
 * 本地 IPO 补数桥（`lib/adapters/local-ipo.ts`）契约锁。
 *
 * 背景（memory 登记的遗留）：gzinfo 侧有 22 条锁，2.0 移植后**一直没补**。
 * 这条链路是「CI 抓不到的官方源（证监会辅导 + 深交所审核）」的唯一衔接点：
 * 本地 `npm run ipo:local` 写文件 → 远 cron 读文件补数。写坏/读歪都**不会报错**，
 * 只会表现为「这两个源长期 0 条」—— 所以必须由测试盯住。
 *
 * 覆盖：白名单注册一致性 / 读取容错 / 原子写 / 新鲜度 / 合并去重 / 在线优先 / 窗口口径。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LOCAL_IPO_GENERATOR,
  LOCAL_IPO_STALE_DAYS,
  LOCAL_IPO_VERSION,
  LOCAL_ONLY_IPO_SOURCE_IDS,
  buildLocalIpoSnapshot,
  countBySource,
  localIpoStalenessDays,
  readLocalIpoFile,
  selectLocalIpoItems,
  writeLocalIpoFile,
  type LocalIpoFile,
} from "../lib/adapters/local-ipo";
import { buildLocalOnlyIpoCrawlers } from "../lib/adapters/crawlers";
import { IPO_SOURCE_WINDOW_DAYS } from "../lib/ipo-config";
import type { CrawledArticle } from "../lib/contracts/article";

const NOW = new Date("2026-09-17T09:00:00+08:00"); // 固定时刻：窗口计算可复现
const IN_WINDOW = "2026-09-15";
const TOO_OLD = "2026-08-01";

function art(sourceId: string, url: string, date = IN_WINDOW, title = "条目"): CrawledArticle {
  return { sourceId, url, title, publishedAt: date, excerpt: "", region: "gd" } as unknown as CrawledArticle;
}

function withTmpFile(fn: (p: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipo-"));
  const p = path.join(dir, "local-ipo.json");
  try {
    fn(p);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("① 注册一致性：白名单与本地专供源必须一一对应", () => {
  const ids = buildLocalOnlyIpoCrawlers().flatMap((c) => c.sourceIds ?? []);
  assert.deepEqual(
    [...ids].sort(),
    [...LOCAL_ONLY_IPO_SOURCE_IDS].sort(),
    "LOCAL_ONLY_IPO_SOURCE_IDS 与实际注册的本地专供源不一致 —— 读写两侧会互相丢弃条目",
  );
  assert.equal(new Set(ids).size, ids.length, "sourceId 不得重复");
});

test("② 读取容错：不存在 / 坏 JSON / 版本不符 / 结构非法 都安全降级", () => {
  withTmpFile((p) => {
    assert.equal(readLocalIpoFile(p).file, null, "文件不存在 → null");
    assert.match(readLocalIpoFile(p).reason ?? "", /不存在/);

    fs.writeFileSync(p, "{ 不是 JSON", "utf8");
    assert.match(readLocalIpoFile(p).reason ?? "", /JSON/);

    fs.writeFileSync(p, JSON.stringify({ version: 999, items: [] }), "utf8");
    assert.match(readLocalIpoFile(p).reason ?? "", /版本/);

    fs.writeFileSync(p, JSON.stringify({ version: LOCAL_IPO_VERSION, items: "x" }), "utf8");
    assert.match(readLocalIpoFile(p).reason ?? "", /items/);
  });
});

test("③ 原子写：写完不留 .tmp，且能原样读回", () => {
  withTmpFile((p) => {
    const file: LocalIpoFile = {
      version: LOCAL_IPO_VERSION,
      fetchedAt: "2026-09-17T09:00:00+08:00",
      generator: LOCAL_IPO_GENERATOR,
      windowDays: IPO_SOURCE_WINDOW_DAYS,
      sourceCounts: { "gd-csrc-tutoring": 1 },
      items: [art("gd-csrc-tutoring", "https://example.com/a")],
    };
    writeLocalIpoFile(file, p);
    assert.ok(fs.existsSync(p), "文件应写入");
    assert.ok(!fs.existsSync(`${p}.tmp`), "不得残留 .tmp（半截文件会被 CI 读到）");
    const back = readLocalIpoFile(p);
    assert.equal(back.file?.items.length, 1);
    assert.equal(back.file?.generator, LOCAL_IPO_GENERATOR, "generator 便于排查文件来源");
  });
});

test("④ 新鲜度：非法日期 → null；正常按天计算", () => {
  assert.equal(localIpoStalenessDays("不是日期", NOW), null);
  assert.equal(localIpoStalenessDays("2026-09-17T09:00:00+08:00", NOW), 0);
  assert.equal(localIpoStalenessDays("2026-09-15T09:00:00+08:00", NOW), 2);
  assert.ok(LOCAL_IPO_STALE_DAYS >= 1, "过期阈值须 ≥1 天（否则天天误报同步中断）");
});

test("⑤ countBySource：确定性排序（git diff 稳定）", () => {
  const counts = countBySource([
    art("b", "u1"),
    art("a", "u2"),
    art("b", "u3"),
  ]);
  assert.deepEqual(Object.keys(counts), ["a", "b"], "键必须排序输出");
  assert.equal(counts.b, 2);
  assert.equal(countBySource([{ title: "无源" } as CrawledArticle])["(无 sourceId)"], 1, "缺 sourceId 也要可统计");
});

test("⑥ 快照合并：丢无日期 / 裁超窗 / 同 URL 取较新 / 保留旧文件窗口内条目", () => {
  const prev: LocalIpoFile = {
    version: LOCAL_IPO_VERSION,
    fetchedAt: "2026-09-16T09:00:00+08:00",
    generator: LOCAL_IPO_GENERATOR,
    windowDays: IPO_SOURCE_WINDOW_DAYS,
    sourceCounts: {},
    items: [art("gd-szse-audit", "https://example.com/keep", IN_WINDOW), art("gd-szse-audit", "https://example.com/drop", TOO_OLD)],
  };
  const { file, stats } = buildLocalIpoSnapshot(
    [
      art("gd-csrc-tutoring", "https://example.com/new"),
      { ...art("gd-csrc-tutoring", "https://example.com/nodate"), publishedAt: "" } as CrawledArticle,
      art("gd-csrc-tutoring", "https://example.com/old", TOO_OLD),
      art("gd-csrc-tutoring", "https://example.com/dup"),
      art("gd-csrc-tutoring", "https://example.com/dup"),
    ],
    { prev, now: NOW, windowDays: IPO_SOURCE_WINDOW_DAYS },
  );
  const urls = file.items.map((i) => i.url);
  assert.ok(urls.includes("https://example.com/new"), "新抓窗口内条目应入库");
  assert.ok(urls.includes("https://example.com/keep"), "旧文件窗口内条目应保留（抓取抖动的缓冲）");
  assert.ok(!urls.includes("https://example.com/nodate"), "无日期条目必须丢弃（时间真实性红线）");
  assert.ok(!urls.includes("https://example.com/old"), "超窗条目不得入库");
  assert.equal(urls.filter((u) => u === "https://example.com/dup").length, 1, "同 URL 去重");
  assert.equal(stats.droppedNoDate, 1);
  assert.equal(stats.droppedOutOfWindow, 1, "只有「old」一条超窗（无日期那条走另一分支，不计入）");
  assert.equal(stats.droppedDuplicate, 1);
  // 时间真实性：入库条目必须都带真实 publishedAt
  for (const it of file.items) assert.match(String(it.publishedAt), /^\d{4}-\d{2}-\d{2}/);
  // 口径自证：文件记录写入时的窗口天数，读取端可据此判断两侧口径是否漂移
  assert.equal(file.windowDays, IPO_SOURCE_WINDOW_DAYS);
});

test("⑦ 快照排序确定性：同参数两次调用逐字节一致", () => {
  const input = [
    art("gd-szse-audit", "https://example.com/b", IN_WINDOW, "乙"),
    art("gd-szse-audit", "https://example.com/a", IN_WINDOW, "甲"),
    art("gd-csrc-tutoring", "https://example.com/c", IN_WINDOW, "丙"),
  ];
  const a = buildLocalIpoSnapshot(input, { now: NOW, fetchedAt: "T", generator: "g" });
  const b = buildLocalIpoSnapshot(input, { now: NOW, fetchedAt: "T", generator: "g" });
  assert.equal(JSON.stringify(a.file), JSON.stringify(b.file), "同输入必须得到同一文件内容");
});

test("⑧ 远端接入：文件缺失 → 空数组降级（不抛错、不静默）", () => {
  withTmpFile((p) => {
    const out = selectLocalIpoItems([], { filePath: p, now: NOW });
    assert.deepEqual(out, [], "文件缺失应降级为空（该源本期 0 条）而不是抛错中断整轮");
  });
});

test("⑨ 远端接入：白名单外的 sourceId 一律丢弃", () => {
  withTmpFile((p) => {
    writeLocalIpoFile(
      {
        version: LOCAL_IPO_VERSION,
        fetchedAt: "2026-09-17T09:00:00+08:00",
        generator: LOCAL_IPO_GENERATOR,
        windowDays: IPO_SOURCE_WINDOW_DAYS,
        sourceCounts: {},
        items: [
          art("gd-csrc-tutoring", "https://example.com/ok"),
          art("某个不在白名单的源", "https://example.com/bad"),
        ],
      },
      p,
    );
    const out = selectLocalIpoItems([], { filePath: p, now: NOW });
    assert.equal(out.length, 1, "非白名单条目必须丢弃（防这个文件变成任意源的注入通道）");
    assert.equal(out[0].url, "https://example.com/ok");
  });
});

test("⑩ 远端接入：在线优先（同一 URL 在线已抓到则不用本地版）", () => {
  withTmpFile((p) => {
    writeLocalIpoFile(
      {
        version: LOCAL_IPO_VERSION,
        fetchedAt: "2026-09-17T09:00:00+08:00",
        generator: LOCAL_IPO_GENERATOR,
        windowDays: IPO_SOURCE_WINDOW_DAYS,
        sourceCounts: {},
        items: [art("gd-szse-audit", "https://example.com/same"), art("gd-szse-audit", "https://example.com/only-local")],
      },
      p,
    );
    const online = [art("gd-szse-audit", "https://example.com/same")];
    const out = selectLocalIpoItems(online, { filePath: p, now: NOW });
    assert.deepEqual(
      out.map((i) => i.url),
      ["https://example.com/only-local"],
      "在线已抓到的 URL 不得重复补入（否则同一事件两条）",
    );
  });
});

test("⑪ 过期文件仍可用但必须告警（宁漏勿误断）", () => {
  withTmpFile((p) => {
    const stale = new Date(NOW.getTime() - (LOCAL_IPO_STALE_DAYS + 2) * 86_400_000);
    writeLocalIpoFile(
      {
        version: LOCAL_IPO_VERSION,
        fetchedAt: stale.toISOString(),
        generator: LOCAL_IPO_GENERATOR,
        windowDays: IPO_SOURCE_WINDOW_DAYS,
        sourceCounts: {},
        items: [art("gd-szse-audit", "https://example.com/stale")],
      },
      p,
    );
    const warned: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
    try {
      const out = selectLocalIpoItems([], { filePath: p, now: NOW });
      assert.equal(out.length, 1, "过期文件的窗口内条目仍应可用（补数总比没有好）");
    } finally {
      console.warn = orig;
    }
    assert.ok(
      warned.some((w) => w.includes("本地 IPO 补数") || w.includes("未更新")),
      "文件过期必须告警（否则本地同步中断无人察觉）",
    );
  });
});
