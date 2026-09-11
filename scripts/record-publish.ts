/**
 * 记录一次 gh-pages 发布来源到 data/publish-state.json（2026-09-03）。
 *
 * 移植自 gzinfo `scripts/record-publish-state.ts`（逐字逻辑）；唯一适配：
 *  - 落盘/读盘改经 `lib/adapters/persistence.ts`（端口-适配器分层，IO 归适配器），
 *    从而支持 `setPersistenceBaseDir` / `baseDir` 参数做测试隔离；
 *  - 不再使用 `__dirname`（2.0 为 ESM，无此全局），改用适配器的 process.cwd() 基目录。
 *
 * 由 .github/workflows/daily.yml 在 publish 步骤**成功之后**调用：
 *   - source=schedule（schedule 正式首发）→ published-check 据此让当天后续 schedule 跳过
 *   - source=manual-final（dispatch release_mode=final）→ 阻断同日 cron 重复发布
 *   - source=manual-test（dispatch release_mode=test）→ 不阻断同日 schedule 首发
 *     （首次 schedule 命中会再发正式版覆盖测试版 —— 凌晨 dispatch 测试不再吞掉正式首发）
 *
 * 先发后记：gh-pages push 成功才记账，避免「记了没发」导致次日误判已发布。
 *
 * env：
 *   REPORT_TZ      可选 报告时区（默认 Asia/Shanghai，决定「今天」是哪一天）
 *   SOURCE         必填 schedule | manual | manual-final | manual-test（发布来源）
 *   GITHUB_RUN_ID  可选 发布 run id（溯源，与 gh-pages commit message 同源）
 *
 * 用法：npm run record-publish
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadPublishState, persistPublishState } from "../lib/adapters/persistence";
import {
  prunePublishState,
  recordPublish,
  type PublishSource,
  type PublishState,
} from "../lib/services/publish/publish-state";
import { formatBroadcastAt, memoryTimeZone } from "../lib/services/memory/broadcast-time";

/** 保留最近 N 天（与 gzinfo 一致）。 */
export const KEEP_DAYS = 7;

/** 合法发布来源集合（与 gzinfo 校验一致）。 */
export const VALID_SOURCES: readonly PublishSource[] = [
  "schedule",
  "manual",
  "manual-final",
  "manual-test",
];

function log(msg: string): void {
  console.log(`[record-publish] ${msg}`);
}

/** 校验来源字符串；非法返回 undefined（供脚本与测试共用）。 */
export function parseSource(raw: string | undefined): PublishSource | undefined {
  return raw === "schedule" || raw === "manual" || raw === "manual-final" || raw === "manual-test"
    ? raw
    : undefined;
}

/** 报告时区下的「今天」YYYY-MM-DD（gzinfo 同款 en-CA 口径）。 */
export function reportDate(tz: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export interface RecordPublishInput {
  /** 发布来源（必填，非法则不写盘、返回 undefined）。 */
  source: string | undefined;
  /** 报告日期 YYYY-MM-DD（记账 key）。 */
  dateStr: string;
  /** 发布成功时刻（ISO 8601 带时区）。 */
  publishedAt: string;
  /** 发布 run id（可空）。 */
  runId: string;
  /** 数据根目录覆盖（测试隔离）；默认 process.cwd()。 */
  baseDir?: string;
  /** 日志口（默认 console）。 */
  log?: (msg: string) => void;
}

/**
 * 读 → `prunePublishState(recordPublish(...), 7, dateStr)` → 落盘（经适配器 IO）。
 *
 * 返回写入后的 state；source 非法时打印错误并返回 undefined（**不写盘**）。
 * 纯编排：业务规则（recordCron 判据 / prune 规则）全在 services 层，本函数只做接线。
 */
export function runRecordPublish(input: RecordPublishInput): PublishState | undefined {
  const emit = input.log ?? log;
  const source = parseSource(input.source);
  if (!source) {
    emit(`SOURCE 缺失或非法（got: ${String(input.source)}）— 期望 schedule|manual-final|manual-test`);
    return undefined;
  }

  const state = loadPublishState({ baseDir: input.baseDir });
  const next = prunePublishState(
    recordPublish(state, input.dateStr, {
      source,
      runId: input.runId,
      publishedAt: input.publishedAt,
    }),
    KEEP_DAYS,
    input.dateStr,
  );
  persistPublishState(next, { baseDir: input.baseDir });

  emit(
    `✅ 已记录发布来源：${input.dateStr} source=${source} @ ${input.publishedAt}${input.runId ? `（run ${input.runId}）` : ""}`,
  );
  emit(
    source === "schedule"
      ? "次日/后续 schedule 命中将据此跳过重复发布。"
      : source === "manual-final"
        ? "manual-final（手动终版）记录将阻断同日 schedule 重复发布 —— cron 不再覆盖你的手动版。"
        : "manual-test（手动验证）记录不阻断同日 schedule 首发；首次 schedule 命中仍会发布正式版。",
  );
  return next;
}

/** 从 env 取参数并记账（进程入口逻辑）。 */
function main(): void {
  const tz = process.env.REPORT_TZ || "Asia/Shanghai";
  const dateStr = reportDate(tz);

  const raw = process.env.SOURCE;
  if (!parseSource(raw)) {
    log(
      `SOURCE 缺失或非法（got: ${String(raw)}）— 期望 schedule|manual-final|manual-test，退出 1`,
    );
    process.exit(1);
  }

  const publishedAt = formatBroadcastAt(new Date(), memoryTimeZone());
  const runId = process.env.GITHUB_RUN_ID || "";

  runRecordPublish({ source: raw, dateStr, publishedAt, runId });
}

/** 是否直接执行（被测试 import 时不触发 main）。 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) main();
