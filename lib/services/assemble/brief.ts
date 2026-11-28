/**
 * 新版经营情报首页 · 三层内容生成（2026-11-28）。
 *
 * 只做**一次批量 LLM**：输入是已定稿的 must_read（标题 / why / 正文 summary /
 * 同 URL 商机 impact），输出：
 *   - core_judgment：50~80 字核心判断；
 *   - priorities：3~5 条「今日经营重点」三段式（short / what / impact / watch）。
 *
 * 边界（与 attention 同口径）：
 *  - 只使用给定候选事实，不得引入外部信息、不得编造数字/机构；
 *  - 不给操作建议/行动指令；
 *  - 不输出 URL、领域、状态、重要性 —— 这些由既有报告字段回填；
 *  - 任何解析/校验失败 → 返回 undefined，渲染层回退到 hero_line + must_read，
 *    绝不阻断发布。
 */
import type {
  DailyReport,
  ReportBrief,
  ReportBriefPriority,
  ReportInsight,
  ReportItem,
} from "../../contracts/report";
import type { LlmPort, Logger } from "../../contracts/pipeline";
import { extractJson } from "../enrich/json-util";

export const BRIEF_MIN_PRIORITIES = 3;
export const BRIEF_MAX_PRIORITIES = 5;
const CORE_MIN = 15;
const CORE_MAX = 90;
const SHORT_MIN = 5;
const SHORT_MAX = 50;
const PART_MIN = 15;
const PART_MAX = 110;
const WATCH_MIN = 8;
const WATCH_MAX = 80;

export interface BriefCandidate {
  ref: string;
  title: string;
  url?: string;
  why: string;
  fact: string;
  impact: string;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 候选 = must_read（最多 5 条）；正文/商机按 URL 回填，找不到就用 why。 */
export function collectBriefCandidates(report: DailyReport): BriefCandidate[] {
  const bodyMap = new Map<string, ReportItem>();
  for (const sec of Object.values(report.sections ?? {})) {
    for (const it of sec ?? []) if (it.url) bodyMap.set(it.url, it);
  }
  const impactMap = new Map<string, ReportInsight>();
  for (const ins of report.insights ?? []) {
    for (const s of ins.sources ?? []) if (s?.url) impactMap.set(s.url, ins);
  }
  const out: BriefCandidate[] = [];
  for (const m of (report.must_read ?? []).slice(0, 5)) {
    const body = m.url ? bodyMap.get(m.url) : undefined;
    const title = (m.title || body?.title_cn || "").trim();
    if (!title) continue;
    out.push({
      ref: `m${out.length + 1}`,
      title,
      url: m.url,
      why: clip((m.why ?? "").trim(), 120),
      fact: clip((body?.summary ?? "").trim(), 180),
      impact: clip((m.url ? impactMap.get(m.url)?.impact ?? "" : "").trim(), 160),
    });
  }
  return out;
}

export function buildBriefPrompt(
  cands: BriefCandidate[],
  risk?: { topic: string; evidence: string; impact: string },
): { system: string; prompt: string } {
  const system = [
    "你是股份制银行分行零售业务的情报编辑，服务对象是分行经营管理者。",
    "你要把当天已定稿的必读素材，压缩成「30 秒总览 + 3 分钟重点阅读」两段文字。",
    "",
    "硬性要求：",
    "1. 只能使用给定候选里的事实，不得引入外部信息，不得编造数字、机构或政策条款。",
    "2. 不得虚构本行经营数据；不得把外部变化表述为本行已经受到影响。",
    "3. 不写操作建议、行动指令、目标或「建议尽早布局」这类话。",
    "4. 不写「值得关注」「详见报告」「持续跟踪」这类空转句；每句必须有信息量。",
    "5. 三段式分工：what = 发生了什么（主体/事件/关键数字）；impact = 对广州分行零售经营意味着什么；watch = 接下来值得观察的变量（不是动作）。",
    "6. impact 尽量落到六个方向之一：财富管理与AUM、客户经营与客群增长、零售信贷与住房金融、渠道经营/数字化/AI、风险管理与消费者保护、区域经济与同业竞争。",
    "7. priorities 按真实重要度排序，3~5 条；不足 3 条不要凑；同一事件不得拆成多条。",
    "8. core_judgment 只做今日主判断，50~80 字；不要复述某一条候选，不要写成分点清单。",
    "9. ref 只能填候选的 mN 编号，不得自造；只输出 JSON，不要解释文字。",
    "10. 若【风险候选】比必读更重大，core_judgment 可以直接点出该风险；但 priorities 仍只能从 mN 选，不得把风险编号写进 ref。",
  ].join("\n");

  const lines: string[] = ["【今日候选】"];
  for (const c of cands) {
    lines.push(
      `[${c.ref}] 标题：${c.title}｜必读理由：${c.why || "无"}｜正文事实：${c.fact || "无"}｜商机影响：${c.impact || "无"}`,
    );
  }
  if (risk) {
    lines.push("");
    lines.push(`【风险候选】${risk.topic}｜事实：${clip(risk.evidence, 160)}｜影响：${clip(risk.impact, 140)}`);
    lines.push("（仅用于 core_judgment；priorities 不得引用风险候选。）");
  }
  lines.push("");
  lines.push("【输出格式】严格 JSON：");
  lines.push(
    '{"core_judgment":"核心判断，50~80字","priorities":[{"ref":"m1","short":"一句话变化，≤40字","what":"发生了什么，≤90字","impact":"对经营意味着什么，≤90字","watch":"接下来关注什么，≤60字"}]}',
  );
  lines.push("");
  lines.push("【字数】core_judgment 50~80 字；short 15~40 字；what/impact 各 30~90 字；watch 15~60 字。");
  return { system, prompt: lines.join("\n") };
}

/** 解析 + 确定性校验（纯函数，不信任 LLM）。 */
export function parseBrief(raw: string, cands: BriefCandidate[]): ReportBrief | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const o = parsed as Record<string, unknown>;
  const core = str(o.core_judgment);
  const coreOk = core.length >= CORE_MIN && core.length <= CORE_MAX;
  const arr = Array.isArray(o.priorities) ? o.priorities : [];
  const byRef = new Map(cands.map((c) => [c.ref, c]));
  const seen = new Set<string>();
  const priorities: ReportBriefPriority[] = [];

  for (const x of arr) {
    if (!x || typeof x !== "object") continue;
    const p = x as Record<string, unknown>;
    const ref = str(p.ref);
    const c = byRef.get(ref);
    if (!c || seen.has(ref)) continue;
    const short = str(p.short);
    const what = str(p.what);
    const impact = str(p.impact);
    const watch = str(p.watch);
    if (short.length < SHORT_MIN || short.length > SHORT_MAX) continue;
    if (what.length < PART_MIN || what.length > PART_MAX) continue;
    if (impact.length < PART_MIN || impact.length > PART_MAX) continue;
    if (watch.length < WATCH_MIN || watch.length > WATCH_MAX) continue;
    seen.add(ref);
    priorities.push({
      title: c.title,
      url: c.url,
      short,
      what,
      impact,
      watch,
    });
    if (priorities.length >= BRIEF_MAX_PRIORITIES) break;
  }

  // 3 条以上候选却只选出 1~2 条 → 视为不合格，只保留核心判断，重点交渲染层回退 must_read。
  const min = Math.min(BRIEF_MIN_PRIORITIES, cands.length);
  if (priorities.length < min) {
    return coreOk ? { core_judgment: core, priorities: [] } : undefined;
  }
  return {
    core_judgment: coreOk ? core : "",
    priorities,
  };
}

/**
 * 风险硬兜底（2026-11-28）：极高优先级风险 = 官方源 T1 且非纯续报。
 * 这是确定性下限，不依赖 LLM 是否选中；口径集中在这里，后续可调。
 */
export function isCriticalRisk(risk: DailyReport["risk"]): boolean {
  if (!risk?.topic) return false;
  if (risk.source !== "T1") return false;
  return !risk.delta || risk.delta.state !== "followup";
}

function flatTitle(s: string): string {
  return (s ?? "").toLowerCase().replace(/[\s，。！？、；：“”‘’（）()《》\-—·]/g, "");
}

function sameEvent(title: string, urls: string[], otherTitle: string, otherUrls: string[]): boolean {
  if (urls.some((u) => u && otherUrls.includes(u))) return true;
  const a = flatTitle(title);
  const b = flatTitle(otherTitle);
  if (!a || !b) return false;
  if (a === b && a.length >= 4) return true;
  if (a.length < 8 || b.length < 8) return false;
  return a.includes(b) || b.includes(a);
}

function criticalRiskPriority(risk: NonNullable<DailyReport["risk"]>): ReportBriefPriority {
  const url = risk.url || (risk.sources ?? []).find((s) => s?.url)?.url;
  const topic = risk.topic.trim();
  return {
    title: topic,
    url,
    short: clip(topic.length >= 5 ? topic : `风险预警：${topic}`, 50),
    what: risk.evidence?.trim() || topic,
    impact: risk.impact?.trim() || "需关注监管口径、客户影响与声誉风险。",
    watch: "关注后续监管口径、客户投诉与同业跟进。",
    riskLevel: "critical",
  };
}

/**
 * 组装层前置校验：极高风险若未被核心判断/第二层纳入，挂到 `promotedRisk`，
 * 由渲染层强制置顶。返回新对象，不 mutate 入参。
 */
export function promoteCriticalRisk(report: DailyReport): DailyReport {
  const risk = report.risk;
  if (!risk || !isCriticalRisk(risk)) return report;
  const core = flatTitle(report.brief?.core_judgment || report.hero_line || "");
  const riskTitle = flatTitle(risk.topic);
  if (riskTitle.length >= 8 && core.includes(riskTitle)) return report;

  const priorities = report.brief?.priorities ?? [];
  const idx = priorities.findIndex((p) =>
    sameEvent(p.title, p.url ? [p.url] : [], risk.topic, [
      risk.url ?? "",
      ...(risk.sources ?? []).map((s) => s?.url ?? ""),
    ]),
  );
  if (idx >= 0) {
    const next = priorities.map((p, i) => (i === idx ? { ...p, riskLevel: "critical" as const } : p));
    return { ...report, brief: { ...(report.brief as ReportBrief), priorities: next } };
  }
  return { ...report, promotedRisk: criticalRiskPriority(risk) };
}

/**
 * 生成新版首页 brief。任何失败返回 undefined；调用方不得因它阻断发布。
 */
export async function buildBrief(
  report: DailyReport,
  opts: { llm?: LlmPort; log?: Logger },
): Promise<ReportBrief | undefined> {
  const cands = collectBriefCandidates(report);
  if (cands.length < 1 || !opts.llm) return undefined;
  const { system, prompt } = buildBriefPrompt(cands, report.risk);
  try {
    const raw = await opts.llm.complete({
      system,
      prompt,
      expectJson: true,
      temperature: 0.25,
      maxTokens: 1200,
      stage: "brief",
    });
    const brief = parseBrief(raw, cands);
    if (!brief) {
      opts.log?.warn("brief", "新版首页 brief 校验未通过，渲染层回退 must_read");
      return undefined;
    }
    opts.log?.info(
      "brief",
      `新版首页 brief：候选 ${cands.length} 条 → 核心判断 ${brief.core_judgment ? "有" : "无"} / 重点 ${brief.priorities.length} 条`,
    );
    return brief;
  } catch (e) {
    opts.log?.warn(
      "brief",
      `新版首页 brief 生成失败，回退 must_read（不影响发布）：${e instanceof Error ? e.message : String(e)}`,
    );
    return undefined;
  }
}
