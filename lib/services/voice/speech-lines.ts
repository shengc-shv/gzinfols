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
