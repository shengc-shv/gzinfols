/**
 * 口播跨段收敛层（2026-09-25 立项 A+C；**2026-09-28 起只保留 R2**）。
 *
 * ## 病根（2026-09-25 实测）
 * `must_read`（宏观大信号）与 `insights`（落地动作）**按设计允许共用同一篇素材** ——
 * 卡面视角下无妨（读者可跳读），但口播是**线性流**，同一事实被念两遍即重复。
 *
 * ## 本层做什么
 * - **R2 必读↔商机**：商机里与必读同源的条目，口播**只留主题**（去掉 impact 的事实复述）。
 *   理由：事实已由必读给出，商机的独有价值是「这件事指向哪块业务」。
 *   ⚠️ 2026-09-28 起商机口播由 LLM 按客群归并产出、本就不念 impact，故 R2 退为**安全网**
 *   （只在「LLM 照抄了卡面 impact」时动手）。
 *   ⚠️ 2026-10-01 起全篇不再输出 action（sc 口径：只呈现事实与影响、不给操作建议），
 *   R2 的落点由「压成动作」改为「压成主题」—— 剥离的仍是 impact，只是留存的尾巴换了语义。
 *
 * ## ⛔ 已删除：R1「定调↔必读只点题」（2026-09-28，勿加回）
 * R1 的设计前提是「定调已经详述了结论 + 应对建议，故与之同源的必读，其 why 属重复」。
 * 2026-09-28 定调口径改为**维度提纲**（「今天主要看N个方面：X，看点」）后，**该前提消失**：
 * 定调不再叙述任何事件的结论与建议。更关键的是实测撞车 ——
 * 定调放宽到 70 字后，维度里会带上含数字的必读标题（09-28 实证：定调含
 * 「公募基金规模达39.63万亿」维度 → 与必读第 3 条共享硬事实 `#39.63万亿` → R1 命中
 * → **误把该条 why 剥掉**，必读只剩光秃秃的标题）。
 * 必读的 why 是口播里**唯一的「为什么重要」来源**（车里听的行领导就靠它判断值不值得点进去），
 * 任何情况下都不能被剥。故 R1 连同 `echoesHero` / `MUST_READ_ECHO_MODE` 一并删除。
 *
 * ## 边界（不可越）
 * - **不删条**：只压缩单条内部文本，**条数保持 1:1**（否则破坏「几条卡面↔几句口播」的构造保证，
 *   以及 `segments[].refs` 与卡片的对齐）。
 * - **不改卡面、不改 store.json**：调用方在 `assembleBriefingScript` 入口处本地收敛，
 *   落盘仍是完整稿（可回溯、幂等）。
 * - **不碰判重窗/冷却**：那是 2026-09-18 锁定区；本层只做**同期同报内**的跨段互补。
 * - **保守**：判定不成立就原样保留（宁可漏收敛，不可误删解读）。
 *
 * 纯函数、零副作用、零 LLM。
 */
import type { ExecutiveSummary } from "../enrich/executive-summary";
import { canonicalizeUrl } from "../../utils/url";
import { endSentence } from "./speech-lines";

export interface SpeechOverlapStats {
  /** 商机中与必读同源、被压成「只留主题」的条数。 */
  insightEchoes: number;
  /** 收敛掉的总字数（正数）。 */
  savedChars: number;
  /** R2b（2026-10-13）：因「纯复读」被整句删除的商机句数。 */
  prunedSentences?: number;
  /** R2b：仅剥离复读片段、保留新维度的句数。 */
  trimmedSentences?: number;
  /** R2b：判定为复读的片段（日志与测试可核对）。 */
  pruneEchoes?: string[];
}

/** 商机是否与某条必读同源（判定：来源 URL 归一后相等 —— 主力信号，可逐条核对）。 */
export function echoesMustRead(
  insight: { sources?: Array<{ url: string }> },
  mustUrls: Set<string>,
): boolean {
  if (mustUrls.size === 0) return false;
  return (insight.sources ?? []).some((s) => {
    const u = s?.url ? canonicalizeUrl(s.url) : "";
    return Boolean(u) && mustUrls.has(u);
  });
}

/**
 * 从 hay 的 `from` 位置起剥离首个 frag（返回剥离后的文本、字数与**新游标**）。
 *
 * 为什么必须定位而不是全局 indexOf：条目在 spoken 文本里顺序出现，剥离目标是
 * 「**某一条**的某半句」。当两条条目的文本恰好相同（LLM 偶发）时，全局 `indexOf`
 * 会删中**前一条**的解读 —— 调用方因此先用本条自身的锚点（商机 = topic）定位到
 * 本条在稿中的位置，再从其**之后**找目标片段。
 */
function stripOnce(
  hay: string | undefined,
  frag: string,
  from: number,
): { text: string; removed: number; cursor: number } {
  const h = hay ?? "";
  if (!frag || from < 0) return { text: h, removed: 0, cursor: from };
  const i = h.indexOf(frag, from);
  if (i < 0) return { text: h, removed: 0, cursor: from };
  // 商机口播句式是「{客群}方面，{主题}，{影响}」：剥离影响后，它前面的那个「，」会裸露
  // （「…主题，」悬空、或与下一条黏连）。故：若 frag 前一个字符是分句分隔符，则**连它一起吞掉**，
  // 并用句号收束，避免留下悬空逗号或把两条黏成一句。只吞一个分隔符，不动正文。
  const prev = h.slice(0, i).match(/[，,]$/);
  const cut = prev ? i - prev[0].length : i;
  const text = prev
    ? h.slice(0, cut) + (frag.endsWith("。") ? "。" : "") + h.slice(i + frag.length)
    : h.slice(0, i) + h.slice(i + frag.length);
  return { text, removed: h.length - text.length, cursor: cut };
}

/**
 * 收敛口播稿（纯函数，返回新对象，不 mutate 入参）。
 *
 * 只在 spoken_* 已存在时改写（文本缺省不凭空生成 —— 生成口径归 `syncNarration`）。
 */
export function condenseSpeech(exec: ExecutiveSummary): {
  exec: ExecutiveSummary;
  stats: SpeechOverlapStats;
} {
  const must = exec.must_read ?? [];
  const insights = exec.insights ?? [];
  const stats: SpeechOverlapStats = { insightEchoes: 0, savedChars: 0 };

  let spokenIns = exec.spoken_insights;

  // —— R2：必读↔商机（口播里商机只留主题）——
  if (spokenIns) {
    const mustUrls = new Set(
      must.map((m) => (m.url ? canonicalizeUrl(m.url) : "")).filter(Boolean),
    );
    let cursor = 0;
    for (const it of insights) {
      const anchor = it.topic ?? "";
      const at = anchor ? spokenIns.indexOf(anchor, cursor) : cursor;
      if (at < 0) continue;
      const after = at + anchor.length;
      if (echoesMustRead(it, mustUrls) && endSentence(it.topic)) {
        const r = stripOnce(spokenIns, endSentence(it.impact), after);
        if (r.removed > 0) {
          spokenIns = r.text;
          cursor = r.cursor;
          stats.insightEchoes++;
          stats.savedChars += r.removed;
          continue;
        }
      }
      cursor = after;
    }
  }

  // —— R2b：文本级复读裁剪（2026-10-13 sc 口径；R2 的 URL 判据抓不到的场景）——
  if (spokenIns) {
    const pruned = pruneInsightEchoes(spokenIns, exec.spoken_must_read);
    if (pruned.removedChars > 0) {
      spokenIns = pruned.text;
      stats.savedChars += pruned.removedChars;
      stats.prunedSentences = (stats.prunedSentences ?? 0) + pruned.removedSentences;
      stats.trimmedSentences = (stats.trimmedSentences ?? 0) + pruned.trimmedSentences;
      stats.pruneEchoes = [...(stats.pruneEchoes ?? []), ...pruned.echoes];
    }
  }

  if (stats.savedChars === 0) return { exec, stats };

  return {
    exec: {
      ...exec,
      ...(spokenIns ? { spoken_insights: spokenIns } : {}),
    },
    stats,
  };
}

/** 可观测日志行（C 项：让重复率在 CI 日志可见，此前完全不可观测）。 */
export function formatOverlapLog(stats: SpeechOverlapStats): string {
  if (stats.savedChars === 0) {
    return "口播跨段收敛：未发现同源重复（0 字可省）";
  }
  const r2b: string[] = [];
  if (stats.prunedSentences) r2b.push(`${stats.prunedSentences} 句纯复读删除`);
  if (stats.trimmedSentences) r2b.push(`${stats.trimmedSentences} 句剥离复读片段`);
  return (
    `口播跨段收敛：必读↔商机 ${stats.insightEchoes} 条压成「只留主题」` +
    (r2b.length ? `、${r2b.join("、")}` : "") +
    `，省 ${stats.savedChars} 字（约 ${(stats.savedChars / 5.2).toFixed(1)} 秒）`
  );
}

// ---------------------------------------------------------------------------
// R2b：口播商机段的**文本级**复读裁剪（2026-10-13 sc 口径，方案 A）
// ---------------------------------------------------------------------------

/**
 * ## 为什么需要 R2b（R2 为什么不够）
 *
 * sc 口径（2026-10-13）：「今日必读演化出来的商机，如果是**不同维度**对同一事件的分析，可以接受；
 * 但**同一件事在口播里念两遍**，这个不行。」
 *
 * R2 的设计意图**正是**这条口径（「事实已由必读给出，商机的独有价值是『这件事指向哪块业务』」），
 * 但它的判据在实际链路上三层失效：
 *   ① `echoesMustRead` 要求「商机 sources[].url 与必读 url 归一后相等」—— 而**商机 sources 常为空**
 *      （10-13 实测：6 条 insights 的 url 全为 undefined）→ 恒 false；
 *   ② 即便命中，`stripOnce` 用 `endSentence(it.impact)`（**卡面** impact 原文）去匹配
 *      **LLM 改写的口播文本** → `indexOf` 找不到 → 不动手（注释里已自认「退为安全网」）；
 *   ③ 同一事件由不同来源报道时 URL 本就不同，R2 天然抓不到。
 *
 * 实测代价（2026-10-13 扫描近 7 天口播稿）：**4/7 天存在复读、共 8 处**，
 * 最严重 10-12 一天 4 处（「美联储加息搅动全球债市」「三季度高频数据折射经济向好」等，
 * 必读段念完后、商机段紧接着再念一遍）。
 *
 * ## 判据（与 sc 共同确认）
 * - **复用率** = 商机句中有多少内容能在**必读口播段**找到（≥{@link INSIGHT_ECHO_MIN_SPAN} 字连续重合才算命中，
 *   避免两字巧合）；
 * - 复用率 **< 0.75** → 视为「带新维度的分析」→ **保留**（sc 明确可接受的那类）；
 * - 复用率 **≥ 0.75** 且剥离重合后**剩余 < {@link INSIGHT_ECHO_MIN_REST} 字** → 纯复读 → **删整句**；
 * - 复用率 ≥ 0.75 但剩余足够 → **只剥离重合片段**，保留新内容。
 *
 * ## 与「不删条」约束的关系
 * `condense.ts` 顶部的「**不删条**」约束针对的是**卡面 1:1 派生**的口播（每条 topic 必须出现）。
 * 本层处理的是 **LLM「按客群归并」产出的商机段** —— 它本就不保证每个 topic 出现（归并即会丢弃部分 topic），
 * 故「删整句」不破坏该约束。⛔ 但仍是**保守**实现：只在「重合率高 **且** 剩余几乎为空」两条同时成立时才删句。
 *
 * ⚠️ 教训（2026-10-13 第一版判据的错）：曾用「剥离后残余非空即算有增量」，结果 8 处全被判为「有增量」
 * —— 因为**残余本身也可能是必读的原话**。必须用「复用率」口径才能判准。
 */
export const INSIGHT_ECHO_MIN_SPAN = 8;
/** 剥离重合片段后，剩余内容少于此值 → 判定为纯复读，整句删除。 */
export const INSIGHT_ECHO_MIN_REST = 15;
/** 复用率阈值：达到即认为「该句主要在复述必读」。 */
export const INSIGHT_ECHO_RATIO = 0.6;

export interface PruneEchoResult {
  text: string;
  /** 被删/被剥离的总字数。 */
  removedChars: number;
  /** 因整句复读而删除的句子数。 */
  removedSentences: number;
  /** 仅剥离重合片段（保留了新内容）的句子数。 */
  trimmedSentences: number;
  /** 因片段边界会切断数字而**保守跳过**的句子数（宁可留着重复，不留残句）。 */
  skippedNumeric: number;
  /** 被判定为复读的原文片段（日志/测试可核对）。 */
  echoes: string[];
}

/** 内容字符判定（标点与空白不参与比对，但保留原位置用于回切）。 */
const isContentChar = (c: string) => !/[\s，。！？、；：「」『』（）()【】\[\]·—\-_"'~～…]/.test(c);

/** 数字/数词/量词 —— 剥离边界若紧邻这些字符，会把「三十三点五|万亿」这类结构切断。 */
const isNumberish = (c: string | undefined) =>
  !!c && /[0-9零一二三四五六七八九十百千万亿点成,.%]/.test(c) && !/[，。！？、；：]/.test(c);

/** 把字符串压成「仅内容字符」+ 原位置映射。 */
function contentMap(s: string): { chars: string; pos: number[] } {
  let chars = "";
  const pos: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (isContentChar(s[i])) {
      chars += s[i];
      pos.push(i);
    }
  }
  return { chars, pos };
}

/** 最长连续重合（去标点后 ≥ min 字），返回在 a/b 的 content 索引与长度。 */
function longestSpan(a: string, b: string, min: number): { len: number; ai: number; bi: number } {
  let best = { len: 0, ai: 0, bi: 0 };
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k >= min && k > best.len) best = { len: k, ai: i, bi: j };
    }
  }
  return best;
}

/** 清理剥离后可能出现的悬空标点与悬空助词（「，。」「，的」「强调，」等）。 */
function tidySentence(s: string): string {
  return s
    .replace(/[，,、；;]{2,}/g, "，")
    // 剥离后紧邻的助词/动词会裸露（「…亿美元，的配置咨询…」）→ 连标点一起收掉
    .replace(/[，,、；;]\s*(的|了|是|等|与|和|及)/g, "，")
    .replace(/[，,、；;]+([。！？])/g, "$1")
    .replace(/([。！？])[，,、；;]+/g, "$1")
    .replace(/^[，,、；;]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * R2b：裁剪「与必读口播段高度重复」的商机句子（纯函数，不 mutate 入参）。
 *
 * @param spokenInsights 商机口播段（LLM 优先 / 按客群归并）
 * @param spokenMustRead 必读口播段（卡面 1:1 确定性派生）
 */
export function pruneInsightEchoes(
  spokenInsights: string | undefined,
  spokenMustRead: string | undefined,
): PruneEchoResult {
  const src = (spokenInsights ?? "").trim();
  const must = (spokenMustRead ?? "").trim();
  const res: PruneEchoResult = {
    text: src,
    removedChars: 0,
    removedSentences: 0,
    trimmedSentences: 0,
    skippedNumeric: 0,
    echoes: [],
  };
  if (!src || !must) return res;

  const mustMap = contentMap(must);
  const sentences = src.split(/(?<=[。；])/).filter((s) => s.trim());
  const kept: string[] = [];

  for (const raw of sentences) {
    const sm = contentMap(raw);
    if (sm.chars.length < INSIGHT_ECHO_MIN_SPAN) {
      kept.push(raw);
      continue;
    }
    const span = longestSpan(sm.chars, mustMap.chars, INSIGHT_ECHO_MIN_SPAN);
    if (span.len < INSIGHT_ECHO_MIN_SPAN) {
      kept.push(raw);
      continue;
    }
    const ratio = span.len / sm.chars.length;
    const echoText = sm.chars.slice(span.ai, span.ai + span.len);
    // 原文回切位置：重合片段的（起, 止）
    const start = sm.pos[span.ai];
    const end = sm.pos[span.ai + span.len - 1] + 1;
    const restChars = sm.chars.length - span.len;

    if (ratio >= INSIGHT_ECHO_RATIO && restChars < INSIGHT_ECHO_MIN_REST) {
      // 纯复读（几乎整句都在复述必读）→ 删整句
      res.removedSentences++;
      res.removedChars += raw.length;
      res.echoes.push(echoText);
      continue;
    }

    // ⚠️ 数字保护（2026-10-13 实测教训）：若回切边界紧邻数字/数词/量词，剥离会把
    // 「三十三点五|万亿」这类结构切断（剩「理财规模三十三点五」残句）→ **保守跳过**该句。
    const before = sm.chars[span.ai - 1];
    const after = sm.chars[span.ai + span.len];
    if (isNumberish(before) || isNumberish(after)) {
      res.skippedNumeric++;
      kept.push(raw);
      continue;
    }

    // 有增量 → 只剥离重合片段
    const trimmed = tidySentence(raw.slice(0, start) + raw.slice(end));
    if (contentMap(trimmed).chars.length < INSIGHT_ECHO_MIN_SPAN) {
      // 剥完已无实质内容 → 整句删除
      res.removedSentences++;
      res.removedChars += raw.length;
      res.echoes.push(echoText);
      continue;
    }
    res.trimmedSentences++;
    res.removedChars += raw.length - trimmed.length;
    res.echoes.push(echoText);
    kept.push(trimmed);
  }

  if (res.removedChars === 0) return res;
  const joined = tidySentence(kept.join(""));
  return { ...res, text: joined };
}

