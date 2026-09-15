// 调试：用项目自身 validator 校验 replay 的 pass2 输出，定位 block 规则。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateReport } from "../lib/services/enrich/validator";
import type { DailyReport } from "../lib/contracts/report";

const date = process.argv[2] || "2026-09-15";
const pass2 = JSON.parse(
  readFileSync(resolve(process.cwd(), `data/replay/${date}/pass2.response.txt`), "utf8"),
) as DailyReport;
pass2.date = date;

const arts = JSON.parse(
  readFileSync(resolve(process.cwd(), `data/replay/extracted-2026-09-13.json`), "utf8"),
) as Array<{ url: string; raw_text: string }>;
const pool = {
  get: (url: string) => {
    const a = arts.find((x) => x.url === url);
    return a ? { raw_text: a.raw_text } : undefined;
  },
};

const issues = validateReport(pass2, pool);
for (const i of issues) console.log(`[${i.level}] ${i.where} → ${i.msg}`);
if (issues.length === 0) console.log("✅ 无 block/warn");

// 检查海柔条目的 title_cn 是否进入 pass2
const haRou = pass2.sections.ipo.find((i) => i.url.includes("108870"));
console.log("\n海柔条目 title_cn:", haRou?.title_cn);
console.log("海柔 summary:", haRou?.summary);
