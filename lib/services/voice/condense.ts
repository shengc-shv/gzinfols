/**
 * 口播跨段收敛层（2026-09-25 立项 A+C；**2026-09-28 起只保留 R2**）。
 *
 * ## 病根（2026-09-25 实测）
 * `must_read`（宏观大信号）与 `insights`（落地动作）**按设计允许共用同一篇素材** ——
 * 卡面视角下无妨（读者可跳读），但口播是**线性流**，同一事实被念两遍即重复。
 *
 * ## 本层做什么
 * - **R2 必读↔商机**：商机里与必读同源的条目，口播**只留动作**（保留 topic + action，
 *   去掉 impact 的事实复述）。理由：事实已由必读给出，商机的独有价值是「做什么」。
 *   ⚠️ 2026-09-28 起商机口播由 LLM 按客群归并产出、本就不念 impact，故 R2 退为**安全网**
 *   （只在「LLM 照抄了卡面 impact」时动手）。
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
  /** 商机中与必读同源、被压成动作的条数。 */
  insightEchoes: number;
  /** 收敛掉的总字数（正数）。 */
  savedChars: number;
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
  const must = exec.must_read ?? [];
  const insights = exec.insights ?? [];
  const stats: SpeechOverlapStats = { insightEchoes: 0, savedChars: 0 };

  let spokenIns = exec.spoken_insights;

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
    `口播跨段收敛：必读↔商机 ${stats.insightEchoes} 条压成动作，` +
    `省 ${stats.savedChars} 字（约 ${(stats.savedChars / 5.2).toFixed(1)} 秒）`
  );
}
