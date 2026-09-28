/**
 * 口播文本派生原语（2026-09-25 从 `pipeline/side-outputs/side-exec-summary.ts` 下沉）。
 *
 * 为什么下沉到服务层：口播稿的「逐条拼装口径」要被**两处**使用 ——
 *   ① `syncNarration()`：去重后把卡面数组 1:1 派生为 spoken_*（原实现）；
 *   ② `voice/condense.ts`：跨段收敛时要按同一口径定位并剥离重复片段（A+C 方案）。
 * 若两边各写一套拼接模板，必然漂移（本项目已多次踩「两套正则/两套口径」）。
 * 故单一实现在此，pipeline 侧改为 import。
 *
 * 纯函数、零副作用、零 LLM；不依赖 node: 与 adapters。
 */

import { stripHeroPrefix } from "../../utils/hero-text";

/** 商机条目的衔接词（轮换，缓解逐条拼接的生硬感）。 */
export const INSIGHT_CONNECTORS = ["此外，", "同时，", "另一条值得关注，", "另外，"];
/** 必读条目的衔接词（轮换）。 */
export const MR_CONNECTORS = ["其次，", "此外，", "还有，", "另外，"];

/** 客群段 → 口播友好短标签（存储值是完整业务词，朗读需精简）。 */
export const SEG_SPEAK_LABEL: Record<string, string> = {
  // 零售AUM：TTS 默认会把 "AUM" 当一个音节读（如 ao-mu），用户要求按字母发音
  // → 用空格把 A/U/M 拆开，强制逐字母朗读（展示 chip 仍写「零售AUM」）。
  零售AUM: "零售 A U M",
  "中高端客群(过亿资产)": "高端客户",
  普惠小微贷款客户: "普惠小微",
};

export function segSpeak(s: string): string {
  return SEG_SPEAK_LABEL[s] ?? s;
}

/** 客群前缀（无客群段 → 空串，不产出「具备商机的，」这种残句）。 */
export function segPhrase(segments?: string[]): string {
  if (!segments || segments.length === 0) return "";
  if (segments.length === 1) return `具备${segSpeak(segments[0])}商机的，`;
  return `具备${segSpeak(segments[0])}和${segSpeak(segments[1])}商机的，`;
}

/**
 * LLM 产出的 why / impact / action 字段**本身常已以「。」结尾**，拼接模板再补一个「。」
 * 就会产出「。。」——TTS 听感出现异常停顿、文本也不整洁。
 * 统一走本函数：先剥掉已有的句末标点，再补且只补一个「。」；空串返回空串（不产出孤立句号）。
 */
export function endSentence(s: string | undefined): string {
  const t = (s ?? "").trim().replace(/[。．.]+$/, "");
  return t ? `${t}。` : "";
}

/** 必读单条口播行：`{衔接词}{标题。}{why。}`。 */
export function mustReadSpeechLine(
  m: { title?: string; why?: string },
  connector: string,
): string {
  return `${connector}${endSentence(m.title)}${endSentence(m.why)}`;
}

/** 商机单条口播行：`{衔接词}{客群前缀}{主题}，{impact。}{action。}`。 */
export function insightSpeechLine(
  it: { topic?: string; impact?: string; action?: string; segments?: string[] },
  connector: string,
): string {
  return `${connector}${segPhrase(it.segments)}${it.topic ?? ""}，${endSentence(it.impact)}${endSentence(it.action)}`;
}

/* ───────── 商机口播：按客群归并（2026-09-28 sc 口径） ───────── */

/**
 * 商机口播为什么不再逐条 1:1（2026-09-28 sc 口径）。
 *
 * 09-28 实测痛点：卡面 6 条商机 → 口播 6 条 ×（topic+impact+action）≈ 662 字，
 * 既超出 520 字上限（末条 action 被砍成残句），又**听不懂重点** ——
 * 「消费补贴」「文旅商圈」「金融城地标」「社区零售（沃尔玛社区店）」四条同属本地消费获客，
 * 逐条铺陈到「荔湾扬韬广场周边商户」这种商户级细节，听众抓不住要点。
 *
 * 故口播改为**按客群归并**：同类场景合成一条，只讲「哪类客群、什么方向、让团队做什么」，
 * 具体商户名/动作细节留给卡面。LLM 正常产出 `spoken_insights` 时走 LLM 稿；
 * 本函数是 LLM 缺失时的**确定性兜底**（口径与 LLM 端 §3 一致：3~4 条、不念商户名）。
 */

/**
 * 无客群标签的商机在口播里的归并名。
 *
 * 不用卡面的「其他业务线」—— 那是给读者看的分类标签，读到耳朵里等于没说
 * （行领导视角实测：听不懂「其他业务线方面」指哪一块）。口播改用中性的「其他机会」；
 * LLM 正常产出时应在 prompt 约束下给出**实质方向名**（如「本地消费场景」「跨境客群」）。
 */
export const INSIGHT_OTHER_GROUP = "其他机会";
/** 组内主题最多列几个（超出以「X 等 N 条线索」概括，避免罗列）。 */
export const INSIGHT_GROUP_TOPIC_MAX = 2;
/** 组内动作的截断长度（字）。 */
export const INSIGHT_GROUP_ACTION_CHARS = 34;
/** 首段短于此长度时，向后补一段（避免「本周对接」这种无信息片段）。 */
export const INSIGHT_GROUP_MIN_HEAD_CHARS = 8;

export interface InsightSpeechGroup {
  /** 客群口播标签（零售 A U M / 高端客户 / 普惠小微 / 其他机会）。 */
  label: string;
  /** 该组要念的主题（已按上限概括）。 */
  topics: string[];
  /** 组内条数（调试用）。 */
  topicCount: number;
  /** 该组本周最该做的一件事（组内首条 action 的**首要动作片段**）。 */
  action: string;
}

/**
 * 取 action 的「首要动作」片段：先按句号/分号切出首句，再取其第一个逗号段
 * （首段过短则向后补一段），最后按标点回退截到 max 字（不产出半截词）。
 *
 * 为什么不止「取首句」：「节前走访文旅商户与景区票务方，打包收单、信用卡权益与小额消费贷方案，
 * 争取节庆期间独家权益位」整句 46 字 —— 作为口播仍太细；取到第一个逗号即「节前走访文旅商户与
 * 景区票务方」（14 字），才是「本周最该做的一件事」（2026-09-28 sc 口径：口播聚焦、去细碎）。
 */
function firstClause(raw: string | undefined, max: number): string {
  const t = (raw ?? "").trim().replace(/[。．.!！?？；;]+$/g, "");
  if (!t) return "";
  const sentence = t.split(/[。；;]/)[0]!.replace(/^[，,、\s]+/, "");
  const parts = sentence.split(/[，,]/);
  let head = parts[0] ?? "";
  for (let i = 1; i < parts.length && head.length < INSIGHT_GROUP_MIN_HEAD_CHARS; i++) {
    head = `${head}，${parts[i]}`;
  }
  if (head.length <= max) return head.replace(/[，,、]+$/, "");
  const cut = head.slice(0, max);
  const p = Math.max(cut.lastIndexOf("，"), cut.lastIndexOf("、"));
  return p >= INSIGHT_GROUP_MIN_HEAD_CHARS ? cut.slice(0, p) : cut;
}

/**
 * 按客群段归并商机（组顺序 = 首次出现顺序，组内主题保持原序）。
 * 无 `segments` 的条目归入 `INSIGHT_OTHER_GROUP` 组（口播用中性名，不用卡面的「其他业务线」）。
 */
export function groupInsightsForSpeech(
  insights: Array<{ topic?: string; impact?: string; action?: string; segments?: string[] }>,
): InsightSpeechGroup[] {
  const order: string[] = [];
  const acc = new Map<string, { topics: string[]; action: string }>();
  for (const it of insights) {
    const topic = (it.topic ?? "").trim();
    if (!topic) continue;
    const key = (it.segments ?? [])[0] ?? "";
    if (!acc.has(key)) {
      acc.set(key, { topics: [], action: "" });
      order.push(key);
    }
    const g = acc.get(key)!;
    g.topics.push(topic);
    if (!g.action && it.action) g.action = firstClause(it.action, INSIGHT_GROUP_ACTION_CHARS);
  }
  return order.map((key) => {
    const g = acc.get(key)!;
    const topics =
      g.topics.length > INSIGHT_GROUP_TOPIC_MAX
        ? [`${g.topics[0]}等${g.topics.length}条线索`]
        : g.topics;
    return {
      label: key ? segSpeak(key) : INSIGHT_OTHER_GROUP,
      topics,
      topicCount: g.topics.length,
      action: g.action,
    };
  });
}

/** 商机口播整段（按客群归并、序数词分条）：`第一，{客群}方面，{主题}，{动作}。`。 */
export function groupedInsightsSpeech(
  insights: Array<{ topic?: string; impact?: string; action?: string; segments?: string[] }>,
): string {
  const ordinals = ["第一，", "第二，", "第三，", "第四，", "第五，"];
  return groupInsightsForSpeech(insights)
    .map((g, i) => {
      const head = `${ordinals[i] ?? ""}${g.label}方面，${g.topics.join("、")}`;
      return g.action ? `${head}，${endSentence(g.action)}` : `${head}。`;
    })
    .join("");
}

/** 风险单条口播行（固定句式，用户口径：不硬编、无风险则整段跳过）。 */
export function riskSpeechLine(r: { topic?: string; impact?: string; action?: string }): string {
  return `今天有 1 个需要警惕：${r.topic ?? ""}，${endSentence(r.impact)}${endSentence(r.action)}`;
}

/**
 * 今日定调口播句（**兜底派生**用）。
 *
 * 正常路径的 `spoken_hero` 由 LLM 产出，且比卡面 `hero_line` 更完整 —— 09-25 实证：
 * 卡面「美联储10月加息概率逼近七成…」，口播多出一句建议动作（梳理美元货架、提示锁汇窗口）。
 * 所以**不能**像 insights/must_read/risk 那样 1:1 覆盖卡面，必须 LLM 优先。
 *
 * 但定调被判重、走「池内补位」时，`exec-guard` 会把 `spoken_hero` 清空（避免沿用被去重
 * 定调的旧稿），而**没有任何环节重新生成** → `voice/index.ts` 只读 `spoken_hero`
 * （注释明写「不读 report.hero_line」）→ **「今日定调」口播段整段消失**。
 * 2026-09-26 实证：补位期次（09-24 / 09-26）100% 丢定调口播，非补位期次（09-25 等）正常。
 *
 * 故补这个兜底：卡面有 `hero_line` 而 `spoken_hero` 为空 → 由 `hero_line` 派生一句。
 * @returns 空串表示「无可派生」（调用方据此置 undefined，口播段照常不产出）
 */
export function heroSpeechLine(heroLine?: string): string {
  // 前缀剥离复用 utils 的单一实现（页面 / 企微 / 口播消费端共用，避免三套各写一份）
  const body = stripHeroPrefix(heroLine);
  if (!body) return "";
  // 补位标题常带「！」「？」收尾 → 先剥宽句末标点，再由 endSentence 补且只补一个「。」
  return endSentence(body.replace(/[。．.!！?？；;]+$/, ""));
}
