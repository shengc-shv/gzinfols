/**
 * 管理关注 · 独立研判（2026-11-28 · sc 定向修订任务书 任务二）。
 *
 * 改前：`decision-view.ts` 直接把**今日必读前 2 条 + 风险 1 条**换个卡片样式再展示一遍，
 * 跨条线判定用 `tags.length > 1`。六模块本该各答一问，管理关注却只是必读的摘要副本。
 *
 * 改后：管理关注在**组装阶段**独立生成，渲染层只读。
 *   ① 候选池 = 定稿后的必读 / 商机 / 风险（每条带已有的经营领域标签，见 ⑦.10）；
 *   ② **1 次批量 LLM** 提炼 1~3 条「管理层值得关注的问题」；
 *   ③ **确定性校验（不信任 LLM）**：
 *      - source_urls 必须原样来自候选（防凭空引用）；
 *      - domains 必须合法；跨条线 = domains ≥ 2（不再看标签数量）；
 *      - 与必读某条高度重复且只引那一条 → 判为复述，剔除；
 *      - 只引风险一条且不带额外领域 → 剔除（风险模块已说过）；
 *      - topic 互相重复 → 保留先出现的；
 *      - 最多 3 条；**宁缺毋滥，0 条就整块不展示**。
 *   ④ 任何异常（无 LLM / 超时 / 解析失败 / 校验全被剔除）→ 返回空数组，**绝不阻断发布**。
 *
 * 边界（任务书 3.5）：只基于公开信息的经营研判，不是行内管理指令 ——
 * prompt 明令禁止虚构本行数据、禁止把外部变化表述为本行已受影响、禁止命令式语言；
 * 校验层再兜一次「不确定时用审慎措辞」的措辞检查（见 ABSOLUTE_WORDING）。
 */
import type { ReportAttention, DailyReport } from "../../contracts/report";
import type { LlmPort, Logger } from "../../contracts/pipeline";
import { BUSINESS_DOMAINS, DOMAIN_IDS } from "../vocab/business-domains";
import { titleSim } from "../memory/event-text";
import { extractJson } from "../enrich/json-util";

/** 最多展示条数（任务书 3.6）。 */
export const MAX_ATTENTION = 3;
/** 候选上限（必读 5 + 商机 6 + 风险 1，留点余量）。 */
const MAX_CANDIDATES = 14;
/** 候选事实截断（只给 LLM 一句，避免把整份报告塞进 prompt）。 */
const FACT_CLIP = 90;
/** 判为「复述」的标题相似度阈值（与判重链的同一主题阈值同口径，不新造刻度）。 */
const RESTATE_SIM = 0.7;

/** 命令式 / 越界措辞：命中即判该条不合格（任务书 3.5）。 */
const ABSOLUTE_WORDING = [/必须立即/, /要求各部门/, /责成/, /立刻开展/, /马上落实/, /全行上下必须/];

export interface AttentionCandidate {
  kind: "must_read" | "insight" | "risk";
  title: string;
  fact: string;
  urls: string[];
  domains: string[];
}

const KIND_LABEL: Record<AttentionCandidate["kind"], string> = {
  must_read: "今日必读",
  insight: "商机洞察",
  risk: "风险预警",
};

/** 从定稿报告里提取候选（零 LLM；只取已有 url 的条目）。 */
export function collectAttentionCandidates(report: DailyReport): AttentionCandidate[] {
  // url → 经营领域（含相关领域）：取自 ⑦.10 已打标的正文条目
  const domByUrl = new Map<string, string[]>();
  for (const it of Object.values(report.sections ?? {}).flat()) {
    if (!it?.url) continue;
    const ds = [it.primary_domain, ...(it.related_domains ?? [])].filter(
      (d): d is string => Boolean(d) && DOMAIN_IDS.includes(d),
    );
    if (ds.length) domByUrl.set(it.url, [...new Set(ds)]);
  }
  const domsOf = (urls: string[]): string[] => {
    const out = new Set<string>();
    for (const u of urls) for (const d of domByUrl.get(u) ?? []) out.add(d);
    return [...out];
  };

  const out: AttentionCandidate[] = [];
  for (const m of report.must_read ?? []) {
    if (!m.url) continue;
    const urls = [m.url];
    out.push({ kind: "must_read", title: m.title ?? "", fact: m.why ?? "", urls, domains: domsOf(urls) });
  }
  for (const it of report.insights ?? []) {
    const urls = (it.sources ?? []).map((s) => s?.url).filter((u): u is string => Boolean(u));
    if (!urls.length) continue;
    out.push({ kind: "insight", title: it.topic ?? "", fact: it.impact ?? "", urls, domains: domsOf(urls) });
  }
  if (report.risk) {
    const urls = [
      ...(report.risk.sources ?? []).map((s) => s?.url),
      report.risk.url,
    ].filter((u): u is string => Boolean(u));
    if (urls.length) {
      out.push({
        kind: "risk",
        title: report.risk.topic ?? "",
        fact: report.risk.evidence ?? report.risk.impact ?? "",
        urls: [...new Set(urls)],
        domains: domsOf(urls),
      });
    }
  }
  return out.slice(0, MAX_CANDIDATES);
}

function domainMenu(): string {
  return BUSINESS_DOMAINS.map((d) => `${d.id}（${d.name}）`).join("；");
}

export function buildAttentionPrompt(cands: AttentionCandidate[]): { system: string; prompt: string } {
  const system = [
    "你是股份制银行分行零售业务的情报分析助手。你的任务不是写新闻摘要，而是从当天已定稿的信息里，",
    "提炼出**值得分行管理层进一步了解的管理问题**。",
    "",
    "硬性要求：",
    "1. 只能使用给定候选里的事实，不得引入外部信息，不得编造数字或机构。",
    "2. 不得虚构本行经营数据；不得把外部行业变化表述为本行已经受到影响。",
    "3. 不得使用命令式语言（如「必须立即」「要求各部门」），一律用审慎措辞",
    "   （如「值得关注」「建议进一步了解」「可留意后续落地情况」）。",
    "4. 管理关注必须回答「管理层该了解什么」，不能是某一条候选的标题复述；",
    "   能合并多条候选指向同一个管理问题的，优先合并（并引用多个来源）。",
    "5. 如果当天确实没有够格的管理议题，就返回空数组 []，不要凑数。",
    "6. 只输出 JSON 数组，不要任何解释文字。",
  ].join("\n");

  const lines: string[] = [];
  lines.push("【今日候选】");
  cands.forEach((c, i) => {
    const doms = c.domains.length ? c.domains.join(",") : "无";
    lines.push(
      `[${i + 1}] (${KIND_LABEL[c.kind]}) ${c.title}｜事实：${c.fact.slice(0, FACT_CLIP)}｜领域：${doms}｜来源：${c.urls.join(" ")}`,
    );
  });
  lines.push("");
  lines.push("【输出格式】严格如下 JSON 数组（最多 3 条，可为 []）：");
  lines.push(
    '[{"topic":"管理关注主题（一句话，不超过 40 字）","rationale":"关注依据：引用了哪些候选的哪些关键事实",' +
      '"significance":"管理意义：为什么值得管理层关注（审慎措辞）","domains":["领域id"],"source_urls":["来源url"]}]',
  );
  lines.push("");
  lines.push(`【领域取值】只能从这里选：${domainMenu()}`);
  lines.push("【来源要求】source_urls 必须原样复制上面候选里出现过的 url，不得改写、不得自造。");

  return { system, prompt: lines.join("\n") };
}

/** 解析 + 确定性校验（纯函数，可单测；不信任 LLM 输出）。 */
export function parseAttention(raw: string, cands: AttentionCandidate[]): ReportAttention[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { items?: unknown })?.items)
      ? ((parsed as { items: unknown[] }).items as unknown[])
      : [];

  const urlToCand = new Map<string, AttentionCandidate>();
  for (const c of cands) for (const u of c.urls) if (!urlToCand.has(u)) urlToCand.set(u, c);
  const riskCand = cands.find((c) => c.kind === "risk");
  const mustReadCands = cands.filter((c) => c.kind === "must_read");

  const out: ReportAttention[] = [];
  for (const x of arr) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const topic = String(o.topic ?? "").trim();
    const rationale = String(o.rationale ?? "").trim();
    const significance = String(o.significance ?? "").trim();
    if (!topic || !rationale || !significance) continue;

    // ① 来源必须来自候选（防凭空引用）
    const urls = (Array.isArray(o.source_urls) ? o.source_urls : [])
      .map((u) => String(u ?? "").trim())
      .filter((u) => u.length > 0 && urlToCand.has(u));
    const uniqUrls = [...new Set(urls)];
    if (!uniqUrls.length) continue;

    // ② 命令式 / 越界措辞兜底（prompt 已禁止，这里再判一次）
    const blob = `${topic} ${rationale} ${significance}`;
    if (ABSOLUTE_WORDING.some((re) => re.test(blob))) continue;

    // ③ 领域：只认合法 id；LLM 给空则用来源条目的已有标签兜底
    let domains = (Array.isArray(o.domains) ? o.domains : [])
      .map((d) => String(d ?? "").trim())
      .filter((d) => DOMAIN_IDS.includes(d));
    if (!domains.length) {
      const set = new Set<string>();
      for (const u of uniqUrls) for (const d of urlToCand.get(u)?.domains ?? []) set.add(d);
      domains = [...set];
    }
    domains = [...new Set(domains)];

    // ④ 复述检查：与必读某条高度相似、且只引那一条 → 这就是必读的摘要，剔除
    const restating = mustReadCands.some(
      (m) => titleSim(topic, m.title) >= RESTATE_SIM && uniqUrls.every((u) => m.urls.includes(u)),
    );
    if (restating) continue;

    // ⑤ 风险同源：只引风险那一条、且不带额外领域 → 风险模块已经说过，剔除
    if (
      riskCand &&
      uniqUrls.every((u) => riskCand.urls.includes(u)) &&
      domains.every((d) => riskCand.domains.includes(d))
    ) {
      continue;
    }

    // ⑥ 自身重复：主题高度相似只留先出现的
    if (out.some((a) => titleSim(a.topic, topic) >= RESTATE_SIM)) continue;

    out.push({
      id: `att-${out.length + 1}`,
      topic,
      rationale,
      significance,
      domains,
      source_urls: uniqUrls,
      confidence: "high",
    });
    if (out.length >= MAX_ATTENTION) break;
  }
  return out;
}

/**
 * 生成管理关注。**任何失败都返回空数组**（页面模块不展示），绝不抛错给上层。
 */
export async function buildAttention(
  report: DailyReport,
  opts: { llm?: LlmPort; log?: Logger },
): Promise<ReportAttention[]> {
  const cands = collectAttentionCandidates(report);
  if (!cands.length) return [];
  if (!opts.llm) return [];

  const { system, prompt } = buildAttentionPrompt(cands);
  try {
    const raw = await opts.llm.complete({
      system,
      prompt,
      expectJson: true,
      temperature: 0.2,
      maxTokens: 900,
      stage: "attention",
    });
    const items = parseAttention(raw, cands);
    opts.log?.info(
      "attention",
      `管理关注：候选 ${cands.length} 条 → 采用 ${items.length} 条（LLM 提炼 + 确定性校验；不做复述）`,
    );
    return items;
  } catch (e) {
    opts.log?.warn(
      "attention",
      `管理关注生成失败，本期不展示该模块（不影响发布）：${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }
}
