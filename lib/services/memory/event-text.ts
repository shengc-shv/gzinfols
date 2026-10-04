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
 * **地域锚的取材边界**：地域只从**标题**取，正文里的地域词一律不算事件事实。
 *
 * 为什么（2026-10-03 sc 实证，本常量存在的唯一理由）：
 * 候选取文是 `title + why/impact`，而 why/impact 是 LLM 写的**面向我行**的解读
 * ——「居民资产向净值化产品迁移…**广州分行**零售AUM的结构…」里的「广州」说的是
 * 「这件事与我行的关系」，**不是**「事件发生在哪」。
 *
 * 实测 10-03「公募规模近40万亿」（**全国性数据**，39.63 万亿是全国公募总规模）：
 *  - 标题锚 `["基金","#40万亿"]` —— 干净；
 *  - 加上正文后变成 `["基金","广州","#40万亿"]` —— 「广州」纯属噪音；
 *  - 危害不止于判重：`extractFacts` 会把正文的「广州」抽成 `@广州`，
 *    而它**不在**历史事件的已播事实里 → 被当成「新事实」→ 一条 `@广州` 就贡献
 *    `0.45 × (1/2) = 0.225` 的 novelty，把该条从 0.17 抬到 **0.396**，
 *    正好跨过必读门槛 0.3 → **同一件事在 09-28 播过、10-03 又原样放行**。
 *
 * 口径：**事件的地域属性写在标题里**（「广州楼市新政」），标题没写就等于这条不挑地域。
 */
const GEO_ANCHORS = ["广州", "广东", "大湾区", "南沙", "粤"];

/** 是否为地域锚（裸词形态，供 `eventFingerprint` 产物比对）。 */
function isGeoAnchor(a: string): boolean {
  return GEO_ANCHORS.includes(a);
}

/** 是否为地域事实（`@` 前缀形态，供 `extractFacts` 产物比对）。 */
function isGeoFact(f: string): boolean {
  return f.startsWith("@") && GEO_ANCHORS.some((g) => f === `@${g}`);
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
  while ((m = NUM_RE.exec(t))) out.add("#" + m[0].replace(/\s+/g, "").replace(/万亿元/g, "万亿"));
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
  // 「公募」2026-10-03 补：主体锚词表（EVENT_ANCHORS）与主题词表都漏了它，
  // 使「公募规模近40万亿」既丢主体锚、也丢主题标签（只剩「广州本地」），
  // 判重两头都判不出来。词表口径须与 EVENT_ANCHORS 保持一致。
  {
    tag: "财富管理",
    kws: ["理财", "基金", "黄金", "保险", "资管", "信托", "债基", "ETF", "REITs", "公募"],
  },
  { tag: "私行客群", kws: ["私行", "高净值", "家族信托", "客群", "获客", "新客", "开户"] },
  // 「普惠」2026-10-04 去裸词：它同时属**金融语境**与**市政/公共服务语境**，
  // 裸词会让「面向全社会普惠开放，广州琶洲南 CBD 公共客厅项目获批」被归到「消费信贷」主题
  // （实证：该条主题原为 `["消费信贷","广州本地"]`，而它与银行业务毫无关系）。
  // 配对词保金融语境：真实普惠新闻通常带「金融/小微/贷款/信贷」之一；
  // 纯市政表述（普惠开放、普惠性服务）则不命中 → 不再误挂金融主题。
  { tag: "消费信贷", kws: ["消费贷", "经营贷", "小微", "信用卡", "普惠金融", "普惠小微", "普惠贷款", "普惠信贷"] },
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

/** 候选的事件锚点集合（复用展示层同一套指纹，保证口径一致）。
 *
 *  取材：**标题锚 ∪（正文锚 − 地域锚）** —— 地域只认标题（见 `GEO_ANCHORS`）。
 *  正文里的「广州分行」既不进锚点集合（免得成为伪共享证据、稀释真信号），
 *  也不会被 `extractFacts` 当成「新事实」。 */
export function candidateAnchors(c: MemoryCandidate): string[] {
  const out = eventFingerprint(c.title ?? "");
  for (const a of eventFingerprint(c.text ?? "")) {
    if (!isGeoAnchor(a)) out.add(a);
  }
  return [...out];
}

/**
 * 候选事实锚点 = 标题事实 ∪（正文事实 − 地域事实）。
 *
 * 与 `extractFacts` 的唯一差别：**正文里的地域词不算「新事实」**（见 `GEO_ANCHORS`）。
 *
 * 🔴 判重链路「写入」与「比对」必须同口径：`computeNovelty`（比对历史已播事实）与
 * `event-settle`（写入 `broadcastedFacts`）都走本函数 —— 否则会重演
 * 「写进去的」和「拿来比的」不是同一套的老坑。
 */
export function candidateFacts(c: MemoryCandidate): string[] {
  const out = extractFacts(c.title ?? "");
  const seen = new Set(out);
  for (const f of extractFacts(c.text ?? "")) {
    if (isGeoFact(f) || seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out;
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

/**
 * **候选侧锚点覆盖率**：`|A ∩ B| / |A|` —— 候选的锚有多少被历史事件覆盖。
 *
 * 为什么要它（2026-10-03 sc 立项，实测驱动）：`record.anchors` **只增不减**
 * （同一事件每出现一次就把新锚并进去，见 `findMatchingEvent` 的合并逻辑），
 * 于是老事件的 `|B|` 单调膨胀 → `anchorJaccard` 的分母 `|A∪B|` 越来越大 →
 * **同一个事件，历史记录越"丰富"，越难被再次匹配**（自我恶化）。
 *
 * 实测（10-03 期 vs 09-28 期，同一件事「公募规模 40 万亿」）：
 *  - 老事件 anchors 已累积 6 个，候选只有 `["广州","#40万亿"]` → Jaccard 仅 **0.143**（远低于 0.5）；
 *  - 但候选的 2 个锚里有 1 个被覆盖 → 覆盖率 **0.5**，恰好达标。
 *
 * 守卫（防误并，实测校准）：
 *  - **双方锚点数均 ≥ 2** —— 单锚候选信息量不足；
 *  - **至少共享 2 个锚**（与 `sameEvent` 的 `minShared=2` 同口径）—— 只共享 1 个锚不足以判同：
 *    实测 10-03 必读#2 只有 2 个锚（`广州` + `#40万亿`，前者是通用地域词），
 *    只共享 1 个就达标会让它与 **6 个无关事件并列 0.500**（按揭 / 保险 / 客群…），
 *    而正确的公募事件反而被挤出 —— 这种"锚点本身就缺"的漏判，靠放宽匹配救不了。
 */
export function candidateCoverage(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size < 2 || B.size < 2) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  if (inter < 2) return 0;
  return inter / A.size;
}

/** 两个标签数组的共享数量。 */
export function sharedTags(a: string[], b: string[]): number {
  const B = new Set(b);
  let n = 0;
  for (const x of a) if (B.has(x)) n++;
  return n;
}

/**
 * **通用锚**（地域 + 监管机构）：出现频率极高、不承载「这是哪件事」的身份。
 *
 * 实测（2026-10-03，全库 83 个事件）：`广州` 出现在 17 个事件里，`央行`/`证监会` 等
 * 监管机构遍布全部政策类事件。因此它们**不能**单独作为「同一事件」的证据 ——
 * 「广州某银行被罚」与「广州楼市新政」共享 `@广州`，却是两件事。
 */
const GENERIC_ANCHORS = new Set<string>([
  "央行", "人民银行", "金融监管总局", "金监总局", "国务院", "证监会", "发改委",
  "财政部", "住建部", "外汇局", "美联储", "交易所", "北交所", "科创板", "创业板",
  "广州", "广东", "大湾区", "南沙", "粤",
]);

/** 业务主体锚：锚点里排除**数字锚**（增量证据，不表身份）与**通用锚**后剩下的部分
 *  （基金 / 理财 / 房贷 / 消费贷 / 私行 …）—— 它们才回答「这是哪件事」。 */
export function subjectAnchors(anchors: string[]): string[] {
  return anchors.filter((a) => !a.startsWith("#") && !GENERIC_ANCHORS.has(a));
}

/**
 * **主体锚共享数**：「主体 × 主题」身份中的主体一半。
 *
 * 为什么要它（2026-10-03 sc 口径：事件身份应由「主体 + 主题」承担，
 * 数值与时点只作「增量证据」）：锚点相似度会被措辞差异打败，而**业务主体**
 * （在谈基金？还是在谈房贷？）是最稳定的身份线索。
 *
 * 守卫：**至少共享 1 个主体锚**，且双方各自都要有主体锚 —— 两边都空时不是「一致」，
 * 而是「无从判断」，必须返回 0（否则会把两条都没有主体锚的候选误判为同一主题）。
 */
export function sharedSubjectAnchors(a: string[], b: string[]): number {
  const A = subjectAnchors(a);
  const B = new Set(subjectAnchors(b));
  if (A.length === 0 || B.size === 0) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
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
