/**
 * 口播跨段收敛层（2026-09-25，用户反馈「听起来重复较多」后立项 A+C）。
 *
 * ## 病根（实测 2026-09-25 期）
 * `must_read`（宏观大信号）与 `insights`（落地动作）**按设计允许共用同一篇素材** ——
 * 见 `enrich/executive-summary.ts#dedupeExecutiveCrossSection` 注释：
 * 「只删 risk：must_read 与 insights 本就是两块、允许共存」。卡面视角下无妨（读者可跳读），
 * 但口播是**线性流**；而 `syncNarration` 又把两段各自 1:1 逐字派生 → 同一事实被念两遍。
 * 实测：定调 + 必读 + 商机三段中，3 个事件合计 622 字 = 全稿 51%
 * （「美元/加息」在定调、必读#2、必读#3、商机#1 里讲了 **4 次**）。
 *
 * ## 本层做什么（只动口播文本，做「视角分工」收敛）
 * - **R1 定调↔必读**：必读里与定调同源的条目，口播**只点题**（保留 title，去掉 why 的解读）。
 *   理由：定调已经是「结论 + 建议」的详述处，why 的「对分行意味着什么」与之重叠度最高。
 * - **R2 必读↔商机**：商机里与必读同源的条目，口播**只留动作**（保留 topic + action，
 *   去掉 impact 的事实复述）。理由：事实已由必读给出，商机的独有价值是「做什么」。
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
import { extractFacts } from "../memory/event-text";
import { USED_EVENT_TITLE_DICE } from "../memory/event-types";
import { titleSimilarityDice } from "../select/filters/dedup-similar";
import { canonicalizeUrl } from "../../utils/url";
import { endSentence } from "./speech-lines";

/**
 * 必读与定调同源时，口播保留哪半句。
 * - `title`（默认）：只点题，语法最稳（title 按提示词要求是「15 字内自足标题」）。
 * - `why`：保留解读、去掉数字句 —— 若日后更看重「对分行意味着什么」，改这一个常量即可。
 */
export const MUST_READ_ECHO_MODE: "title" | "why" = "title";

export interface SpeechOverlapStats {
  /** 必读中与定调同源、被压成点题的条数。 */
  heroEchoes: number;
  /** 商机中与必读同源、被压成动作的条数。 */
  insightEchoes: number;
  /** 收敛掉的总字数（正数）。 */
  savedChars: number;
}

/**
 * 硬事实锚点（`#` 数量 / `!` 动作词）。
 *
 * 刻意排除 `@` 机构与主题词：实测 2026-09-23 定调讲「央行重申宽松」，
 * 必读另有「央行在港发行 600 亿央票」—— 两者共享 `@央行` 却是**不同事件**，
 * 用 `@` 判定会误删解读。数量与动作词才是事件的硬标识。
 */
function hardFacts(text: string | undefined): Set<string> {
  return new Set(
    extractFacts(text ?? "").filter((f) => f.startsWith("#") || f.startsWith("!")),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

/** 定调是否已在讲这条必读（同源判定：标题 Dice 达标 或 共享 ≥1 个硬事实）。 */
export function echoesHero(heroLine: string, m: { title?: string; why?: string }): boolean {
  if (!heroLine.trim()) return false;
  const title = m.title ?? "";
  if (title && titleSimilarityDice(heroLine, title) >= USED_EVENT_TITLE_DICE) return true;
  const hero = hardFacts(heroLine);
  if (hero.size === 0) return false;
  return overlap(hero, hardFacts(`${title}。${m.why ?? ""}`)) >= 1;
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
 * 「**某一条**的某半句」。当两条条目的 why/impact 文案恰好相同（LLM 偶发）时，
 * 全局 `indexOf` 会删中**前一条**的解读 —— 调用方因此先用本条自身的锚点
 * （必读=title / 商机=topic）定位到本条在稿中的位置，再从其**之后**找目标片段。
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
  return { text: h.slice(0, i) + h.slice(i + frag.length), removed: frag.length, cursor: i };
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
  const hero = exec.hero_line ?? "";
  const must = exec.must_read ?? [];
  const insights = exec.insights ?? [];
  const stats: SpeechOverlapStats = { heroEchoes: 0, insightEchoes: 0, savedChars: 0 };

  let spokenMr = exec.spoken_must_read;
  let spokenIns = exec.spoken_insights;

  // —— R1：定调↔必读（口播里必读只点题）——
  if (spokenMr && hero.trim()) {
    let cursor = 0;
    for (const m of must) {
      // 用本条自身 title 定位（无论是否收敛都要推进游标，否则后面的同名片段会匹配到前面那条）
      const anchor = m.title ?? "";
      const at = anchor ? spokenMr.indexOf(anchor, cursor) : cursor;
      if (at < 0) continue;
      const after = at + anchor.length;
      if (echoesHero(hero, m)) {
        const frag = MUST_READ_ECHO_MODE === "title" ? endSentence(m.why) : endSentence(m.title);
        // 守卫：剥完不能把这条念成空句（否则宁可不收敛）
        const rest = MUST_READ_ECHO_MODE === "title" ? m.title : m.why;
        if (endSentence(rest)) {
          const r = stripOnce(spokenMr, frag, after);
          if (r.removed > 0) {
            spokenMr = r.text;
            cursor = r.cursor;
            stats.heroEchoes++;
            stats.savedChars += r.removed;
            continue;
          }
        }
      }
      cursor = after;
    }
  }

  // —— R2：必读↔商机（口播里商机只留动作）——
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
      if (echoesMustRead(it, mustUrls) && endSentence(it.topic) && endSentence(it.action)) {
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

  if (stats.savedChars === 0) return { exec, stats };

  return {
    exec: {
      ...exec,
      ...(spokenMr ? { spoken_must_read: spokenMr } : {}),
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
  return (
    `口播跨段收敛：定调↔必读 ${stats.heroEchoes} 条压成点题 / 必读↔商机 ${stats.insightEchoes} 条压成动作，` +
    `省 ${stats.savedChars} 字（约 ${(stats.savedChars / 5.2).toFixed(1)} 秒）`
  );
}
