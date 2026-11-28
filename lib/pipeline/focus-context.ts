/**
 * 经营重点的运行时加载（二期 WP6 装配层）。
 *
 * 为什么单独一个文件：加载（IO）会在**两处**被用到 ——
 *  1. `side-exec-summary` 构建 exec 池与必读护栏时需要 focus 参与排序；
 *  2. `pipeline/index` 给条目打命中标签、给首页聚合「本期经营重点」时需要同一份。
 * 两处各写一遍必然出现「排序用的重点」与「打标用的重点」不是同一批（配置改到一半
 * 或一侧吞了异常时尤其明显），故统一从这里取。
 *
 * 降级（规格 10.2）：本函数**绝不抛错**。开关关闭 / 配置缺失 / JSON 损坏 / 全部过期
 * 一律返回空物品 + 空版本号，调用方随之退回一期行为。
 */
import type { FocusItem } from "../services/business-focus/types";
import { loadFocusConfig, isFocusEffective } from "../services/business-focus/config-loader";
import { readFocusConfigFiles } from "../adapters/business-focus/config-store";
import type { Logger } from "../contracts/pipeline";
import type { DailyReport } from "../contracts/report";
import { buildFocusDay } from "../services/assemble/focus-metadata";
import { archiveFocusVersion, focusLedgerSummary, mergeFocusDay } from "../services/business-focus/ledger";
import {
  readFocusLedger,
  readVersionArchive,
  writeFocusLedger,
  writeVersionArchive,
} from "../adapters/business-focus/ledger-store";

export interface FocusContext {
  /** 本次运行生效的重点（status=active 且在生效窗口内）。空数组 = 不参与。 */
  items: FocusItem[];
  /** 配置内容指纹（f-xxxxxxxx）。空串 = 未从配置读到任何版本。 */
  version: string;
  /** 损坏的配置文件（用于告警与页面提示；空 = 全部正常）。 */
  corruptFiles: string[];
}

const EMPTY: FocusContext = { items: [], version: "", corruptFiles: [] };

/**
 * 加载本次运行生效的经营重点。
 * @param today 报告日期键（北京时间 YYYY-MM-DD）——生效窗口按它判定，不看系统时钟
 * @param enabled 总开关（`ctx.config.focusEngine`）；关闭时直接返回空
 */
export function loadFocusForRun(today: string, enabled: boolean, log?: Logger): FocusContext {
  if (!enabled) return EMPTY;
  try {
    const files = readFocusConfigFiles();
    const corruptFiles = files.filter((f) => f.state === "corrupt").map((f) => f.file);
    if (corruptFiles.length) {
      log?.warn(
        "focus",
        `⚠️ 经营重点配置损坏，已跳过该层：${corruptFiles.join("、")}` +
          `（这不是「本季度没重点」，请修 JSON）`,
      );
    }
    const loaded = loadFocusConfig(files, { today });
    const items = loaded.items.filter((it) => isFocusEffective(it, today));
    if (items.length) {
      log?.info(
        "focus",
        `🎯 本期经营重点 ${items.length} 条（配置版本 ${loaded.version}）：` +
          items.map((it) => `${it.name}[${it.layer}/${it.grade}]`).join("、"),
      );
    }
    return { items, version: loaded.version, corruptFiles };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log?.warn("focus", `经营重点引擎异常，退回一期基础排序：${msg}`);
    return EMPTY;
  }
}

/**
 * 记录本次运行的重点命中（二期 WP7：台账 + 版本归档）。
 *
 * 为什么挂在装配层而不是服务层：写作两份文件是 IO，服务层零 IO（架构红线）；
 * 为什么和 loadFocusForRun 放一起：**读的重点与记的重点必须是同一批同版本**，
 * 分开两处取用迟早出现「排序按 v1、台账记 v2」。
 *
 * 三条降级（一律只告警、绝不抛错 —— 台账坏了不能拖垮当天日报）：
 *  - 引擎关 / 无配置 / 无版本号 → 什么都不写（不留空壳天，避免专题页出现「当天 0 命中」的假信号）；
 *  - 台账 corrupt → **拒绝写回**（原文件保留，等人工处理；空台账覆盖 = 历史被静默清空）；
 *  - 写盘失败 → 告警，报告照常出。
 *
 * @param focuses 本次**全部**生效重点（年度+季度+临时）：台账是数据层，不预设展示口径
 * @param files 仅测试注入用（生产走 adapter 默认路径 `data/focus-ledger.json` /
 *   `data/focus/versions.json`）；路径必须参数化，`path.resolve` 在 import 时求值，测试改 cwd 来不及
 */
export function recordFocusRun(
  report: DailyReport,
  focuses: readonly FocusItem[],
  version: string,
  log?: Logger,
  files?: { ledger?: string; versions?: string },
): void {
  if (!focuses.length || !version || !report.date) return;
  try {
    const day = buildFocusDay(report, focuses, version, report.date);
    if (!day) return;

    const read = readFocusLedger(files?.ledger);
    if (read.state === "corrupt") {
      log?.warn("focus", `重点台账解析失败，本次拒绝写回（历史保留）: ${read.error}`);
    } else {
      const merged = mergeFocusDay(read.data, day);
      writeFocusLedger(merged, files?.ledger);
      const s = focusLedgerSummary(merged);
      log?.info(
        "focus",
        `重点台账：${day.date} 命中 ${day.hits.length} 条（M3 ${day.hits.filter((h) => h.level === "M3").length} 处）· ` +
          `累计 ${s.days} 天 / ${s.hits} 条`,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log?.warn("focus", `重点台账写入失败（不影响本期报告）: ${msg}`);
  }

  try {
    const read = readVersionArchive(files?.versions);
    if (read.state === "corrupt") {
      log?.warn("focus", `重点版本归档解析失败，本次拒绝写回（历史保留）: ${read.error}`);
      return;
    }
    const before = read.data.versions.length;
    const archive = archiveFocusVersion(read.data, { version, date: report.date, focuses });
    writeVersionArchive(archive, files?.versions);
    if (archive.versions.length > before) {
      log?.info("focus", `重点配置版本归档：新增 ${version}（累计 ${archive.versions.length} 版）`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log?.warn("focus", `重点版本归档写入失败（不影响本期报告）: ${msg}`);
  }
}
