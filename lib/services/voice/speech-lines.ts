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

/** 风险单条口播行（固定句式，用户口径：不硬编、无风险则整段跳过）。 */
export function riskSpeechLine(r: { topic?: string; impact?: string; action?: string }): string {
  return `今天有 1 个需要警惕：${r.topic ?? ""}，${endSentence(r.impact)}${endSentence(r.action)}`;
}

/** 定调被「池内补位」时 exec-guard 给卡面加的前缀（派生口播时要去掉，否则念两遍）。 */
const HERO_FALLBACK_PREFIX = "今日分行焦点：";

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
  const raw = (heroLine ?? "").trim();
  if (!raw) return "";
  const body = raw.startsWith(HERO_FALLBACK_PREFIX)
    ? raw.slice(HERO_FALLBACK_PREFIX.length).trim()
    : raw;
  // 补位标题常带「！」「？」收尾 → 先剥宽句末标点，再由 endSentence 补且只补一个「。」
  return endSentence(body.replace(/[。．.!！?？；;]+$/, ""));
}
