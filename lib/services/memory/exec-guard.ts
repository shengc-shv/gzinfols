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
import {
  HERO_MIN_DIMENSIONS,
  auditHeroDimensions,
  auditHeroGrounding,
  deriveHeroLine,
} from "../enrich/executive-summary";
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
 * 构建定调**防编造**的比对素材面（2026-10-04 sc T4）。
 *
 * 为什么素材面要用「**两天 exec 池**」而不是仅必读/商机：
 * 综述式定调会引用**被必读/商机筛掉**的当日信息（如数字人民币当天上过版面但未进必读）。
 * 10-04 实测三种素材面的差异：
 *  - 仅必读/商机 `title+topic` → 合规综述**可**通过，但编造检测偏弱；
 *  - 必读/商机 `+why/impact` → 🔴 **编造检测完全失效**（越界数归零，因 LLM 写的 why 就在讲那些内容）；
 *  - **两天 exec 池全量** → 合规综述与编造用例 4/4 判对 ✅（采用）。
 *
 * 拼 `title + summary` 是为了给主体锚更多命中面（`eventFingerprint` 是子串匹配）。
 * ⚠️ 池为空时返回空数组 → `auditHeroGrounding` 会**放行**（宁可保留，不误杀真实内容）。
 */
function buildDailyGroundingTexts(next: ExecutiveSummary, pool: readonly GuardPoolItem[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (t?: string) => {
    const v = (t ?? "").trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  for (const it of next.must_read ?? []) push(`${it.title ?? ""} ${it.why ?? ""}`);
  for (const it of next.insights ?? []) push(`${it.topic ?? ""} ${it.impact ?? ""}`);
  for (const p of pool) push(`${p.title ?? ""} ${p.summary ?? ""}`);
  return out;
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
    // 🔴 商机与必读**互斥**（2026-10-04 sc「R4 以 2 为主」= 代码层，授权实施）
    //
    // sc 口径：「商机原则上不应与今日必读重复 —— 行领导在阅读今日必读时也会产生相应想法，
    // 重复出现等于白占一个位」。
    //
    // 为什么必须代码层：此前**只有 `risk` 有互斥约束**（prompt §3「不能同一条事件又当
    // must_read 又当 risk」），`insights` **完全没有** —— 属约束缺口，不是模型失误。
    // 实测 10-04：商机 6 条里 **3 条与必读重复**（贷款明白纸同条 / 基金业绩腰斩同源 /
    // IPO 受理降温同源）＝ 50%，纯靠 prompt 叮嘱挡不住。
    //
    // 判据只有两条：**同 URL** + **标题逐字相同**（2026-10-04 sc 选 A）。
    //
    // ⛔ 曾试过再加一层 `sameEvent`（事件指纹共享 ≥2 锚点），**已移除** ——
    // 实测 10-04 它对真实场景**零收益**却带风险：
    //  ① 抓不到：当天 3 条真重复的 `sameEvent` 全部为 false。商机 `topic` 是 LLM 改写后的
    //     短语，锚点被改写稀释 ——「贷款明白纸」两条锚点都是 `[]`；「沪深9月IPO零受理」vs
    //     「IPO受理降温」只共享 1 个锚（阈值 2）。`titleSimilarity` 同样不可靠
    //     （同源三条 Dice 实测 1.00 / 0.17 / 0.14）。
    //  ② 误并风险：`sameEvent` 走 `eventFingerprint`（**地域锚照算**），于是
    //     「泛化主体词 + 地域」就能凑满 2 锚点 —— 实测「市政项目获批」与「普惠金融改革试点」
    //     被判同一事件（同「按揭」大杂烩的病根）。
    // 改用「同 URL + 逐字相同标题」后：覆盖当天 3/3、零误伤。代价是「不同 URL 的同一事件」
    // 会漏判 —— 但那类条目改写后锚点本就变了，本就判不出。
    const mrUrls = new Set((next.must_read ?? []).map((m) => m.url ?? "").filter(Boolean));
    const mrTitles = new Set((next.must_read ?? []).map((m) => (m.title ?? "").trim()).filter(Boolean));
    const allInsights = exec.insights ?? [];
    const cands: Array<{ it: ExecInsight; cand: MemoryCandidate }> = allInsights
      .filter((it) => {
        const u = it.sources?.[0]?.url ?? "";
        if (u && mrUrls.has(u)) return false;
        return !mrTitles.has((it.topic ?? "").trim());
      })
      .map((it) => ({
        it,
        cand: {
          title: it.topic,
          text: `${it.impact ?? ""} ${it.action ?? ""}`.trim(),
          ...(it.sources?.[0]?.url ? { url: it.sources[0].url } : {}),
        },
      }));
    if (cands.length < allInsights.length) {
      log.push(
        `🧠 商机互斥：剔除与必读重复的 ${allInsights.length - cands.length} 条（同 URL / 同事件）` +
          `（sc 口径：行领导读完必读已产生想法，重复占位无意义）`,
      );
    }

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
  // ⚠️ 必须放在**最后**（必读/商机定稿之后）：校验依据必须是**实际会呈现的内容**。
  //
  // 口径演进：
  //  · 10-03 sc「定调是必读/商机的提纲」→ **维度可回溯**校验（`auditHeroDimensions`）；
  //  · 10-04 sc「定调是**综合提炼**，不需要一一匹配信息源」→ 改为**防编造**校验
  //    （`auditHeroGrounding`）：定调里的业务主体锚必须都能在**当天全量信息源**里找到。
  //
  // 为什么必须改（10-04 实测）：可回溯会**误剔合理的跨条目综述** ——
  // 「合规成本上行 / 涉外窗口打开 / 存量压力集中在基金客户体验」被剔掉 2/3 个维度
  // （它们是对多条信息的提炼，不是任一条的复述）。而 10-04 实测的线上定调只有 1 个方面，
  // 与该守卫削维度直接相关。
  //
  // 为什么不走事件判重：提纲与必读/商机共享主题是**设计使然**，但旧行为把它当事件候选走
  // `findMatchingEvent` —— 10-03 实证被匹配到「按揭」事件（定调含「房贷」「贴息」两个锚 →
  // sim 0.5，而该事件已播 9 次）→ 判 `cooldown` 拦下 → 兜底重写。
  //
  // ⚠️ 定调**不写入事件记忆**：写进去会变成一个「事件」并被后续必读/商机匹配到（两者本就共享
  //    主题）→ 反过来把正常必读判成重复。定调的跨天一致性由必读/商机的判重间接保证。
  if (next.hero_line && next.hero_line.trim()) {
    // 防编造素材面 = **当天全量信息源**（必读/商机 + 板块在版面内的全部条目）。
    // 🔴 必须是「全量」而非仅必读/商机：综述式定调会引用**被必读/商机筛掉**的当日信息
    //    （如数字人民币当天上过版面但未进必读）。实测若改用「必读+商机的 why/impact」，
    //    编造检测会**完全失效**（越界数归零）—— LLM 写的 why 本身就在讲那些内容。
    const dailyTexts = buildDailyGroundingTexts(next, pool);
    const grounding = auditHeroGrounding(next.hero_line, dailyTexts);
    // 可回溯**降级为诊断信息**（仍算，供日志观察「综述式定调有几个维度能在下方找到对应」）
    const trace = auditHeroDimensions(next.hero_line, next.must_read, next.insights);
    if (!grounding.grounded) {
      // 🔴 防编造不过：定调里有当天素材中不存在的业务主体锚 → **改由必读/商机重归纳**。
      // 归纳不出则**保留原定调**（红线：宁可重复，也不留空、更不发布编造内容）。
      const derived = deriveHeroLine(next);
      if (derived) {
        next.hero_line = derived;
        next.spoken_hero = undefined;
        heroRewriteNeeded = true;
        log.push(
          `🧠 定调：出现当天素材中不存在的主体锚 ${JSON.stringify(grounding.escapedAnchors)}` +
            `（比对 ${grounding.sourceCount} 条当日信息）→ 改由必读+商机归纳：${derived}`,
        );
      } else {
        log.push(
          `🧠 定调：出现越界主体锚 ${JSON.stringify(grounding.escapedAnchors)}、` +
            `且必读/商机为空 → 保留原定调（宁重复，不发布编造）`,
        );
      }
    } else if (trace.dims.length >= HERO_MIN_DIMENSIONS) {
      // 🔴 下限守卫必须用**实际维度数**（`dims.length`），不能用「可在下方回溯的维度数」
      // （`kept.length`）—— 后者是 10-03「维度可回溯」口径的遗留，与 T4 冲突：
      // 10-04 实测合规综述「合规成本上行 / 涉外窗口打开 / 存量压力集中在基金客户体验」
      // 三个维度**都**不回溯到任一条必读/商机（它们是跨条目提炼，正是 T4 要放行的形态），
      // 若拿 kept=0 去比下限 → **误判为「维度不足」**，白白触发二次 LLM 重写。
      log.push(
        `🧠 定调：防编造通过（无越界主体锚，比对 ${grounding.sourceCount} 条当日信息）｜` +
          `${trace.dims.length} 个维度中 ${trace.kept.length} 个可在下方回溯（综述式属正常）→ 保留原定调`,
      );
    } else {
      // 防编造通过，但**维度数低于下限**（2026-10-04 实测：LLM 只给 1 个方面）。
      //
      // 🔴 **只标记、不用规则替换**（2026-10-04 sc 纠正）：
      //    `deriveHeroLine` 取的是 `must_read.title` / `insights.topic` **原文**，
      //    用它补足的结果 = **把下面的必读标题抄一遍**（实测输出「今天主要看五个方面：9月银行业罚没2.07亿、
      //    贷款明白纸全面铺开、…」—— 与「今日必读」列表逐字相同）。
      //    这**恰好违反 §0 自己的禁令**：「不做事件摘要、不得换个说法复述某一条必读 —— 定调是纲、必读是目」。
      //    sc 的判断：**「如果是重复下面的内容，还不如原来的那一条总结」** ——
      //    1 条精炼的纲 > 5 条复读的目。
      //
      //    ∴ 这里只置 `heroRewriteNeeded`，让**二次 LLM 定调**去补（它有能力把维度概括成
      //    「领域词组 + 看点」）；LLM 不可用时**保留原定调**（宁可少，不要复读）。
      heroRewriteNeeded = true;
      log.push(
        `🧠 定调：防编造通过、但仅 ${trace.dims.length} 个维度（下限 ${HERO_MIN_DIMENSIONS}）→ 标记二次 LLM 重写` +
          `（不采用规则补足：那只是把必读标题抄一遍，反而不如这条精炼的总结）`,
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
