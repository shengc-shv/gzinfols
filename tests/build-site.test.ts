/**
 * C-2 发布链路契约（`scripts/build-site.mjs`）。
 *
 * 为什么优先补这个文件：`build-site.mjs` 是**发布根 `site/` 的唯一写者** ——
 * 页面链接改写、各期汇集、内部数据排除、Jekyll 抑制全靠它，而它此前是**零测试覆盖**。
 * 2026-09-14 修复发布链路时（Pages 分支式 vs 工作流 artifact 式不兼容）已确认：
 * 它一旦出错，整条发布链路的产物就是错的，且不会在单元测试里暴露。
 *
 * 本文件用真实子进程 + 临时工作目录跑脚本，断言 4 类契约：
 *   ① 报告页链接改写（归档链接与音频相对路径）；
 *   ② 各期汇集（含**仅存在于发布根**的更早期次 —— 这是 gh-pages 作为长期归档的前提）；
 *   ③ 站点根文件齐备（.nojekyll / og-image.png）；
 *   ④ 内部数据（json / store.json / *-articles.json）不得进入公开站点。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "build-site.mjs");

/** 报告页夹具：刻意带上需要被改写的两种相对引用（归档链接 + 音频）。 */
function reportPage(date: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>每日简报 · ${date}</title></head>
<body>
  <p><a class="archive" href="../archive.html">归档</a></p>
  <audio controls src="audio/briefing-${date}.mp3"></audio>
</body></html>`;
}

function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-site-"));
  const write = (rel: string, content: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
  };

  // 分享缩略图源（脚本会拷贝到发布根）
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "assets", "og-image.png"), path.join(dir, "assets", "og-image.png"));

  // 当日产物：报告页 + 音频，以及**不得发布**的内部数据
  write("daily_reports/2026-09-14/2026-09-14.html", reportPage("2026-09-14"));
  write("daily_reports/2026-09-14/2026-09-14.json", '{"internal":true}');
  write("daily_reports/2026-09-14/2026-09-14-articles.json", '[{"internal":true}]');
  write("daily_reports/2026-09-14/store.json", '{"internal":true}');
  write("daily_reports/2026-09-14/audio/briefing-2026-09-14.mp3", "MP3");

  // CI 每期归档回 main 的历史各期
  write("history/2026-09-13/2026-09-13.html", reportPage("2026-09-13"));

  // 仅存在于发布根的更早期次（模拟 CI 从 gh-pages 分支恢复的历史）
  write("site/2026-09-01/2026-09-01.html", reportPage("2026-09-01"));

  return dir;
}

function runBuildSite(cwd: string) {
  return spawnSync(process.execPath, [SCRIPT], { cwd, encoding: "utf8" });
}

test("发布链路契约：链接改写 / 各期汇集 / 站点根文件 / 内部数据排除", () => {
  const dir = makeFixture();
  try {
    const r = runBuildSite(dir);
    assert.equal(r.status, 0, `build-site 应成功退出：\n${r.stdout}\n${r.stderr}`);

    const read = (rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");
    const exists = (rel: string) => fs.existsSync(path.join(dir, rel));

    // ① 链接改写：报告页里的相对引用在「站点根副本」中必须改写正确
    assert.ok(exists("site/index.html"), "应生成站点根 index.html");
    const index = read("site/index.html");
    assert.ok(index.includes('href="./archive.html"'), "index.html 的归档链接应改写为 ./archive.html");
    assert.ok(
      !index.includes('href="../archive.html"'),
      "index.html 不得保留 ../archive.html（站点根下该路径不存在 → 死链）",
    );
    assert.ok(
      index.includes('src="2026-09-14/audio/briefing-2026-09-14.mp3"'),
      "index.html 的音频应改写为 <date>/audio/…（站点根下音频在子目录内）",
    );
    assert.ok(!index.includes('src="audio/'), "index.html 不得保留未改写的 audio/ 相对路径");

    // ② 各期汇集：当期 + history 各期 + **仅存在于发布根**的更早期次
    assert.ok(exists("site/2026-09-14/2026-09-14.html"), "应汇集当期（daily_reports）");
    assert.ok(exists("site/2026-09-13/2026-09-13.html"), "应汇集 history 各期");
    assert.ok(
      exists("site/2026-09-01/2026-09-01.html"),
      "应保留仅存在于发布根的历史期（gh-pages 长期归档的前提）",
    );
    const archive = read("site/archive.html");
    for (const d of ["2026-09-14", "2026-09-13", "2026-09-01"]) {
      assert.ok(
        archive.includes(`./${d}/${d}.html`),
        `archive.html 应列出 ${d}（实际归档页未包含该期）`,
      );
    }
    assert.ok(archive.includes("共 3 期"), `archive.html 期数应为 3：${archive.match(/共 \d+ 期/)?.[0]}`);

    // ③ 站点根文件齐备（Pages 会跑 Jekyll / og:image 依赖这两个文件）
    assert.ok(exists("site/.nojekyll"), "应生成 .nojekyll（否则 GitHub Pages 会跑 Jekyll）");
    assert.ok(exists("site/og-image.png"), "应把 assets/og-image.png 拷到发布根（og:image 依赖）");
    assert.ok(exists("site/2026-09-14/audio/briefing-2026-09-14.mp3"), "应发布音频");

    // ④ 内部数据不得进入公开站点
    for (const rel of [
      "site/2026-09-14/2026-09-14.json",
      "site/2026-09-14/2026-09-14-articles.json",
      "site/2026-09-14/store.json",
    ]) {
      assert.ok(!exists(rel), `内部数据不得发布到公开站点：${rel}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("发布链路契约：找不到任何报告目录时应失败（不得产出空站点误导发布）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-site-empty-"));
  try {
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "assets", "og-image.png"), path.join(dir, "assets", "og-image.png"));
    const r = runBuildSite(dir);
    assert.notEqual(r.status, 0, "无任何报告目录时必须非零退出（否则会发布一个空站点）");
    assert.ok(!fs.existsSync(path.join(dir, "site", "archive.html")), "不应产出归档页");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
