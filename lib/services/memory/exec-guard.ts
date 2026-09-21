/**
 * 内容记忆守卫：把「事件记忆」落到四大板块的产出上。
 *
 * 定位：LLM 之后、写盘之前的**确定性闸门**。
 *  - LLM 生成前：由 buildMemoryBrief + formatMemoryBrief 注入提示（避开重复、给出建议角度）；
 *  - LLM 生成后：本模块逐条判定，过滤/降级重播项，板块不足时分三级兜底补齐。
 *
 * 关键设计：
 *  1. 判定顺序 = hero → must_read → insights → risk（板块优先级）。
 *     边判边写记忆（rememberBroadcast），因此**同一板块内同事件只留第一条**
 *     ——LLM 常把同一事件拆成两条必读，靠这个天然收敛。
 *  2. 同日跨板块不互斥：定调一句话 + 必读展开是合理呈现，只要求基本增量。
 *  3. 兜底三级（永不产出空板块，守住「定调/必读永不空」红线）：
 *     L1 释放被过滤项（progress > refresh > cooldown > duplicate，同级按增量降序）
 *     L2 从两天池补位「记忆库中不存在」的高分条目
 *     L3 仍不足 → 保留 LLM 原产出（宁可重复，不留空）
 */

import type { ExecutiveSummary, ExecInsight, ExecRisk } from "../enrich/executive-summary";
import { synthMustReadWhy } from "../enrich/executive-summary";
import { scoreBranchRelevance, type BranchRelevance } from "../select/filters/relevance-score";
import { formatBroadcastAt } from "./broadcast-time";
import {
  beginDay,
  deliverySettlementGate,
  evaluateCandidate,
  rememberBroadcast,
  nextAngle,
  SECTION_POLICY,
  MUST_READ_PLAY_TARGET,
  INSIGHT_PLAY_TARGET,
  type EventMemoryStore,
  type EventRecord,
  type MemoryCandidate,
  type MemoryDecision,
  type MemorySection,
} from "./event-memory";

/** 补位池条目（= 两天可评分池 ScorablePoolEntry 的超集）。 */
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
  /** 兜底补位池（两天可评分池）。为空则跳过 L2 补位。 */
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
}

/** 从补位池里挑出「记忆库中不存在」的条目（L2）。 */
function pickFreshFromPool(
  pool: GuardPoolItem[],
  store: EventMemoryStore,
  section: MemorySection,
  today: string,
  excludeUrls: Set<string>,
  limit: number,
  out: { picked: MemoryCandidate[]; store: EventMemoryStore; broadcastAt: string },
): number {
  if (limit <= 0) return 0;
  const scored = pool
    .filter((p) => p.title && (!p.url || !excludeUrls.has(p.url)))
    .map((p) => {
      const rel = scoreBranchRelevance({
        title: p.title,
        ...(p.summary ? { summary: p.summary } : {}),
        ...(p.category ? { category: p.category } : {}),
        ...(p.subcategory ? { subcategory: p.subcategory } : {}),
      });
      return { p, rel };
    })
    .filter((x) => x.rel.tier !== "drop")
    .sort((a, b) => b.rel.score - a.rel.score);

  let n = 0;
  for (const { p, rel } of scored) {
    if (n >= limit) break;
    const cand: MemoryCandidate = {
      title: p.title,
      text: p.summary ?? "",
      ...(p.url ? { url: p.url } : {}),
      score: rel.score,
      tier: rel.tier,
      ...(rel.override ? { override: true } : {}),
    };
    const d = evaluateCandidate({ cand, section, today, store: out.store });
    if (d.verdict !== "new" && d.verdict !== "progress") continue;
    out.picked.push(cand);
    out.store = rememberBroadcast(out.store, {
      cand,
      section,
      date: today,
      novelty: d.novelty,
      broadcastAt: out.broadcastAt,
    });
    if (p.url) excludeUrls.add(p.url);
    n++;
  }
  return n;
}

/** 用补位条目拼一条 must_read（文案口径与评分兜底一致）。 */
function toMustRead(cand: MemoryCandidate): { title: string; why: string; url?: string } {
  const rel: BranchRelevance = scoreBranchRelevance({
    title: cand.title,
    ...(cand.text ? { summary: cand.text } : {}),
  });
  return {
    title: cand.title.slice(0, 15),
    why: synthMustReadWhy(rel),
    ...(cand.url ? { url: cand.url } : {}),
  };
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

  // ---- 1) hero（今日定调）----
  if (exec.hero_line && exec.hero_line.trim()) {
    // 透传分行相关性分，使「定调」这类重大事件能在跨天结算时拿到真实 peakScore
    // （否则 peakScore 恒为 0，无法享受「重大事件 ≥60 双倍保留」）。
    const heroRel = scoreBranchRelevance({ title: exec.hero_line });
    const cand: MemoryCandidate = {
      title: exec.hero_line,
      score: heroRel.score,
      ...(heroRel.override ? { override: true } : {}),
    };
    const d = evaluateCandidate({ cand, section: "hero", today, store });
    decisions.push(d);
    if (d.allow) {
      store = rememberBroadcast(store, {
        cand,
        section: "hero",
        date: today,
        novelty: d.novelty,
        broadcastAt,
        ...(d.requiredAngle ? { angle: d.requiredAngle } : {}),
      });
      log.push(`🧠 定调：${d.verdict}（增量 ${d.novelty.toFixed(2)}）— ${d.reason}`);
    } else {
      // 定调被去重 → 必须补一条新的（红线：定调永不空）
      const box = { picked: [] as MemoryCandidate[], store, broadcastAt };
      const n = pickFreshFromPool(pool, store, "hero", today, new Set(), 1, box);
      store = box.store;
      if (n > 0) {
        next.hero_line = `今日分行焦点：${box.picked[0].title.slice(0, 26)}`;
        // 口播稿沿用会与旧稿雷同 → 清空，由 audio.ts 按 hero_line 重新确定性生成
        next.spoken_hero = undefined;
        log.push(`🧠 定调命中去重（${d.verdict}），改用池内新事件补位：${next.hero_line}`);
      } else {
        log.push(
          `🧠 定调命中去重（${d.verdict}），但池内无新事件可补 → 保留原定调（宁可重复，不留空）`,
        );
      }
    }
  }

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

  return { exec: next, store, decisions, log };
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
