// 一次性脚本：把 data/replay/extracted-<date>.json（CI dump 提取的 30 条文章）
// 重建为冻结爬虫池 CrawledBundle（{ipo,gz,stocks}），供 replay-daily.ts 经 crawlers 覆盖注入。
//
// 关键：只重建「能驱动管线走到 PASS1」的最小字段——url/title/excerpt/publishedAt/sourceId/region。
// 其余（source_type/category 等）由 routeRegion 重新推导，无需还原。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const date = process.argv[2] || "2026-09-15";
const inPath = resolve(process.cwd(), `data/replay/extracted-2026-09-13.json`);
const arts = JSON.parse(readFileSync(inPath, "utf8"));

// 显示名 → 源配置 id + 落桶。ipo 桶走 routeRegion("ipo")，gz 桶走 routeRegion("gz")，
// stocks 桶走 routeRegion("gz",{gzCategory:"stocks"})。
const MAP = {
  "港交所新股递表(广东企业赴港)": { id: "hk-filing-gd", bucket: "ipo", region: "gd" },
  "港交所新股递表(主板/GEM·全国参考)": { id: "hk-filing", bucket: "ipo", region: undefined },
  "新浪财经·理财保险": { id: "sina-money", bucket: "gz" },
  "arXiv 金融科技论文 (cs.AI·cs.LG·q-fin)": { id: "arxiv-fintech", bucket: "gz" },
  "新华财经": { id: "cnfin", bucket: "gz" },
  "证券时报": { id: "stcn", bucket: "gz" },
  "东方财富·A股股市新闻": { id: "eastmoney-stock", bucket: "stocks" },
};

function toIso(mmdd) {
  // mmdd 形如 "09/13"
  const [m, d] = String(mmdd).split("/");
  return `2026-${m}-${d}T09:00:00+08:00`;
}

const bundle = { ipo: [], gz: [], stocks: [] };
const missing = [];
for (const a of arts) {
  const m = MAP[a.source];
  if (!m) { missing.push(a.source); continue; }
  const item = {
    sourceId: m.id,
    title: a.title || "",
    url: a.url || "",
    excerpt: (a.raw_text || "").slice(0, 5000), // 下游 toPass1Input 会再截断到 450
    publishedAt: toIso(a.date),
  };
  if (m.region) item.region = m.region;
  bundle[m.bucket].push(item);
}

if (missing.length) {
  console.warn("⚠️ 未识别的 source（已跳过）：", [...new Set(missing)]);
}
const out = resolve(process.cwd(), `data/replay/pool-${date}.json`);
writeFileSync(out, JSON.stringify(bundle, null, 2) + "\n");
console.log(
  `已生成冻结池: ${out}\n  ipo=${bundle.ipo.length} gz=${bundle.gz.length} stocks=${bundle.stocks.length}`,
);
