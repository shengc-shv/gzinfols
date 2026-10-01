/**
 * 商机成熟度标注（C2，2026-09-17）—— 给每条商机打「阶段 + 判定依据词」。
 *
 * 零 LLM：阶段判定走 `classify/maturity`（确定性词表，可核对）。
 *
 * ⛔ 2026-10-01 sc 口径：**「下一步」动作库已删除（勿加回）** ——
 * 原实现按「阶段 × 客群」给一句确定性行动指引（如「先建档跟踪…」）。删除理由：
 * 全篇只客观呈现事实与影响，不输出任何操作建议/行动指引 —— 行领导各有自己的工作思路，
 * 替他安排动作既越位、又让卡片显得啰嗦。**阶段徽章保留**（线索/推进/落地 = 信号走到哪一步，
 * 是客观状态而非行动指令）。契约字段 `MaturityMark.nextStep` 保留 `@deprecated` 以兼容历史数据。
 *
 * 纯函数、幂等、不 mutate 入参。
 */
import type { DailyReport, MaturityMark } from "../../contracts/report";
import { maturityOf } from "../classify/maturity";

/**
 * 判定取材（**关键设计**）：标题 + 影响的**首句**。
 *
 * 为什么收窄到这一步（2026-09-17 实测）：
 * ① **不含 `action`** —— 它是「建议动作」，天然带未来语境（"本周完成…自查"、
 *    "可考虑推动…"）。拿它判定会把「已落地的事」判回线索、或把「建议启动」判成推进。
 * ② **只取 impact 首句** —— 首句是事件本身（"…中心揭牌"、"…综合体开工"），
 *    后文是分析与延伸，越往后越容易撞上无关词（实测：「存量产品」被跨词匹配成「量产」，
 *    把一条理财信披商机判成了「落地」）。
 */
function sourceTextOf(it: { topic?: string; impact?: string }): string {
  const topic = (it.topic ?? "").trim();
  const firstSentence = ((it.impact ?? "").trim().split(/[。！？；;]/)[0] ?? "").trim();
  return `${topic} ${firstSentence}`.slice(0, 120);
}

/**
 * 单条商机 → 成熟度标注（只含「阶段 + 依据词」，不含行动建议）。
 */
export function maturityMarkOf(it: { topic?: string; impact?: string }): MaturityMark {
  const verdict = maturityOf(sourceTextOf(it));
  return {
    stage: verdict.stage,
    ...(verdict.evidence ? { evidence: verdict.evidence } : {}),
  };
}

/** 给报告里全部商机洞察标注成熟度（幂等；不 mutate 入参）。 */
export function annotateMaturity(report: DailyReport): DailyReport {
  const insights = (report.insights ?? []).map((it) => ({
    ...it,
    maturity: maturityMarkOf(it),
  }));
  return { ...report, insights };
}
