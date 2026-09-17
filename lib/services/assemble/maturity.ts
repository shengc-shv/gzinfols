/**
 * 商机成熟度标注（C2，2026-09-17）—— 给每条商机打「阶段 + 依据词 + 下一步」。
 *
 * 零 LLM：阶段判定走 `classify/maturity`（确定性词表，可核对），
 * 下一步走**动作库**（阶段 × 客群 → 一句话动作）。
 *
 * 为什么动作库用确定性文案、不让 LLM 写：
 *   ① 成本零（不增 token）；
 *   ② 可测可回归（LLM 输出没法锁）；
 *   ③ **不越界** —— LLM 看不到行内状态与资源约束，写出来的「推动落地」很容易变成
 *      空话或超纲指令。动作库的措辞刻意保持「可做/可查/可等」这类低承诺表述，
 *      并与 PASS2 既有口径一致（避免「分行应/须尽快」这类强硬祈使）。
 *
 * 纯函数、幂等、不 mutate 入参。
 */
import type { DailyReport, MaturityMark, MaturityStage } from "../../contracts/report";
import { maturityOf } from "../classify/maturity";

/** 客群 → 动作库键（与 `ReportInsight.segments` 的取值同源）。 */
type SegKey = "aum" | "hnw" | "inclusive" | "other";

function segKeyOf(segments: string[] | undefined): SegKey {
  const s = (segments ?? []).join(" ");
  if (/零售AUM|AUM/i.test(s)) return "aum";
  if (/中高端|过亿|私行|高净值/.test(s)) return "hnw";
  if (/普惠|小微/.test(s)) return "inclusive";
  return "other";
}

/**
 * 动作库：阶段 × 客群 → 下一步（一句话，低承诺、可执行、可核对）。
 *
 * 设计取舍：**不写「本周必须」「尽快落实」这类时限硬指令** —— 简报是给行领导看的
 * 二手线索，不是派工单；写死时限会让读者把机器判定当成行内决议。
 */
const NEXT_STEP: Record<MaturityStage, Record<SegKey, string>> = {
  clue: {
    aum: "先建档跟踪：把主体纳入目标名单，等出现预算/招标/审批等硬信号再评估接触",
    hnw: "先核关系：公开披露的股东与高管名单可作为切入点参考，暂不必投入触达资源",
    inclusive: "先看上下游：园区配套与供应链上的小微通常比主体更早出现融资需求",
    other: "先纳入观察名单，等出现程序性动作（招标/获批/签约）再评估",
  },
  progress: {
    aum: "可对接资金安排：进入程序阶段后，开户/结算/项目贷需求通常先于主体落地出现",
    hnw: "可确认股权结构：此阶段股东与持股平台信息已披露，适合先做客户识别与分层",
    inclusive: "可摸排投标与分包名单：中标前后的上下游名单是最直接的获客入口",
    other: "先确认时间表：程序阶段的关键节点（开标/批复/签约）决定后续接触窗口",
  },
  landed: {
    aum: "可谈结算与留存：项目已落地，账户开立、代发与资金归集进入可谈窗口",
    hnw: "可谈综合服务：主体已实质运营，适合一次性对齐授信、跨境与财富安排",
    inclusive: "可切入供应链：运营期采购与用工需求明确，上下游名单可直接对接",
    other: "可进入实质接触：确定性动作已完成，按常规客户流程推进即可",
  },
};

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
 * 单条商机 → 成熟度标注。
 */
export function maturityMarkOf(it: {
  topic?: string;
  impact?: string;
  action?: string;
  segments?: string[];
}): MaturityMark {
  const verdict = maturityOf(sourceTextOf(it));
  const nextStep = NEXT_STEP[verdict.stage][segKeyOf(it.segments)];
  return {
    stage: verdict.stage,
    ...(verdict.evidence ? { evidence: verdict.evidence } : {}),
    nextStep,
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
