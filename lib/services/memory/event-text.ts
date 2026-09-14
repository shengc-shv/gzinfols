/**
 * 事件记忆 —— 文本归一 / 事实与标签抽取 / 相似度（纯函数，2026-09-14 C-1 Phase4 纯搬移）。
 */
import { eventFingerprint, dice, titleBigrams } from "../select/filters/dedup-similar";
import type { EventKind, EventRecord, MemoryCandidate } from "./event-types";
export function normText(s: string): string {
  return (s ?? "").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
}

/** 候选文本（标题 + 正文），去空。 */
export function candidateText(c: MemoryCandidate): string {
  return [c.title, c.text ?? ""].filter(Boolean).join(" ").trim();
}

/**
 * 事实锚点抽取（信息增量的主要判据）。
 *
 * 三类，分别加前缀区分：
 *  - `#数字锚点`：40年 / 1.5% / 5000元 / 38万亿 —— 政策力度、规模数据
 *  - `!进展动词`：受理 / 问询 / 过会 / 落地 / 处罚 / 下调 —— 事件所处阶段
 *  - `@主体机构`：央行 / 金融监管总局 / 广州 / 本行 —— 涉及主体
 *
 * 为什么用事实锚点而非纯文本相似度：同一事件的不同报道，措辞高度雷同
 * （Dice 常 > 0.8），但只有**数字/阶段/主体**的变化才构成真正的「新进展」。
 */
const NUM_RE =
  /\d+(?:\.\d+)?\s*(?:个百分点|万亿元|万亿|亿元|万元|(?:个)?基点|bp|BP|年|个月|月|日|%|％|元|倍|‰|家|户|笔)/g;

const STAGE_WORDS = [
  "受理", "问询", "过会", "提交注册", "注册生效", "辅导备案", "招股", "申购", "敲钟",
  "批复", "落地", "实施", "施行", "试点", "扩围", "首单", "出台", "印发", "发布",
  "约谈", "处罚", "罚款", "通报", "整改", "下调", "上调", "降息", "降准", "加息",
  "受理申请", "正式生效", "窗口指导",
];

const ORG_WORDS = [
  "央行", "人民银行", "金融监管总局", "金监总局", "国务院", "证监会", "发改委",
  "财政部", "住建部", "外汇局", "美联储", "交易所", "北交所", "科创板", "创业板",
  "广州", "广东", "南沙", "大湾区",
];

export function extractFacts(text: string): string[] {
  const t = text ?? "";
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(t))) out.add("#" + m[0].replace(/\s+/g, ""));
  for (const w of STAGE_WORDS) if (t.includes(w)) out.add("!" + w);
  for (const w of ORG_WORDS) if (t.includes(w)) out.add("@" + w);
  return [...out];
}

/** 主题标签规则表（锚点 → 标签），用于「同一主题」的软去重与主题记忆。 */
const THEME_RULES: Array<{ tag: string; kws: string[] }> = [
  {
    tag: "住房金融",
    kws: ["房贷", "按揭", "公积金", "购房", "楼市", "住房", "房抵", "存量房贷", "商品房", "抵押贷"],
  },
  { tag: "利率流动性", kws: ["LPR", "降息", "降准", "利率", "贴息", "存款"] },
  {
    tag: "监管合规",
    kws: ["罚", "处罚", "违规", "整改", "通报", "不良", "逾期", "违约", "爆雷", "约谈"],
  },
  {
    tag: "资本市场",
    kws: ["IPO", "上市", "过会", "注册", "招股", "申购", "敲钟", "北交所", "科创板", "创业板"],
  },
  { tag: "财富管理", kws: ["理财", "基金", "黄金", "保险", "资管", "信托", "债基", "ETF", "REITs"] },
  { tag: "私行客群", kws: ["私行", "高净值", "家族信托", "客群", "获客", "新客", "开户"] },
  { tag: "消费信贷", kws: ["消费贷", "经营贷", "小微", "普惠", "信用卡"] },
  { tag: "广州本地", kws: ["广州", "广东", "大湾区", "南沙", "粤"] },
  { tag: "科技金融", kws: ["科技金融", "数字人民币", "金融科技"] },
];

/** 主题标签抽取（可能为空数组）。 */
export function extractTopicTags(text: string): string[] {
  const t = text ?? "";
  const tags: string[] = [];
  for (const r of THEME_RULES) {
    if (r.kws.some((k) => t.includes(k))) tags.push(r.tag);
  }
  return tags;
}

/** 事件类型判定（顺序敏感：越具体越靠前）。 */
export function classifyKind(text: string): EventKind {
  const t = text ?? "";
  if (STAGE_WORDS.some((w) => ["受理", "问询", "过会", "注册", "辅导备案", "招股", "申购", "敲钟"].includes(w) && t.includes(w)))
    return "ipo";
  if (t.includes("IPO")) return "ipo";
  if (/(处罚|罚款|违规|整改|通报|约谈|不良|爆雷|违约)/.test(t)) return "enforcement";
  if (/(国务院|央行|人民银行|金融监管总局|金监总局|证监会|发改委|财政部|住建部|外汇局|政策|新规|办法|通知|意见|试点|施行|条例|细则)/.test(t))
    return "policy";
  if (/(广州|广东|南沙|大湾区)/.test(t)) return "local";
  if (/(股|指数|板块|涨|跌|行情|收评|资金|北向)/.test(t)) return "market";
  return "generic";
}

// ---------------------------------------------------------------------------
// 4) 事件指纹与匹配
// ---------------------------------------------------------------------------

/** 候选的事件锚点集合（复用展示层同一套指纹，保证口径一致）。 */
export function candidateAnchors(c: MemoryCandidate): string[] {
  return [...eventFingerprint(candidateText(c))];
}

/**
 * 生成稳定事件 id。
 *
 * 取锚点集合中「最具区分度」的若干锚点（数字锚点 > 关键词锚点），
 * 排序后拼接。首次创建后 id 不再改变——后续同事件报道即使新增锚点，
 * 也只是合并进 record.anchors，不改 id（否则记忆会断裂）。
 */
export function makeEventId(anchors: string[]): string {
  const nums = anchors.filter((a) => a.startsWith("#")).sort();
  const kws = anchors.filter((a) => !a.startsWith("#")).sort();
  const picked = [...nums.slice(0, 2), ...kws.slice(0, 3)];
  if (picked.length === 0) return "";
  return picked.join("|");
}

/** 两个锚点集合的 Jaccard 相似度。 */
export function anchorJaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** 两个标签数组的共享数量。 */
export function sharedTags(a: string[], b: string[]): number {
  const B = new Set(b);
  let n = 0;
  for (const x of a) if (B.has(x)) n++;
  return n;
}

/**
 * 记录结构完整性校验（2026-09-02 复审修复·高优先级）。
 *
 * 背景：单条记录损坏（samples/anchors/topicTags 缺失或类型错误）会触发
 * `record.samples is not iterable`，异常冒泡到集成点 try/catch 后被
 * 「放行原产出」吞掉 → **整个记忆去重静默失效**，且因损坏记录被持续写回
 * 而**永不自愈**。用户只会感觉「又开始重复播报了」，日志仅一行 warn。
 *
 * 策略：损坏记录**逐条跳过**（不参与匹配），其余记录照常工作；
 * 配合 store.ts 落盘前清理，损坏记录不再写回 → 具备自愈能力。
 */
export function isUsableRecord(rec: unknown): rec is EventRecord {
  if (!rec || typeof rec !== "object") return false;
  const r = rec as Partial<EventRecord>;
  // 仅校验「会引发崩溃」的必填结构；数值/日期字段另行归一化，不因类型瑕疵丢弃整个事件
  return (
    typeof r.id === "string" &&
    r.id.length > 0 &&
    Array.isArray(r.samples) &&
    Array.isArray(r.anchors) &&
    Array.isArray(r.topicTags)
  );
}

/**
 * 矫正记录中的数值/日期字段类型，避免脏值污染计算。
 *
 * 为什么是「归一化」而非「丢弃」：peakScore 为字符串这类瑕疵只是局部脏值，
 * 整条事件丢弃会让它被遗忘（重复播报），代价大于收益；但若放任不管，
 * `Math.max("high", 0)` 会产出 NaN，进而让「重大事件双倍保留」判定恒假。
 */
export function normalizeRecord(rec: EventRecord): EventRecord {
  const out: EventRecord = { ...rec };
  if (!Number.isFinite(out.peakScore)) out.peakScore = 0;
  if (!Number.isFinite(out.broadcastCount) || (out.broadcastCount ?? 0) < 1) {
    out.broadcastCount = 1;
  }
  if (!Array.isArray(out.broadcastedTexts)) out.broadcastedTexts = [];
  if (!Array.isArray(out.broadcastedFacts)) out.broadcastedFacts = [];
  if (!Array.isArray(out.sections)) out.sections = [];
  if (!Array.isArray(out.anglesUsed)) out.anglesUsed = [];
  if (typeof out.lastBroadcastAt !== "string") {
    out.lastBroadcastAt = typeof out.firstBroadcastAt === "string" ? out.firstBroadcastAt : "";
  }
  if (typeof out.firstBroadcastAt !== "string") out.firstBroadcastAt = out.lastBroadcastAt;
  return out;
}

/** 剔除结构损坏的事件记录，并对保留记录做数值归一化（损坏者自愈式丢弃）。 */
export function sanitizeEvents(
  events: Record<string, EventRecord> | undefined | null,
): Record<string, EventRecord> {
  if (!events || typeof events !== "object" || Array.isArray(events)) return {};
  const out: Record<string, EventRecord> = {};
  for (const [id, rec] of Object.entries(events)) {
    if (isUsableRecord(rec)) out[id] = normalizeRecord(rec);
  }
  return out;
}

/** 与某条历史记录的最高标题 Dice（与最近若干条样本比）。 */
export function bestTitleDice(title: string, record: EventRecord): number {
  const g = titleBigrams(title);
  let best = 0;
  // 防御：samples 非数组或元素异常时退化为 0，不抛错
  const samples = Array.isArray(record.samples) ? record.samples : [];
  for (const s of samples) {
    if (!s || typeof s.title !== "string") continue;
    const d = dice(g, titleBigrams(s.title));
    if (d > best) best = d;
  }
  return best;
}

/** 合并阈值：硬信号（锚点 Jaccard / 标题 Dice）达此值即视为同一事件。 */
