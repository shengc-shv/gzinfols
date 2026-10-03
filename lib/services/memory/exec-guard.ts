/**
 * 内容记忆守卫：把「事件记忆」落到四大板块的产出上。
 *
 * 定位：LLM 之后、写盘之前的**确定性闸门**。
 *  - LLM 生成前：由 buildMemoryBrief + formatMemoryBrief 注入提示（避开重复、给出建议角度）；
 *  - LLM 生成后：本模块逐条判定，过滤/降级重播项，板块不足时兜底补齐。
 *
 * 关键设计：
 *  1. 判定顺序 = hero → must_read → insights → risk（板块优先级）。
 *     边判边写记忆（rememberBroadcast），因此**同一板块内同事件只留第一条**
 *     ——LLM 常把同一事件拆成两条必读，靠这个天然收敛。
 *  2. 同日跨板块不互斥：定调一句话 + 必读展开是合理呈现，只要求基本增量。
 *  3. 兜底（永不产出空板块，守住「定调/必读永不空」红线）：
 *     ① 必读 / 商机：上游多给候选（`*_CANDIDATE_POOL`），顺序判重 + 顺延补足；
 *     ② 定调被去重：由**本次报告自身**的必读 + 商机归纳一段「关注导语」
 *        （`deriveHeroLine`，2026-09-27 sc 口径）——**不再从两天池另挑一条事件**；
 *     ③ 仍无（必读/商机均为空）→ 保留 LLM 原产出（宁可重复，不留空）
 *
 * 演进记录（不要再走回头路）：
 *  - 2026-09-24：曾加「定调补位须避开当天其他板块已用事件」（`collectUsedEvents`）——
 *    那是为「池内另挑一条事件」打的补丁；2026-09-27 改为归纳式兜底后**整条机制失去意义**
 *    （归纳素材本就来自当日板块，不存在「与别处撞车」问题），已连同 `pickFreshFromPool` 一并删除。
 *  - 2026-09-27：曾加「补位候选地域/层级门槛」（`isHeroFallbackEligible` / `NATIONAL_POLICY_ACTORS`）
 *    拦外省琐闻 —— 同样随池补位的取消而删除（不挑事件，自然不需要挑地域）。
 */

import type { ExecutiveSummary, ExecInsight, ExecRisk } from "../enrich/executive-summary";
import { auditHeroDimensions, deriveHeroLine, rebuildHeroLine } from "../enrich/executive-summary";
import { scoreBranchRelevance } from "../select/filters/relevance-score";
import { formatBroadcastAt } from "./broadcast-time";
import {
  beginDay,
  deliverySettlementGate,
  evaluateCandidate,
  rememberBroadcast,
  nextAngle,
  MUST_READ_PLAY_TARGET,
  INSIGHT_PLAY_TARGET,
  type EventMemoryStore,
  type EventRecord,
  type MemoryCandidate,
  type MemoryDecision,
  type MemorySection,
} from "./event-memory";

/**
 * 两天可评分池条目（`enrich/exec-pool.ts#collectTwoDayArticles` 产出）。
 *
 * 用途：必读段按 url 回查条目，**用池内的完整 summary 重算分行关联度**
 * （比「标题 + why」更准，且影响「重大事件打破冷却」的 peakScore）——
 * 拿不到就退回标题+why 兜底（口径统一）。
 *
 * ⚠️ 2026-09-27：定调兜底改为「由必读+商机归纳」后，本池**不再**参与定调补位
 *    （旧用法 `pickFreshFromPool` 已删），只剩必读打分这一处用途。
 */
export interface GuardPoolItem {
  title: string;
  summary?: string;
  subcategory?: string;
  source?: string;
  sourceId?: string;
  url?: string;
  locale?: string;
  category?: string;
}

export interface GuardInput {
  exec: ExecutiveSummary;
  store: EventMemoryStore;
  /** 今天 YYYY-MM-DD。 */
  today: string;
  /** 两天可评分池（必读段按 url 回查完整 summary 重算关联度；不再用于定调补位）。 */
  pool?: GuardPoolItem[];
  /**
   * 参照时刻（**必填**，2026-09-14 C-3）。由编排层注入 `ctx.startTime`：
   * 用于计算记忆库的播报时刻 `broadcastAt`（服务层不隐式读系统时钟）。
   */
  now: Date;
}

export interface GuardOutput {
  exec: ExecutiveSummary;
  /** 已记录本次播报的记忆库（供调用方落盘）。 */
  store: EventMemoryStore;
  /** 逐条判定明细（日志/测试用）。 */
  decisions: MemoryDecision[];
  /** 人类可读日志行。 */
  log: string[];
  /**
   * 定调被**规则**改写过（悬空维度剔除 / 全悬空重归纳）—— 供上层决定是否再请 LLM 重写一次。
   *
   * 为什么需要：规则路径只能拿必读/商机的**标题原文**拼提纲（无看点、偏事件化），
   * 而 LLM 能写成「维度，看点」。标出这个状态，上层（`side-exec-summary`）在有 LLM 时
   * 可以用**定稿后的**内容再问一次（2026-10-03 sc 同意的「方案 A：二次 LLM 定调」）；
   * LLM 不可用时保持规则产出，不阻断发布。
   */
  heroRewriteNeeded?: boolean;
}

/**
 * 顺序判重选单（2026-09-18 新口径）：按候选顺序（调用方保证已按「分行关联度」降序）
 * 依次判重 —— 未命中重复 → 选入并写记忆；命中重复 → 跳过、顺延到下一条候补，
 * 直到选满 `target` 即停（其后候选留作备用）。
 *
 * ⚠️ 判重依据**完全复用** `evaluateCandidate`（事件指纹匹配：锚点 Jaccard / 标题 Dice /
 * 主题标签辅助 + 冷却期）。本函数**不改动任何判定规则**，只负责「选谁 / 跳过谁 /
 * 何时停」—— 判重口径与历史保持一致，且与板块策略解耦、可单独测试。
 *
 * 边界（规则 4）：候补用尽仍不足 `target` → 按实际剩余返回，**不强行补位**（宁缺勿滥）。
 */
export function pickUntilTarget<T>(opts: {
  items: T[];
  toCandidate: (item: T) => MemoryCandidate;
  section: MemorySection;
  today: string;
  broadcastAt: string;
  target: number;
  store: EventMemoryStore;
}): {
  chosen: Array<{ item: T; decision: MemoryDecision }>;
  skipped: MemoryDecision[];
  store: EventMemoryStore;
} {
  let store = opts.store;
  const chosen: Array<{ item: T; decision: MemoryDecision }> = [];
  const skipped: MemoryDecision[] = [];
  for (const item of opts.items) {
    const cand = opts.toCandidate(item);
    const d = evaluateCandidate({ cand, section: opts.section, today: opts.today, store });
    if (d.allow) {
      chosen.push({ item, decision: d });
      store = rememberBroadcast(store, {
        cand,
        section: opts.section,
        date: opts.today,
        novelty: d.novelty,
        broadcastAt: opts.broadcastAt,
        ...(d.requiredAngle ? { angle: d.requiredAngle } : {}),
      });
      if (chosen.length >= opts.target) break; // 选满即停，其后候选留作备用候补
    } else {
      skipped.push(d); // 命中重复 → 跳过，继续顺延下一条候补
    }
  }
  return { chosen, skipped, store };
}

/**
 * 主入口：对四大板块执行记忆去重 + 兜底补齐。
 * 纯函数（不改入参），返回新 exec 与更新后的记忆库。
 */
export function applyMemoryGuard(input: GuardInput): GuardOutput {
  const { exec, today, pool = [] } = input;
  // 播报时刻：由注入的 now 显式换算（不再回落 new Date()）
  const broadcastAt = formatBroadcastAt(input.now);
  const log: string[] = [];
  // 结算指纹预检（2026-09-03）：昨天有暂存播报但「人工推送的版本 ≠ 落盘版本」
  // （deliveries.reportRunId ≠ today.runId）时，beginDay 将按 deliverySettlementGate
  // 不结算（宁漏勿误）——此处把拦截原因留痕进日志，供人工核查。
  {
    const p = input.store.today;
    if (p && p.date !== today && p.entries.length > 0) {
      const g = deliverySettlementGate(input.store, p.date);
      if (g.reason === "fingerprint-mismatch") {
        const rec = (input.store.deliveries ?? []).find((d) => d && d.date === p.date);
        log.push(
          `🧠 结算拦截：昨日交付版本（gh-pages run ${rec?.reportRunId ?? "?"}）≠ 昨日落盘版本（run ${p.runId ?? "?"}）→ 昨天播报不结算（推送内容与 gh-pages 落盘内容不一致，请人工核查后重推或清理 deliveries）`,
        );
      }
    }
  }
  // 开启新的一天：结算昨天的播报进长期记忆 + 清空当天暂存区（保证同日重跑幂等）
  let store: EventMemoryStore = beginDay(input.store, today);
  const decisions: MemoryDecision[] = [];
  const next: ExecutiveSummary = { ...exec };
  /** 定调是否被**规则**改写（详见 `GuardOutput.heroRewriteNeeded`）。 */
  let heroRewriteNeeded = false;

  // ---- 2) must_read（今日必读）----
  {
    // ① 构造候选：补「与广州分行的关联度」分。池内有对应条目时取其完整 summary 打分
    //    （更准，且用于「重大事件打破冷却」），池内没有则用标题+why 兜底 —— 口径统一。
    const cands: Array<{
      m: { title: string; why: string; url?: string };
      cand: MemoryCandidate;
    }> = (exec.must_read ?? []).map((m) => {
      const cand: MemoryCandidate = {
        title: m.title,
        text: m.why,
        ...(m.url ? { url: m.url } : {}),
      };
      const meta = m.url ? pool.find((p) => p.url === m.url) : undefined;
      const rel = meta
        ? scoreBranchRelevance({
            title: meta.title,
            ...(meta.summary ? { summary: meta.summary } : {}),
          })
        : scoreBranchRelevance({ title: m.title, summary: m.why });
      cand.score = rel.score;
      cand.tier = rel.tier;
      if (rel.override) cand.override = true;
      return { m, cand };
    });

    // ② 按「与广州分行的关联度」从高到低排序（规则 2）
    cands.sort((a, b) => (b.cand.score ?? 0) - (a.cand.score ?? 0));

    // ③ 顺序判重：依次取，未命中重复 → 选入并写记忆；命中重复 → 跳过、顺延下一条候补，
    //    直到选满 MUST_READ_PLAY_TARGET（规则 3）。候补用尽仍不足 → 按实际剩余（规则 4），
    //    不强拉池内条目凑数 —— 宁缺勿滥。
    const r = pickUntilTarget({
      items: cands,
      toCandidate: (c) => c.cand,
      section: "must_read",
      today,
      broadcastAt,
      target: MUST_READ_PLAY_TARGET,
      store,
    });
    store = r.store;
    decisions.push(...r.chosen.map((c) => c.decision), ...r.skipped);
    if (r.chosen.length > 0) next.must_read = r.chosen.map((c) => c.item.m);

    if (r.skipped.length > 0 || r.chosen.length < MUST_READ_PLAY_TARGET) {
      log.push(
        `🧠 必读：候选 ${cands.length} 条（按关联度降序）→ 播出 ${r.chosen.length}/${MUST_READ_PLAY_TARGET} 条` +
          `（命中重复跳过 ${r.skipped.length} 条：${r.skipped.map((d) => d.verdict).join(",") || "无"}）`,
      );
    }
  }

  // ---- 3) insights（商机洞察）----
  // 2026-09-21：与「必读」同构 —— 候选池 + 顺序判重 + 顺延补足（用户拍板：候选 12 条 → 补足 5~6 条）。
  // 背景：此前是「生成 → 判重 → 剩多少算多少」，没有候补顺延。周末连跑两天后，周一候选与已播商机
  //   大面积撞冷却 → 实证 09-21：8 → 3 条（去重 5 条：exhausted,refresh,refresh,cooldown,cooldown），
  //   洞察板块内容腰斩、口播时长掉到 128s。与 09-17「3 件事只剩 2 件」是同一个病。
  // 顺序：保持 LLM 给出的优先级顺序（不额外打分排序，避免改动相关性口径）；判重复用 evaluateCandidate。
  {
    const cands: Array<{ it: ExecInsight; cand: MemoryCandidate }> = (exec.insights ?? []).map((it) => ({
      it,
      cand: {
        title: it.topic,
        text: `${it.impact ?? ""} ${it.action ?? ""}`.trim(),
        ...(it.sources?.[0]?.url ? { url: it.sources[0].url } : {}),
      },
    }));

    // 依次取：未命中重复 → 选入并写记忆；命中重复 → 跳过、顺延下一条候补，直到选满
    // INSIGHT_PLAY_TARGET。候补用尽仍不足 → 按实际剩余，不强拉池内条目凑数（宁缺勿滥）。
    const r = pickUntilTarget({
      items: cands,
      toCandidate: (c) => c.cand,
      section: "insights",
      today,
      broadcastAt,
      target: INSIGHT_PLAY_TARGET,
      store,
    });
    store = r.store;
    decisions.push(...r.chosen.map((c) => c.decision), ...r.skipped);
    next.insights = r.chosen.map((c) => c.item.it);

    if (r.skipped.length > 0 || r.chosen.length < INSIGHT_PLAY_TARGET) {
      log.push(
        `🧠 商机：候选 ${cands.length} 条 → 播出 ${r.chosen.length}/${INSIGHT_PLAY_TARGET} 条` +
          `（命中重复跳过 ${r.skipped.length} 条：${r.skipped.map((d) => d.verdict).join(",") || "无"}）`,
      );
    }
  }

  // ---- 4) risk（风险提示）----
  // 风险可以为 null：去重命中即不预警（当日没有新风险是正常状态），
  // 不做 L2 补位——编造风险比没有风险更糟。
  if (exec.risk) {
    const r: ExecRisk = exec.risk;
    // 透传分行相关性分，使 risk 板块事件跨天结算时也能拿到真实 peakScore。
    const riskSummary = `${r.evidence ?? ""} ${r.impact ?? ""}`.trim();
    const riskRel = scoreBranchRelevance({
      title: r.topic,
      ...(riskSummary ? { summary: riskSummary } : {}),
    });
    const cand: MemoryCandidate = {
      title: r.topic,
      text: `${riskSummary} ${r.action ?? ""}`.trim(),
      ...(r.url ? { url: r.url } : {}),
      score: riskRel.score,
      ...(riskRel.override ? { override: true } : {}),
    };
    const d = evaluateCandidate({ cand, section: "risk", today, store });
    decisions.push(d);
    if (d.allow) {
      store = rememberBroadcast(store, {
        cand,
        section: "risk",
        date: today,
        novelty: d.novelty,
        broadcastAt,
        ...(d.requiredAngle ? { angle: d.requiredAngle } : {}),
      });
      log.push(`🧠 风险：${d.verdict}（增量 ${d.novelty.toFixed(2)}）— ${d.reason}`);
    } else {
      next.risk = undefined;
      next.spoken_risk = undefined;
      log.push(`🧠 风险命中去重（${d.verdict}，增量 ${d.novelty.toFixed(2)}）→ 今日不重复预警`);
    }
  }

  // ---- 5) hero（今日定调）----
  // ⚠️ 必须放在**最后**（必读/商机定稿之后）：定调是它们的「提纲」，校验依据必须是
  //    **实际会呈现的**必读/商机 —— 被判重拦掉的内容，其对应维度就是悬空的。
  //
  // 口径（2026-10-03 sc）：「定调是基于今日必读和商机的**提纲** —— 下面有出现，提纲就可以出现」。
  //
  // 为什么不再走事件判重：提纲与必读/商机共享主题是**设计使然**，但旧行为把它当事件候选走
  // `findMatchingEvent` —— 10-03 实证被匹配到「按揭」事件（定调含「房贷」「贴息」两个锚 →
  // sim 0.5，而该事件已播 9 次）→ 判 `cooldown` 拦下 → 兜底重写。
  // 改为**维度可回溯**校验（`auditHeroDimensions`）：悬空维度剔除；全悬空则改由必读/商机
  // 重归纳；归纳不出才保留原定调（红线：宁可重复，不留空）。
  //
  // ⚠️ 定调**不写入事件记忆**：写进去会变成一个「事件」并被后续必读/商机匹配到（两者本就共享
  //    主题）→ 反过来把正常必读判成重复。定调的跨天一致性由必读/商机的判重间接保证。
  if (next.hero_line && next.hero_line.trim()) {
    const audit = auditHeroDimensions(next.hero_line, next.must_read, next.insights);
    if (audit.kept.length === 0) {
      // 一个维度都回溯不到：提纲与下方内容完全脱节 → 用必读/商机重归纳；
      // 归纳不出（素材为空）则保留原定调（红线：宁可重复，不留空）。
      const derived = deriveHeroLine(next);
      if (derived) {
        next.hero_line = derived;
        next.spoken_hero = undefined;
        heroRewriteNeeded = true;
        log.push(
          `🧠 定调：全部 ${audit.dims.length} 个维度都无法在必读/商机中回溯 → 改由必读+商机归纳：${derived}`,
        );
      } else {
        log.push(`🧠 定调：全部 ${audit.dims.length} 个维度均无法回溯、且必读/商机为空 → 保留原定调`);
      }
    } else if (audit.dangling.length === 0) {
      log.push(`🧠 定调：${audit.kept.length} 个维度均可在必读/商机中回溯 → 保留原定调`);
    } else {
      // 剔除悬空维度后重建。卡面只放正文（**不带任何标签前缀**）：页面「今日定调：」/
      // 企微「【今日定调】」/口播「先看今天的整体定调。」各端自加，生产者再加会渲染成双标签。
      const rebuilt = rebuildHeroLine(audit.kept);
      next.hero_line = rebuilt;
      heroRewriteNeeded = true;
      // 口播是围绕**原定调**写的，定调改了就必须清空 → 由 syncNarration 用新 hero_line 兜底派生
      // （`voice/index.ts` 只读 `spoken_hero`；不清空会让口播与卡面不同源）。
      next.spoken_hero = undefined;
      log.push(
        `🧠 定调：剔除 ${audit.dangling.length} 个悬空维度（${audit.dangling.map((d) => d.key).join("、")}）→ ${rebuilt}`,
      );
    }
  }

  return { exec: next, store, decisions, log, heroRewriteNeeded };
}

/**
 * 生成前调用：给出「本次应避开 / 应换角度」的事件清单，
 * 供调用方注入 LLM 提示词（见 formatMemoryBrief）。
 */
export function suggestAngles(
  store: EventMemoryStore,
  today: string,
): Array<{ id: string; title: string; angle: string; guide: string }> {
  const out: Array<{ id: string; title: string; angle: string; guide: string }> = [];
  for (const rec of Object.values(store.events ?? {})) {
    if (rec.lastBroadcastAt !== today) continue;
    const last = (rec.samples ?? []).filter((s) => s.date === today).slice(-1)[0];
    if (!last) continue;
    const a = nextAngle(rec as EventRecord);
    out.push({ id: rec.id, title: last.title, angle: a, guide: ANGLE_GUIDE_TEXT[a] });
  }
  return out;
}

const ANGLE_GUIDE_TEXT: Record<string, string> = {
  政策变化: "只讲政策/规则本身变了什么、何时生效、适用范围",
  市场反应: "讲市场与机构的第一反应，少复述政策条文",
  受影响人群: "讲哪一类客户被直接影响，需求发生了什么变化",
  数据验证: "用最新数据验证进展（规模/增速/占比），用数字说话",
  同业动作: "讲同业已经怎么做了（产品/定价/流程），突出竞争位次",
  客户行动: "讲分行与该客群当下可执行的动作",
};
