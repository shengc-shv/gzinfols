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
