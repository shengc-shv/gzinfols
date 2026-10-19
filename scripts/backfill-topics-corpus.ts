/**
 * 主题语料回灌（一次性工具，2026-10-19 sc 拍板方案 B）。
 *
 * 背景：主题聚类只读 `daily_reports/` + `history/`（后者只保留 7 天），
 * 而 CI 从 gh-pages 恢复的 36 期落在 `site/` —— 不在读取目录里，且各期目录只有
 * `*.html / audio / i`、**没有报告 JSON**。结果语料只覆盖「建模块那天能读到的 8 天」，
 * 9 月下半月整段缺失，且以后再也不会自动补齐。
 *
 * 本脚本从 gh-pages 的**页面 HTML** 反解出 slim 条目，补齐缺失期次：
 *  - 只补 `data/topics-corpus.json` 里**没有的日期**（已有 11 天来自 JSON，更准，不覆盖）；
 *  - 条目 id 直接取页面锚点 `itm-xxx`（与当日页面同源）；
 *  - 原文链接从 `<date>/i/<itm>.html` 详情页取唯一外链（页面本身只给站内链接）；
 *  - 日期取条目自身展示的 `MM/DD`（不是期次日期），与聚类口径一致。
 *
 * 用法：
 *   npx tsx scripts/backfill-topics-corpus.ts /tmp/ghpages             # 真写
 *   npx tsx scripts/backfill-topics-corpus.ts /tmp/ghpages --dry-run   # 只看统计
 */
import fs from "node:fs";
import path from "node:path";
import { mergeCorpus, corpusStats, type TopicCorpus } from "../lib/services/topics/corpus";
import type { SlimDay, SlimItem } from "../lib/services/topics/slim";
import { itemIdOf } from "../lib/utils/item-id";

const GH_ROOT = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "/tmp/ghpages";
const DRY_RUN = process.argv.includes("--dry-run");
const CORPUS_PATH = path.resolve("data/topics-corpus.json");

/** 页面板块容器 id → sections 键（与 buildSlimDay 的 section 键一致）。 */
const SECTION_MAP: Record<string, string> = {
  "p-gz": "gz_local",
  "p-biz": "biz_insight",
  "p-pol": "policy_market",
  "p-tech": "tech",
  "p-ipo": "ipo",
};

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** 从详情页取原文外链（详情页只有 1 个外链；取不到返回 ""）。 */
function originalUrl(dateDir: string, id: string): string {
  const f = path.join(dateDir, "i", `${id}.html`);
  try {
    const h = fs.readFileSync(f, "utf8");
    const m = h.match(/href="(https?:\/\/[^"]+)"/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

/** 解析一期页面 → SlimDay。 */
function parseDay(dateDir: string, date: string): SlimDay | null {
  const file = path.join(dateDir, `${date}.html`);
  if (!fs.existsSync(file)) return null;
  const html = fs.readFileSync(file, "utf8");

  const heroM = html.match(/今日定调[：:]\s*([^<"]{4,300})/);
  const hero = heroM ? stripTags(heroM[1]) : "";

  // 按板块容器切块（panel 之外的 article 不取：股市动态/红筹不走主题聚类）
  const blocks: { section: string; html: string }[] = [];
  const secRe = /<section class="panel[^"]*" id="(p-[a-z]+)"[^>]*>/g;
  const marks: { id: string; start: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = secRe.exec(html)) !== null) marks.push({ id: m[1], start: m.index });
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : html.length;
    const section = SECTION_MAP[marks[i].id];
    if (!section) continue;
    blocks.push({ section, html: html.slice(marks[i].start, end) });
  }

  const items: SlimItem[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    for (const am of block.html.matchAll(/<article class="brief([^"]*)"([\s\S]*?)<\/article>/g)) {
      const cls = am[1];
      const body = am[2];
      // 早期页面（≤2026-09-16）还没有条目锚点体系：article 无 id、h3 直接给外链。
      const linkM = body.match(/<h3[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
      const href = linkM ? linkM[1] : "";
      const title = stripTags(linkM ? linkM[2] : "");
      if (!title) continue;
      const directUrl = /^https?:\/\//.test(href) ? href : "";
      const id = (body.match(/id="(itm-[^"]+)"/) || [])[1] || (directUrl ? itemIdOf(directUrl) : "");
      if (!id || seen.has(id)) continue;

      // bm 行：来源名 + MM/DD
      const bm = body.match(/<div class="bm">([\s\S]*?)<\/div>/);
      const spans = bm ? [...bm[1].matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map((x) => stripTags(x[1])) : [];
      const dateText = spans.find((s) => /^\d{2}\/\d{2}$/.test(s)) || "";
      const source = spans.find((s) => s && !/^\d{2}\/\d{2}$/.test(s) && !/^(官方|媒体)$/.test(s)) || "";
      if (!dateText) continue; // R6：没有日期就不收（不兜底）

      const tags = ((body.match(/data-tags="([^"]*)"/) || [])[1] || "").split(/\s+/).filter(Boolean);
      const summary = stripTags((body.match(/<p class="sum">([\s\S]*?)<\/p>/) || [])[1] || "");

      seen.add(id);
      items.push({
        i: id,
        t: title,
        s: source,
        d: dateText,
        m: /\bmust\b/.test(cls) ? 3 : 2,
        k: block.section,
        g: tags,
        x: summary.slice(0, 90),
        u: directUrl || originalUrl(dateDir, id),
      });
    }
  }

  return items.length ? { date, hero, items } : null;
}

function loadCorpus(): TopicCorpus {
  try {
    const raw = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8")) as TopicCorpus;
    if (!raw?.days) return { version: 1, updatedAt: "", days: {}, firstSeen: {} };
    return raw;
  } catch {
    return { version: 1, updatedAt: "", days: {}, firstSeen: {} };
  }
}

function main(): void {
  if (!fs.existsSync(GH_ROOT)) {
    console.error(`找不到 gh-pages 解压目录：${GH_ROOT}`);
    process.exit(1);
  }
  const dates = fs
    .readdirSync(GH_ROOT)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();

  const existing = loadCorpus();
  const missing = dates.filter((d) => !existing.days[d]);

  console.log(`gh-pages 期次 ${dates.length} 天；语料现有 ${Object.keys(existing.days).length} 天；待补 ${missing.length} 天`);

  const incoming: SlimDay[] = [];
  for (const date of missing) {
    const day = parseDay(path.join(GH_ROOT, date), date);
    if (day) incoming.push(day);
    else console.warn(`  ${date}：解析不出条目，跳过`);
  }

  const withLink = incoming.reduce((n, d) => n + d.items.filter((i) => i.u).length, 0);
  const total = incoming.reduce((n, d) => n + d.items.length, 0);
  console.log(`解析新增 ${incoming.length} 天 / ${total} 条（其中 ${withLink} 条取到原文链接）`);
  for (const d of incoming.slice(0, 6)) {
    console.log(`  ${d.date}  ${String(d.items.length).padStart(3)} 条  hero=${(d.hero || "—").slice(0, 34)}`);
  }
  if (incoming.length > 6) console.log(`  …另 ${incoming.length - 6} 天`);

  if (DRY_RUN) {
    console.log("--dry-run：不写盘");
    return;
  }

  const merged = mergeCorpus(existing, incoming);
  const st = corpusStats(merged);
  fs.writeFileSync(CORPUS_PATH, JSON.stringify(merged), "utf8");
  console.log(`已写入 ${CORPUS_PATH}：${st.days} 期 / ${st.items} 条 / 跨度 ${st.span}`);
}

main();
