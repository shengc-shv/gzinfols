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
import { normText, titleSim } from "../memory/event-text";
import { extractJson } from "../enrich/json-util";

/** 最多展示条数（任务书 3.6）。 */
export const MAX_ATTENTION = 3;
/** 候选上限（必读 5 + 商机 6 + 风险 1，留点余量）。 */
const MAX_CANDIDATES = 14;
/** 候选事实截断（只给 LLM 一句，避免把整份报告塞进 prompt）。 */
const FACT_CLIP = 90;
/**
 * 候选标题截断（2026-11-28 sc）：个别源的 `title` 实为整篇正文（实测证监会稿 238 字），
 * 原样塞进 prompt 会挤掉其他候选、并诱发 LLM 整段复述。
 * ⛔ 只截 prompt 展示；候选对象仍保留完整 title，`titleSim` 复述校验口径不变。
 */
const TITLE_CLIP = 60;
/** 判为「复述」的标题相似度阈值（与判重链的同一主题阈值同口径，不新造刻度）。 */
const RESTATE_SIM = 0.7;

/** 命令式 / 越界措辞：命中即判该条不合格（任务书 3.5）。 */
const ABSOLUTE_WORDING = [/必须立即/, /要求各部门/, /责成/, /立刻开展/, /马上落实/, /全行上下必须/];

export interface AttentionCandidate {
  /** 稳定编号 c1..cN：LLM 只能引用它，用于把领域/事实归属钉回具体候选。 */
  id: string;
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
  const add = (c: Omit<AttentionCandidate, "id">) => {
    if (out.length < MAX_CANDIDATES) out.push({ id: `c${out.length + 1}`, ...c });
  };
  for (const m of report.must_read ?? []) {
    if (!m.url) continue;
    const urls = [m.url];
    add({ kind: "must_read", title: m.title ?? "", fact: m.why ?? "", urls, domains: domsOf(urls) });
  }
  for (const it of report.insights ?? []) {
    const urls = (it.sources ?? []).map((s) => s?.url).filter((u): u is string => Boolean(u));
    if (!urls.length) continue;
    add({ kind: "insight", title: it.topic ?? "", fact: it.impact ?? "", urls, domains: domsOf(urls) });
  }
  if (report.risk) {
    const urls = [
      ...(report.risk.sources ?? []).map((s) => s?.url),
      report.risk.url,
    ].filter((u): u is string => Boolean(u));
    if (urls.length) {
      add({
        kind: "risk",
        title: report.risk.topic ?? "",
        fact: report.risk.evidence ?? report.risk.impact ?? "",
        urls: [...new Set(urls)],
        domains: domsOf(urls),
      });
    }
  }
  return out;
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
    "6. source_candidate_ids 只能引用上方 [cN] 编号；supporting_facts 必须逐字摘自对应候选的「事实」字段，不得自己总结。",
    "7. domains 给出 ≥2 个领域时，必须写 cross_domain_link：一句话说明这批候选里这些领域实际如何关联；",
    "   没有真实关联就只给 1 个领域。一条候选本身带多个标签，不构成跨条线。",
    "8. 候选标题可能含整段正文，只作定位，不得整段复述；处罚/合规类事件优先按风险提示理解，",
    "   管理关注只写管理层需要了解的问题，不搬运原文。",
    "9. 只输出 JSON 数组，不要任何解释文字。",
  ].join("\n");

  const lines: string[] = [];
  lines.push("【今日候选】");
  cands.forEach((c) => {
    const doms = c.domains.length ? c.domains.join(",") : "无";
    const title = c.title.length > TITLE_CLIP ? `${c.title.slice(0, TITLE_CLIP)}…` : c.title;
    lines.push(
      `[${c.id}] (${KIND_LABEL[c.kind]}) ${title}｜事实：${c.fact.slice(0, FACT_CLIP)}｜领域：${doms}｜来源：${c.urls.join(" ")}`,
    );
  });
  lines.push("");
  lines.push("【输出格式】严格如下 JSON 数组（最多 3 条，可为 []）：");
  lines.push(
    '[{"topic":"管理关注主题（一句话，不超过 40 字）","rationale":"关注依据：引用了哪些候选的哪些关键事实",' +
      '"significance":"管理意义：为什么值得管理层关注（审慎措辞）","domains":["领域id"],' +
      '"source_candidate_ids":["c1"],"source_urls":["来源url"],"supporting_facts":["候选事实原文"],' +
      '"cross_domain_link":"仅在 domains≥2 时填写：这些领域在本批候选中的实际关联"}]',
  );
  lines.push("");
  lines.push(`【领域取值】只能从这里选：${domainMenu()}`);
  lines.push("【来源要求】source_urls / source_candidate_ids 必须原样复制上面候选里的 url 与编号，不得改写、不得自造。");

  return { system, prompt: lines.join("\n") };
}

/** 支撑事实必须能在被引用候选的事实字段里逐字核到（归一后子串，⛔ 不认自己的总结）。 */
function factGrounded(fact: string, cited: readonly AttentionCandidate[]): boolean {
  const needle = normText(fact);
  return needle.length >= 2 && cited.some((c) => normText(c.fact).includes(needle));
}

/** 跨条线说明必须点到至少两个实际领域的中文名/简称。 */
function domainNameSet(domains: readonly string[]): string[] {
  return domains.flatMap((id) => {
    const d = BUSINESS_DOMAINS.find((b) => b.id === id);
    return d ? [d.name, d.short] : [];
  });
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

  const idToCand = new Map(cands.map((c) => [c.id, c]));
  const urlToCand = new Map<string, AttentionCandidate>();
  for (const c of cands) for (const u of c.urls) if (!urlToCand.has(u)) urlToCand.set(u, c);
  const riskCand = cands.find((c) => c.kind === "risk");
  const mustReadCands = cands.filter((c) => c.kind === "must_read");
  const insightCands = cands.filter((c) => c.kind === "insight");

  const out: ReportAttention[] = [];
  for (const x of arr) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const topic = String(o.topic ?? "").trim();
    const rationale = String(o.rationale ?? "").trim();
    const significance = String(o.significance ?? "").trim();
    if (!topic || !rationale || !significance) continue;

    // ① 引用必须落到当日候选：优先 source_candidate_ids，缺失时按 url 反查（兼容旧产物）
    const cited: AttentionCandidate[] = [];
    const seenIds = new Set<string>();
    for (const rawId of Array.isArray(o.source_candidate_ids) ? o.source_candidate_ids : []) {
      const id = String(rawId ?? "").trim();
      const c = idToCand.get(id);
      if (c && !seenIds.has(id)) {
        cited.push(c);
        seenIds.add(id);
      }
    }
    const rawUrls = (Array.isArray(o.source_urls) ? o.source_urls : [])
      .map((u) => String(u ?? "").trim())
      .filter(Boolean);
    if (!cited.length) {
      for (const u of rawUrls) {
        const c = urlToCand.get(u);
        if (c && !seenIds.has(c.id)) {
          cited.push(c);
          seenIds.add(c.id);
        }
      }
    }
    if (!cited.length) continue;
    const allowedUrls = new Set(cited.flatMap((c) => c.urls));
    const uniqUrls = [...new Set(rawUrls.filter((u) => allowedUrls.has(u)))];
    const sourceUrls = uniqUrls.length ? uniqUrls : [...new Set(cited.flatMap((c) => c.urls))];
    if (!sourceUrls.length) continue;

    // ② 命令式 / 越界措辞兜底（prompt 已禁止，这里再判一次）
    const blob = `${topic} ${rationale} ${significance}`;
    if (ABSOLUTE_WORDING.some((re) => re.test(blob))) continue;

    // ③ 支撑事实：必须是候选事实的原文摘录；一条都核不到 → 来源不足以支撑，整条剔除
    const rawFacts = (Array.isArray(o.supporting_facts) ? o.supporting_facts : [])
      .map((f) => String(f ?? "").trim())
      .filter(Boolean);
    const facts = rawFacts.length ? rawFacts : [...new Set(cited.map((c) => c.fact).filter(Boolean))];
    const groundedFacts = facts.filter((f) => factGrounded(f, cited));
    if (!groundedFacts.length) continue;

    // ④ 领域：AI 领域 ∩ 被引用来源支持的领域（⛔ 合法 ID ≠ 有来源依据）
    const sourceDomains = [...new Set(cited.flatMap((c) => c.domains))];
    const aiDomains = (Array.isArray(o.domains) ? o.domains : [])
      .map((d) => String(d ?? "").trim())
      .filter((d) => DOMAIN_IDS.includes(d));
    let domains = [
      ...new Set((aiDomains.length ? aiDomains : sourceDomains).filter((d) => sourceDomains.includes(d))),
    ];
    if (!domains.length) continue; // 来源没有领域信息 → 不得强行补出跨条线

    // ⑤ 跨条线：必须有两个以上不同候选分别支撑，且写得出实际关联；
    //    单条候选自带多个标签不算跨条线（任务书 3.2 C）。
    const supporters = new Map<string, Set<string>>();
    for (const c of cited) {
      for (const d of domains) {
        if (!c.domains.includes(d)) continue;
        const set = supporters.get(d) ?? new Set<string>();
        set.add(c.id);
        supporters.set(d, set);
      }
    }
    const distinctSupporters = new Set([...supporters.values()].flatMap((s) => [...s]));
    const crossLine = domains.length >= 2 && distinctSupporters.size >= 2;
    if (!crossLine && domains.length > 1) domains = domains.slice(0, 1);
    let crossDomainLink: string | undefined;
    if (crossLine) {
      const link = String(o.cross_domain_link ?? "").trim();
      const names = domainNameSet(domains);
      if (link.length < 8 || names.filter((n) => link.includes(n)).length < 2) continue;
      crossDomainLink = link;
    }

    // ⑥ 复述检查：只引用一条必读/商机且标题高度相似 → 是卡片摘要，不是管理议题
    const restating =
      (cited.length === 1 &&
        (mustReadCands.some((m) => m.id === cited[0].id && titleSim(topic, m.title) >= RESTATE_SIM) ||
          insightCands.some((i) => i.id === cited[0].id && titleSim(topic, i.title) >= RESTATE_SIM))) ||
      // 风险同源且没有额外领域 → 风险模块已说过
      (riskCand &&
        cited.length === 1 &&
        cited[0].id === riskCand.id &&
        domains.every((d) => riskCand.domains.includes(d)));
    if (restating) continue;

    // ⑦ 自身重复：主题高度相似只留先出现的
    if (out.some((a) => titleSim(a.topic, topic) >= RESTATE_SIM)) continue;

    out.push({
      id: `att-${out.length + 1}`,
      topic,
      rationale,
      significance,
      domains,
      source_urls: sourceUrls,
      source_candidate_ids: cited.map((c) => c.id),
      supporting_facts: groundedFacts,
      ...(crossDomainLink ? { cross_domain_link: crossDomainLink } : {}),
      // 事实全部核得到才给 high；夹带无法核到的摘录 → medium（内部字段）
      confidence: groundedFacts.length === facts.length ? "high" : "medium",
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
