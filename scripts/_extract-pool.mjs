// 一次性脚本：从 CI dump（pass1-*.json）的 prompt 字段中提取文章池，
// 打印清单并落盘 data/replay/extracted-<date>.json 供人工分析 + 后续重建冻结池。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const dumpPath = process.argv[2];
const date = process.argv[3] || "2026-09-13";
if (!dumpPath) {
  console.error("用法: node scripts/_extract-pool.mjs <pass1-dump.json> [date]");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(resolve(dumpPath), "utf8"));
const prompt = raw.prompt || "";

// 括号配平提取第一个 JSON 数组（dump 同款逻辑，忽略字符串内括号）。
let depth = 0, inStr = false, start = -1, end = -1;
for (let i = 0; i < prompt.length; i++) {
  const c = prompt[i];
  if (inStr) { if (c === "\\") { i++; continue; } if (c === '"') inStr = false; continue; }
  if (c === '"') { inStr = true; continue; }
  if (c === "[") { if (start < 0) start = i; depth++; }
  else if (c === "]") { depth--; if (depth === 0) { end = i; break; } }
}
if (start < 0 || end < start) { console.error("未找到文章数组"); process.exit(1); }
const arr = JSON.parse(prompt.slice(start, end + 1));
console.log(`提取到 ${arr.length} 条文章\n`);

// 打印清单
for (let i = 0; i < arr.length; i++) {
  const a = arr[i];
  console.log(
    `${String(i + 1).padStart(2, "0")}. [${a.category || "?"}] ${a.source || "?"} | ${a.date || "?"}` +
    (a.gz_hint ? " | gz_hint" : "") + `\n    ${a.title || "(无标题)"}` +
    `\n    ${a.url || ""}`,
  );
}

const out = resolve(process.cwd(), `data/replay/extracted-${date}.json`);
writeFileSync(out, JSON.stringify(arr, null, 2) + "\n");
console.log(`\n已落盘: ${out}`);
