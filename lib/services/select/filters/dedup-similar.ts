/**
 * 标题相似度判重（归一化边界②，漏斗之后、AI 之前）。
 *
 * 用户规则（2026-08-19）：同一主题（标题相似度 ≥ threshold）最多保留
 * maxPerTheme 条（默认 2），且**同 tier 只留 1 条**——两个政府源（T1）发同
 * 一消息只留 1；政府 + 媒体 = 政府留 1 + 媒体留 1（共 2）。保留优先级按
 * 来源等级：T1 官方一手 > T1.5 准官方·机构一手 > T2 媒体·智库 > 无等级。
 *
 * ❗ 2026-10-05 sc 口径（**簇内取舍改用价值**）：tier 优先不变，但**同 tier 争同一席位时
 * 按内容价值分取舍，⛔ 不再按 publishedAt** —— 时间只能证明「谁先发」，证明不了
 * 「谁更有信息量」。实测：83 分「某大行广东省分行已受理贴息房贷逾百户」被晚 4 分钟的
 * 78 分「多家银行跟进！房贷贴息操作细则陆续披露」挤掉。分差门槛不再设（惟一并列判据
 * 就是分值）；分值相同则保持输入顺序，保证确定性。
 *
 * 与 URL 精确判重（dedupeByUrl）互补：URL 判重管"同一条"，本模块管
 * "同一事件的多家报道"（不同 URL、相似标题）。放在 AI 之前执行，
 * 让 LLM 只处理保留条目（省钱）。
 */
import type { ArticleInput } from "../../../contracts/article";
import { canonicalizeUrl } from "../../../utils/url";
import { SOURCE_TIERS, type SourceTier } from "../../../contracts/source";

export interface SimilarDedupOptions {
  /** 标题相似度阈值（0-1），≥ 阈值视为同一主题。默认 0.7。 */
  threshold?: number;
  /** 每个主题最多保留条数。默认 2。 */
  maxPerTheme?: number;
  /**
   * **内容价值函数**（分行相关性分）。同 tier 竞争同一席位时按它降序取舍。
   *
   * 2026-10-05 sc 口径：**簇内取舍只按价值，⛔ 不用时间** —— 时间只能证明「谁先发」，
   * 证明不了「谁更有信息量」。实测反例：83 分「某大行广东省分行已受理贴息房贷逾百户」
   * 被晚 4 分钟的 78 分「多家银行跟进！房贷贴息操作细则陆续披露」挤掉。
   *
   * 注入式（而非本模块 import 评分器）：保持本模块纯函数、可单测、零词表耦合。
   * 未注入时全部记 0 分 → 退化为**输入顺序**（确定性，且仍然不使用时间）。
   */
  scoreOf?: (a: ArticleInput) => number;
}

export interface SimilarDedupResult {
  kept: ArticleInput[];
  removed: ArticleInput[];
}

/** 标题字符二元组（bigram）集合——中文标题相似度的零依赖近似。 */
export function titleBigrams(s: string): Set<string> {
  // 去除所有非字母/数字字符（含中英文标点、空白、符号），仅保留 \p{L}\p{N}。
  // 让「央行：降准！」与「央行降准」归一化为同一 bigram 序列，提升对同事件
  // 不同措辞（标点/全半角差异）的合并率（B：内容级去重增强，2026-08-20）。
  const t = s.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
  const grams = new Set<string>();
  if (t.length === 0) return grams;
  if (t.length === 1) {
    grams.add(t);
    return grams;
  }
  for (let i = 0; i < t.length - 1; i++) grams.add(t.slice(i, i + 2));
  return grams;
}

/** Jaccard 相似度：交集 / 并集。 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Dice 系数：2 × 交集 / (A + B)——对长度差异与措辞改写更宽容（跨天判重用）。 */
export function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  const denom = a.size + b.size;
  return denom === 0 ? 0 : (2 * inter) / denom;
}

/** 两标题相似度（bigram Jaccard）。 */
export function titleSimilarity(a: string, b: string): number {
  return jaccard(titleBigrams(a), titleBigrams(b));
}

/** 两标题相似度（bigram Dice，跨天判重专用）。 */
export function titleSimilarityDice(a: string, b: string): number {
  return dice(titleBigrams(a), titleBigrams(b));
}

// ---------------------------------------------------------------------------
// 事件指纹（2026-08-29）：合并「同事件不同措辞」
// ---------------------------------------------------------------------------
/**
 * 背景：字面 bigram Dice 对「同事件不同措辞」几乎失效——实测「重磅！房贷期限延至40年」
 * 与「央行两部门：房贷最长可贷40年」的 Dice 仅 0.21-0.29，远低于阈值 0.7，
 * 导致同一政策被 4-7 家媒体各转述一次就各保留一条（用户反馈：房贷40年出现 7 次）。
 *
 * 方案：改用「显著关键词 + 数字锚点」签名。两标题共享 ≥2 个锚点即判为同一事件。
 * 该判据已在本项目评分兜底（buildExecutiveFromScores）中验证有效。
 */
/**
 * 事件锚点表（显著关键词，子串匹配）。
 *
 * ⚠️ 收词原则：**泛化主体词必须配对，不能用裸词**（2026-10-04 「普惠」教训）。
 * 裸词「普惠」同时属金融语境与市政/公共服务语境，于是
 * 「面向全社会普惠开放，广州琶洲南 CBD 项目获批」会拿到锚 `["普惠","广州"]`，
 * 与「广州普惠金融改革试点扩围」**共享 2 个锚 → 被判同一事件**（两者毫不相干）。
 * 这与「按揭」大杂烩同型：泛化词 + 地域即可凑满 `minShared=2` 的阈值。
 * 现改为配对词（真实普惠金融新闻必带「金融/小微/贷款/信贷」之一，纯市政表述不命中）。
 */
const EVENT_ANCHORS = [
  "央行", "人民银行", "金融监管总局", "金监总局", "国务院", "证监会", "发改委", "财政部", "住建部", "外汇局", "美联储",
  "房贷", "按揭", "抵押贷", "个贷", "住房贷款", "房地产信贷", "楼市", "购房", "房抵", "存量房贷", "商品房", "公积金", "缴存",
  "消费贷", "经营贷", "小微贷", "信贷", "LPR", "降息", "降准", "利率", "贴息",
  // 「普惠」2026-10-04 去裸词 → 配对词（与 THEME_RULES 口径保持一致）
  "普惠金融", "普惠小微", "普惠贷款", "普惠信贷",
  "理财", "基金", "黄金", "保险", "存款", "资管", "信托", "REITs", "ETF", "债基",
  "私行", "高净值", "家族信托", "客群", "获客", "新客", "开户", "代发", "信用卡", "养老",
  "罚", "处罚", "违规", "整改", "通报", "不良", "逾期", "违约", "爆雷",
  "IPO", "上市", "过会", "注册", "招股", "申购", "敲钟", "北交所", "科创板", "创业板",
  "广州", "广东", "大湾区", "南沙", "粤",
];

/** 数字锚点：40年 / 30年 / 5000元 / 1.5% / 38万亿 等——用于区分不同力度的同类政策。 */
function numericAnchors(title: string): string[] {
  const out: string[] = [];
  const re = /(\d+(?:\.\d+)?)\s*(年|个月|%|％|元|万元|亿元|万亿元|万亿|基点|bp|BP|倍|个百分点|‰)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(title))) out.push(m[1] + m[2]);
  return out;
}

/**
 * 同义词归一（2026-08-30 修复房贷40年板块内重复）：
 * 字面值不同的语义等价锚点归一到 canonical token，否则「住房贷款」与「房贷」、
 * 「住房公积金」与「公积金」会被当成两个独立锚点，导致同事件仅共享数字锚点（如 #40年）
 * 被判为不同事件、漏并。归一后「两部门：个人住房贷款…40年」与「个人房贷…40年」共享
 * {房贷, #40年} 两个锚点 → sameEvent=true → 合并。
 */
const ANCHOR_SYNONYMS: Array<[RegExp, string]> = [
  [/个人住房贷款|住房贷款|住房按揭|住房抵押贷|个人住房按揭贷款/g, "房贷"],
  [/住房公积金|个人住房公积金/g, "公积金"],
  // 公募（基金）：2026-10-03 补。词表只有「基金」，没有「公募」，导致
  // 「公募规模近40万亿」的**主体锚直接丢失**（只剩 `#40万亿` 一个数字锚），
  // 与历史事件「公募基金规模达39.63万亿」只共享 1 个锚 → 判为全新事件、
  // 09-28 播过的内容 10-03 又原样播一遍。归一后主体锚回到 `基金`。
  // 注：「公募」是专业词、不跨词，与「量产」那类易误配的短词不同，无需前置否定断言。
  [/公募(?:基金)?/g, "基金"],
];
function normalizeAnchorTokens(title: string): string {
  let s = title;
  for (const [re, rep] of ANCHOR_SYNONYMS) s = s.replace(re, rep);
  return s;
}

/** 事件指纹：标题包含的显著锚点集合（关键词 + 数字锚点，数字锚点带 # 前缀区分）。 */
export function eventFingerprint(title: string): Set<string> {
  const t = normalizeAnchorTokens(title);
  const fp = new Set<string>();
  for (const k of EVENT_ANCHORS) if (t.includes(k)) fp.add(k);
  for (const n of numericAnchors(t)) fp.add("#" + n);
  return fp;
}

/**
 * **通用锚**（地域 + 监管机构）：出现频率极高、不承载「这是哪件事」的身份。
 *
 * 实测（2026-10-03，全库 83 个事件）：`广州` 出现在 17 个事件里，`央行`/`证监会` 等
 * 监管机构遍布全部政策类事件。因此它们**不能**单独作为「同一事件」的证据 ——
 * 「广州某银行被罚」与「广州楼市新政」共享 `@广州`，却是两件事。
 *
 * 2026-10-04（T4）从 `memory/event-text.ts` **下沉到此处**：它与 `EVENT_ANCHORS`
 * 同属「事件身份词表口径」，而记忆判重与摘要层（定调防编造）都要用 —— 放在
 * memory 层会让生成层反向依赖判断层（触犯架构门禁方向规则）。
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

/** 两标题是否为「同一事件」：共享锚点数 ≥ minShared（默认 2）。 */
export function sameEvent(a: string, b: string, minShared = 2): boolean {
  if (!a || !b) return false;
  const fa = eventFingerprint(a);
  const fb = eventFingerprint(b);
  if (fa.size === 0 || fb.size === 0) return false;
  let shared = 0;
  for (const k of fa) if (fb.has(k)) shared++;
  return shared >= minShared;
}

/** tier 优先级排序权重（越小越优先保留）。 */
function tierWeight(tier: SourceTier | undefined): number {
  if (tier === undefined) return SOURCE_TIERS.length; // 无等级垫底
  const i = SOURCE_TIERS.indexOf(tier);
  return i === -1 ? SOURCE_TIERS.length : i;
}

/**
 * 标题相似度判重：把标题相似度 ≥ threshold 的条目聚为同一主题，
 * 每主题保留 ≤ maxPerTheme 条，且同一 tier 只留 1 条（不同 tier 可各留 1）。
 *
 * 簇内选择（2026-10-05 改口径）：按 (tier 优先级, **内容价值分降序**) 排序，
 * 贪心取不重复 tier 的条目。⛔ **不再使用 publishedAt** —— 同 tier 内「谁留下」
 * 由价值决定；分值相同则保持输入顺序（`Array#sort` 稳定排序，确定性）。
 */
export function dedupeByTitleSimilarity(
  articles: ArticleInput[],
  opts: SimilarDedupOptions = {},
): SimilarDedupResult {
  const threshold = opts.threshold ?? 0.7;
  const maxPerTheme = opts.maxPerTheme ?? 2;
  const scoreOf = opts.scoreOf ?? (() => 0);
  if (articles.length <= 1 || maxPerTheme < 1) {
    return { kept: articles, removed: [] };
  }

  // 贪心聚簇：每条与已有簇的代表比较，相似则入簇，否则新建簇。
  // B-2 跨源去重精度：先按 canonical URL 归一（同一文章不同 utm_*/协议/尾斜杠
  // 直接归一簇），再做标题相似度匹配（捕捉"同一事件不同源不同角度"）。
  const clusters: ArticleInput[][] = [];
  const reps: ArticleInput[] = [];
  const repCanonical: (string | undefined)[] = [];
  for (const a of articles) {
    let placed = false;
    const aCanon = a.url ? canonicalizeUrl(a.url) : undefined;
    for (let i = 0; i < reps.length; i++) {
      // 1) canonical URL 相同 → 直接归一簇（最强信号）
      if (aCanon && repCanonical[i] && aCanon === repCanonical[i]) {
        clusters[i].push(a);
        placed = true;
        break;
      }
      // 2) 标题相似度达阈值 → 归一簇（捕捉跨源同事件）
      if (titleSimilarity(a.title, reps[i].title) >= threshold) {
        clusters[i].push(a);
        placed = true;
        break;
      }
      // 3) 事件指纹命中 → 归一簇（2026-08-29：捕捉「同事件不同措辞」，
      //    字面 Dice 对这类改写几乎失效，实测仅 0.21-0.29）
      if (sameEvent(a.title, reps[i].title)) {
        clusters[i].push(a);
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.push([a]);
      reps.push(a);
      repCanonical.push(aCanon);
    }
  }

  const kept: ArticleInput[] = [];
  const removed: ArticleInput[] = [];
  for (const cluster of clusters) {
    if (cluster.length <= 1) {
      kept.push(...cluster);
      continue;
    }
    // 排序：tier 优先级升序，其次**内容价值分降序**（⛔ 不看 publishedAt）。
    // 分值相同 → 保持输入顺序（sort 稳定），保证确定性、可复现。
    const sorted = [...cluster].sort((a, b) => {
      const tw = tierWeight(a.tier) - tierWeight(b.tier);
      if (tw !== 0) return tw;
      return scoreOf(b) - scoreOf(a);
    });
    // 同 tier 只留 1（总是生效，与簇大小无关）；总上限 maxPerTheme。
    // 例：T1+T1 → 留 1；T1+T1.5 → 留 2；T1+T1.5+T2 → 留 T1+T1.5（2 条上限，T2 移除）。
    const seenTier = new Set<SourceTier | "none">();
    const picked: ArticleInput[] = [];
    for (const it of sorted) {
      const key: SourceTier | "none" = it.tier ?? "none";
      if (seenTier.has(key)) continue; // 同 tier 只留 1 条
      seenTier.add(key);
      picked.push(it);
      if (picked.length >= maxPerTheme) break;
    }
    kept.push(...picked);
    removed.push(...sorted.filter((x) => !picked.includes(x)));
  }

  return { kept, removed };
}

/** 参与跨天判重的历史条目（只需 title + tier）。 */
export interface HistorySimilarEntry {
  title: string;
  url: string;
  tier?: SourceTier;
}

/**
 * 跨天标题判重（先来后到）：新抓取的条目与历史库中标题相似（≥ threshold）的
 * 既有条目比较——同主题重复报道按「同 tier 只留 1、不同 tier 最多 maxPerTheme
 * 条、历史先来者优先占位」过滤。
 *
 * 用户规则（2026-08-19）：政府今天发公积金，明天某媒体发、后天又一家媒体发——
 * 这些都是同一主题的重复报道；历史条目先占位（T1），新条目仅当该 tier 空缺且
 * 总数 < 上限时才补充 1 条（T2），同 tier 的新条目互相去重只留 1，其余视为无效。
 *
 * 实现：历史 + 新条目混合贪心聚簇（历史先加入、作簇代表 = 先来后到），
 * 簇内按「历史占位 → 新条目按 (tier 优先级, **内容价值分降序**) 填补空缺」选择
 * （2026-10-05：新条目排序不再看 publishedAt）。
 * 相似度用 bigram Dice（对措辞改写更宽容），默认阈值 0.6（低于当日内部判重
 * 的 0.7——跨天抓的是「媒体改写政府通稿」这类措辞近似的重复报道）。
 */
export function dedupeAgainstHistory<T extends { title: string; tier?: SourceTier }>(
  articles: T[],
  history: HistorySimilarEntry[],
  opts: { threshold?: number; maxPerTheme?: number; scoreOf?: (a: T) => number } = {},
): { kept: T[]; removed: T[] } {
  const threshold = opts.threshold ?? 0.6;
  const maxPerTheme = opts.maxPerTheme ?? 2;
  const scoreOf = opts.scoreOf ?? (() => 0);
  if (articles.length === 0) return { kept: articles, removed: [] };

  type Cand = {
    title: string;
    tier?: SourceTier;
    kind: "hist" | "new";
    item: T | null;
  };
  const gramsCache = new Map<string, Set<string>>();
  const gramsOf = (t: string): Set<string> => {
    let g = gramsCache.get(t);
    if (!g) {
      g = titleBigrams(t);
      gramsCache.set(t, g);
    }
    return g;
  };

  // 混合聚簇（历史先加入 → 历史条目优先成为簇代表；相似度用 Dice，更宽容）
  const clusters: Cand[][] = [];
  const reps: Set<string>[] = [];
  const add = (c: Cand): void => {
    const g = gramsOf(c.title);
    for (let i = 0; i < reps.length; i++) {
      if (dice(g, reps[i]) >= threshold) {
        clusters[i].push(c);
        return;
      }
    }
    clusters.push([c]);
    reps.push(g);
  };
  for (const h of history) {
    if (!h || !h.title) continue;
    add({ title: h.title, tier: h.tier, kind: "hist", item: null });
  }
  for (const a of articles) add({ title: a.title, tier: a.tier, kind: "new", item: a });

  const kept: T[] = [];
  const removed: T[] = [];
  for (const cluster of clusters) {
    const newItems = cluster.filter((c) => c.kind === "new");
    if (newItems.length === 0) continue;
    // 历史先来者占位：历史条目的 tier 集合（同 tier 只占 1 个位置）
    const occupied = new Set<SourceTier | "none">();
    for (const h of cluster) {
      if (h.kind === "hist") occupied.add(h.tier ?? "none");
    }
    // 新条目按 (tier 优先级, **内容价值分降序**) 排序，填补空缺；同 tier 只补 1 个。
    // 2026-10-05：与当日判重同口径 —— ⛔ 不再用 publishedAt 决定谁补位。
    // 注：「历史先来者占位」是**跨天不重复**机制（不是「两条并存比时间」），保持不变。
    const scoreOfCand = (c: Cand): number => (c.item ? scoreOf(c.item) : 0);
    const sorted = [...newItems].sort((a, b) => {
      const tw = tierWeight(a.tier) - tierWeight(b.tier);
      if (tw !== 0) return tw;
      return scoreOfCand(b) - scoreOfCand(a);
    });
    for (const c of sorted) {
      const key: SourceTier | "none" = c.tier ?? "none";
      const fits = !occupied.has(key) && occupied.size < maxPerTheme;
      if (fits) {
        occupied.add(key);
        kept.push(c.item!);
      } else {
        removed.push(c.item!);
      }
    }
  }
  return { kept, removed };
}
