/**
 * 红筹呈现 · 「来源 / 新鲜度 / 降级」口径（纯函数，零 IO，服务层）。
 *
 * 背景（2026-10-03 实测）：报告面板的「数据截至」只来自 `data/redchip/latest.json`，
 * 而该文件被 `.gitignore` 拦住、CI 侧根本不存在 → 8 期报告该字段全为空，
 * 读者看到的是一个「没有日期、数字永不变化」的面板。
 *
 * 本模块只回答一个问题：**在给定的证据下，呈现层应该怎么写？**
 * 三条铁律：
 *   ① 有更权威的来源（抓取元信息）就用它，并标明「数据截至」；
 *   ② 只有台账派生时刻时，措辞必须收敛为「台账更新至」—— 它不等于「那一刻跑过抓取」；
 *   ③ 缺失/过期/源失败**必须显式说明**，不得静默沿用旧数字让读者误以为是今天的。
 */
import { dayGap } from "../../utils/time";

/** 源可读名（呈现用；未知源回落 id 本身）。 */
export const REDCHIP_SOURCE_LABELS: Record<string, string> = {
  hk: "港股",
  us: "美股",
};

export interface ProvenanceInput {
  /** 数据时刻（北京时间 ISO）；缺省 = 拿不到任何时间戳。 */
  capturedAt?: string;
  /** 报告日（北京时间 YYYY-MM-DD），过期判定的基准。 */
  today: string;
  /** 本次未取到数据的源 id（如 `["us"]`）；空数组 = 全部正常。 */
  failedSources?: string[];
  /** 判定「过期」的天数阈值（默认 2）。 */
  staleDays?: number;
}

/** 源 id → 可读名。 */
export function sourceLabel(id: string): string {
  return REDCHIP_SOURCE_LABELS[id] ?? id;
}

/**
 * 新鲜度降级说明（无异常 → undefined）。
 *
 * 三条独立判据（可并列，用「；」连接）：
 *   ① 完全没有时间戳 → 说明「以下为历史在册线索」；
 *   ② 某个源本期未取到数据 → 点名该源；
 *   ③ 时间戳距今超过 `staleDays` → 说出天数。
 *
 * ⚠️ 时间红线：`capturedAt` 缺失时**不编造**，只如实说明缺失。
 */
export function redchipFreshnessNote(input: ProvenanceInput): string | undefined {
  const notes: string[] = [];
  const capturedAt = input.capturedAt;

  if (!capturedAt) {
    notes.push("⚠️ 未取得红筹数据时间戳");
  } else {
    const day = capturedAt.slice(0, 10);
    const gap = /^\d{4}-\d{2}-\d{2}$/.test(day) ? dayGap(day, input.today) : 0;
    const staleDays = input.staleDays ?? 2;
    if (gap > staleDays) notes.push(`⚠️ 红筹数据已 ${gap} 天未更新`);
  }

  const failed = (input.failedSources ?? []).filter(Boolean);
  if (failed.length) {
    notes.push(`⚠️ 本期未取到${failed.map(sourceLabel).join("、")}数据`);
  }

  return notes.length ? notes.join("；") : undefined;
}
