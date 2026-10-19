/**
 * 主题跟踪 · 跨期主题聚类（治理版，2026-10-19）。
 *
 * 本文件是 2026-10-17 交接文档第 5 章的**落地修正版**：保留其「治精度不改阈值」的总体思路，
 * 但按 10-19 在 11 期 / 444 条真实语料上的实测，修正/新增 4 条：
 *
 *  ① **A 型去重（最严重）**：旧版按「标题前 12 字」去重 → 同一条新闻的正文卡与商机洞察
 *     被 LLM 各自改写标题后**去不掉**，实测 9/118 节点重复（7 处是此型，且常跨两个主题，
 *     如「抄底黄金ETF」同时出现在 财富 + 零售AUM客群）。改为 **`i`（url 派生）优先去重**，
 *     同 id 只留信息量最大的一版，标题 key 降级为兜底。
 *  ② **禁裸标签主题名**：「市场」「客群」「财富」「信贷」实测均成过主题名（行长视角无信息量）。
 *     label 必须命中业务词组白名单 `TOPIC_LABELS`，否则该簇不输出（宁缺毋滥）。
 *  ③ **单归属**：一个节点只进第一个命中的簇 —— 与 ① 合起来根治跨主题重复。
 *  ④ **maxNodes 参数化**：IPO 类主题 30，其他 12（旧版全局 12，而 IPO 每天 18~22 条，
 *     当天新增过半被截断看不见）。
 *  ⑤ **TopicNode 补 `d`**：旧版构造节点时漏传 MM/DD → 全部节点日期 undefined（B 型 bug）。
 *
 * 时间纪律：`today` 由调用方注入（用于沉底判定在装配层做，本模块不读时钟）。
 */
import type { SlimDay, SlimItem } from "./slim";

export interface TopicNode {
  /** 期次日期 YYYY-MM-DD */
  date: string;
  /** 展示日期 MM/DD（2026-10-19 B 型修复：原先漏传） */
  d: string;
  /** 条目 id（url 派生）—— 跨期去重主键 */
  i: string;
  /** 标题 */
  t: string;
  /** 来源 */
  s?: string;
  /** 板块键 */
  k: string;
  /** 摘要（截断） */
  x?: string;
  /** 重要度 1~3 */
  m?: number;
  /** 原文链接 */
  u?: string;
  /** 同一 id 在语料中共出现几期（>1 即「持续跟踪中」） */
  repeat?: number;
  /**
   * 该 id 出现过的**全部期次**（A 型去重的副产品）。
   *
   * 为什么必须有它：同 id 跨期合并成一个节点时，若只保留更早的 `date`，
   * 「同一新闻跟了 3 期」在簇的 dates 集合里就只剩 1 期 → `minDates` 门槛会把
   * 真正的跨期跟踪误杀（实测 fixture 暴露；真实语料因簇内还有其他节点而被掩盖）。
   */
  seenDates?: string[];
}

/** 带内部字段的节点（入簇过程用）。 */
type RawNode = TopicNode & { tags: string[]; rawCount: number };

export interface Topic {
  id: string;
  label: string;
  tags: string[];
  /** 出现过的期次（升序） */
  dates: string[];
  /** 跨度天数（含首尾） */
  spanDays: number;
  /** 进展节点（按日期升序 = 时间线顺序） */
  nodes: TopicNode[];
}

export interface ClusterOpts {
  /** 至少跨几期才算「跟踪中」的主题（默认 2） */
  minDates?: number;
  /** 最多输出多少个主题（默认 30） */
  maxTopics?: number;
  /** 每个主题最多保留多少节点（默认 12） */
  maxNodes?: number;
  /**
   * 标签出现率超过该比例即视为泛标签（默认 0.35）——
   * 泛标签不参与当**主标签**（否则「财富」会吸走大半版面）。
   */
  commonRatio?: number;
}

/**
 * 主题名白名单（业务语言）—— **机器标签 → 行长可读名称**。
 *
 * 为什么必须白名单：标签是「业务线 + 客群 + 主题词」混装的机器口径，
 * 直接拿标签当主题名会出现「市场」「客群」这种对读者零信息量的标题（实测复现）。
 * 不在表内的标签**不得成为主题名**（该簇不输出，宁缺毋滥）。
 *
 * ⚠️ 本表是 topics 模块的**展示映射**，不改 `sources.keywords.json` 词表本身；
 * 新增标签需同步此处（并补一条「未映射标签不输出」的锁测）。
 */
export const TOPIC_LABELS: Record<string, string> = {
  住房金融: "房贷与住房金融",
  普惠小微贷款客户: "普惠小微与经营贷",
  监管合规: "监管合规动态",
  竞对动态: "同业竞对动向",
  财富: "财富管理与产品",
  零售AUM: "零售AUM经营",
  政银合作: "政银与产业合作",
  科技金融: "科技金融",
  跨境: "跨境金融",
  信用卡: "信用卡业务",
  养老: "养老金融",
  消费贷: "消费信贷",
};

/**
 * ⛔ **地域 / 板块标签一律不得作为主题名**（2026-10-19 sc 指出）。
 *
 * 「粤」曾映射成「广东IPO动态」→ 那是**板块冒充主题**（交接报告列的头号旧问题），
 * 我为了让 IPO 有个去处又做回来了。更要紧的是它自相矛盾：二期方向是把 IPO 按
 * **辅导机构 / 时间密度**拆维度，一期若已把它当一张主题卡，二期就没有拆分的动机。
 *
 * 主题 = **业务属性**（房贷/消费信贷/财富管理/养老/跨境/监管…）；
 * IPO 是**板块**，它按业务标签参与（如带「科技金融」的 IPO 条目进「科技金融」），
 * 不单独成为主题。IPO 专属视图留给二期。
 */

/** 这些标签**永不出现在主题名里**（实测均为泛标签；命中即该簇不输出）。 */
export const BANNED_TOPIC_LABELS = new Set(["市场", "客群", "政策", "宏观", "资讯"]);

/**
 * 「板块标识标签」的集中度阈值：标签 ≥80% 出现在单一板块 → 视为该板块的标识
 * （如「粤」之于 IPO），**不因出现率高而判泛**。见 clusterTopics ② 的实测修正说明。
 */
export const SECTION_LABEL_CONCENTRATION = 0.8;

/**
 * 主题卡「相关标签」的三个限制（2026-10-19 修正）：
 *  - `CHIP_MIN_COVER`：标签在组内的覆盖率下限（<0.4 说明只是个别条目沾边，不算「相关」）；
 *  - `CHIP_MAX_GLOBAL_RATIO`：标签的全局占比上限（≥15% 的词如「财富」22%、「信贷」10% 太泛，
 *    对「这个主题还涉及什么」没有描述力，一律不进 chips）；
 *  - `CHIP_MAX`：标签总数上限（含主标签），多了会让卡片变成标签墙。
 *
 * 选法不是「全局最高频」——那会选出「财富」「信贷」这类滥标签（12 个主题里 9 个都有），
 * 而是「组内高覆盖 − 全局低占比」（见 clusterTopics ④）。
 */
export const CHIP_MIN_COVER = 0.4;
export const CHIP_MAX_GLOBAL_RATIO = 0.15;
export const CHIP_MAX = 4;

/** 稳定短哈希（djb2 → base36），保证主题 id 跨构建不变。 */
function topicIdOf(label: string): string {
  let h = 5381;
  for (let i = 0; i < label.length; i++) h = ((h << 5) + h + label.charCodeAt(i)) | 0;
  return `tp-${(h >>> 0).toString(36)}`;
}

/** 两个 YYYY-MM-DD 的自然日差（纯字符串运算）。 */
function dayGapKey(a: string, b: string): number {
  const pa = Date.parse(`${a}T00:00:00Z`);
  const pb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(pa) || Number.isNaN(pb)) return 0;
  return Math.max(0, Math.round((pb - pa) / 86_400_000));
}

/** 标题归一（去空白取前 16 字）—— 仅作 `i` 缺失时的兜底去重键。 */
function titleKeyOf(t: string): string {
  return String(t ?? "").replace(/\s+/g, "").slice(0, 16);
}

/** 条目信息量评分（同 id 多版本择优：摘要越长、重要度越高越能说明问题）。 */
function infoScore(it: { x?: string; m?: number; t?: string }): number {
  return (it.x?.length ?? 0) + (it.m ?? 1) * 20 + Math.min(20, (it.t?.length ?? 0));
}

/** 把「同 id 的多期/多板块版本」收敛成一个节点（A 型修复的核心）。 */
export function dedupeById(
  nodes: Array<TopicNode & { tags: string[] }>,
): Array<TopicNode & { tags: string[]; repeat: number; rawCount: number }> {
  const byId = new Map<string, TopicNode & { tags: string[]; repeat: number; rawCount: number; seenDates: string[] }>();
  const byTitle = new Map<string, string>(); // titleKey → id（兜底：无 id 时按标题归并）
  for (const n of nodes) {
    // 主键：条目 id；缺失时退化为标题前 16 字（并挂到已有 id 上，避免同标题两条）
    let key = n.i || "";
    if (!key) {
      const tk = titleKeyOf(n.t);
      key = byTitle.get(tk) ?? `t:${tk}`;
      byTitle.set(tk, key);
    }
    const prev = byId.get(key);
    if (!prev) {
      byId.set(key, { ...n, repeat: 1, rawCount: 1, seenDates: [n.date] });
      continue;
    }
    prev.rawCount++;
    prev.repeat++;
    // 记录全部出现期次（否则跨期期数信息丢失 → minDates 误杀，见 seenDates 注释）
    if (!prev.seenDates.includes(n.date)) prev.seenDates.push(n.date);
    // 标签并集（保留两侧信息）；展示日期取更早；标题/摘要取信息量更高的一版
    prev.tags = [...new Set([...prev.tags, ...n.tags])];
    if (n.date < prev.date) {
      prev.date = n.date;
      prev.d = n.d || prev.d;
    }
    if (infoScore(n) > infoScore(prev)) {
      prev.t = n.t;
      prev.x = n.x;
      prev.s = n.s;
      prev.k = n.k;
      prev.m = n.m;
      prev.u = n.u;
    }
  }
  return [...byId.values()];
}

/**
 * 节点截断（超容量时**保留首尾**）。
 *
 * 为什么不能简单 slice(0, cap)：节点按日期升序，取前 N 会把**最新进展全砍掉** ——
 * 而「后来怎么样了」正是读者打开主题页的原因。故保留「最早 2 个（起点）+ 最新 N-2 个」。
 */
function capNodes<T>(sorted: T[], cap: number): T[] {
  // ⚠️ 返回**副本**：调用方会对结果 reverse()（输出改为最新在上），不能让它改到入参。
  if (sorted.length <= cap) return [...sorted];
  const head = Math.min(2, cap);
  return [...sorted.slice(0, head), ...sorted.slice(sorted.length - (cap - head))];
}

/**
 * 跨期主题聚类（纯函数，可测）—— **按主标签分组**（2026-10-19 第二轮重写）。
 *
 * 为什么放弃「渐进式聚类 + 单归属」：该算法是**先到先得**的 —— 按日期扫描，谁先建簇
 * 谁就吞并后来者。实测（11 期 / 335 条）造成系统性偏差：
 *   · 「政银与产业合作」簇先建成 → 把 14 条「住房金融」节点吸走 → **房贷主题整个消失**；
 *   · 「跨境」「科技金融」同样被吞 → 三个重要业务主题缺失，且结果依赖数据顺序（不确定）。
 *
 * 现算法：**每个节点只归属它「最有区分度」的业务标签**（= 全局出现次数最少的白名单标签），
 * 然后按标签分组。好处：
 *   ① 确定性 —— 与数据顺序无关，同样的语料永远同样的主题；
 *   ② 无跨主题重复 —— 单归属的强化版（一个节点只进一组）；
 *   ③ 覆盖完整 —— 每个业务标签都能成组，不会被别的簇吞掉；
 *   ④ 简单 —— 无「交集阈值」「簇内覆盖率」这类需要标定的旋钮。
 *
 * 泛标签（出现率高且跨板块分散）不参与当主标签 —— 否则「财富」会吸走大半版面；
 * 但它在板块内高度集中（如「粤」之于 IPO）时不判泛，见 ② 的实测说明。
 *
 * 主题 = **业务属性**；地域/板块标签（如「粤」）已在白名单外，故 IPO 不单独成主题
 * （2026-10-19 sc 指出）—— 它的内容按业务标签归入对应业务主题。
 */
export function clusterTopics(days: SlimDay[], opts: ClusterOpts = {}): Topic[] {
  const minDates = opts.minDates ?? 2;
  const maxTopics = opts.maxTopics ?? 30;
  const maxNodes = opts.maxNodes ?? 12;
  const commonRatio = opts.commonRatio ?? 0.35;

  type RawNode = TopicNode & { tags: string[] };
  const all: RawNode[] = [];
  for (const d of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const it of d.items ?? []) {
      all.push({
        date: d.date,
        d: it.d ?? "",
        i: it.i ?? "",
        t: it.t,
        s: it.s,
        k: it.k,
        x: it.x,
        m: it.m,
        u: it.u,
        tags: it.g ?? [],
      });
    }
  }
  if (all.length === 0) return [];

  // ① A 型去重（聚类前）：同 id 只留一个节点（含 seenDates，供跨期判定）
  const nodes = dedupeById(all);

  // ② 标签频次 + 板块分布 → 泛标签
  const tagFreq = new Map<string, number>();
  const tagSections = new Map<string, Map<string, number>>();
  for (const n of nodes) {
    for (const g of n.tags) {
      tagFreq.set(g, (tagFreq.get(g) ?? 0) + 1);
      if (!tagSections.has(g)) tagSections.set(g, new Map());
      const m = tagSections.get(g)!;
      m.set(n.k, (m.get(n.k) ?? 0) + 1);
    }
  }
  /** 标签是否「板块标识型」：≥80% 集中在单一板块 → 有区分度，不判泛。 */
  const isSectionLabel = (g: string): boolean => {
    const m = tagSections.get(g);
    if (!m) return false;
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    if (total === 0) return false;
    return Math.max(...m.values()) / total >= SECTION_LABEL_CONCENTRATION;
  };
  const common = new Set<string>();
  for (const [g, n] of tagFreq) {
    if (n >= 3 && n / nodes.length >= commonRatio && !isSectionLabel(g)) common.add(g);
  }

  /** 某节点可当主标签的业务标签：白名单内、非禁、非泛。 */
  const bizTagsOf = (n: RawNode): string[] =>
    n.tags.filter((g) => TOPIC_LABELS[g] !== undefined && !BANNED_TOPIC_LABELS.has(g) && !common.has(g));

  // ③ 每个节点归属「最有区分度」的业务标签（频次最低；并列按字母序保证确定性）
  const groups = new Map<string, Array<typeof nodes[number]>>();
  for (const n of nodes) {
    const cands = bizTagsOf(n);
    if (cands.length === 0) continue; // 只有地域/泛标签 → 不成主题（宁缺毋滥）
    const main = cands.sort((a, b) => (tagFreq.get(a) ?? 0) - (tagFreq.get(b) ?? 0) || a.localeCompare(b))[0];
    if (!groups.has(main)) groups.set(main, []);
    groups.get(main)!.push(n);
  }

  // ④ 分组 → 主题
  const topics: Topic[] = [];
  for (const [main, members] of groups) {
    const dates = [...new Set(members.flatMap((n) => n.seenDates ?? [n.date]))].sort();
    // 跨期 + 节点数双门槛：单期谈不上跟踪；1 个节点跨多期是同一新闻重复报道
    if (dates.length < minDates || members.length < 2) continue;
    // ⚠️ 排序键是**条目发布日 `d`（MM/DD）**，不是归档期次 `date`。
    // 二者普遍差一天（报告 07:4x 生成，收的是前一天新闻）：按 date 排、页面显示 d，
    // 读者会看到「10/13 → 10/14」这种倒错（2026-10-19 实测抓出）。
    // `d` 缺失时回退到 date 的 MM/DD 部分。
    const dkey = (n: { d?: string; date: string }) => n.d || n.date.slice(5).replace("-", "/");
    const sorted = [...members].sort((a, b) => dkey(a).localeCompare(dkey(b)) || a.t.localeCompare(b.t));
    // 截断按**升序**做（capNodes 要保「最早 2 + 最新 N-2」），输出时反转 →
    // **最新进展排在最上**（2026-10-19 sc：读者打开就想看「后来怎么样了」，不该先翻历史）。
    const capped = capNodes(sorted, maxNodes).reverse();
    // 主题 chips：主标签 + **有区分度**的相关标签（2026-10-19 修正）。
    // ⚠️ 原实现按「全局频次降序」取，选出来的全是「财富」(22%)「信贷」(10%) 这类大词 ——
    // 12 个主题里 9 个都挂了「财富」chip，读者据此根本判断不出主题是什么
    // （sc 实测：点「财富」时「监管合规」也出来了）。
    // 正解：按「组内覆盖率 − 全局占比」降序（组内爱用 + 全局稀有 = 有区分度），
    // 且组内覆盖 ≥ CHIP_MIN_COVER 才算「相关」，最多 CHIP_MAX 个（含主标签）。
    const coverIn = (g: string) => members.filter((n) => n.tags.includes(g)).length / members.length;
    const related = [...tagFreq.keys()]
      .filter((g) => g !== main && !BANNED_TOPIC_LABELS.has(g))
      .map((g) => ({ g, cover: coverIn(g), global: (tagFreq.get(g) ?? 0) / nodes.length }))
      // 组内要有覆盖面（≥0.4）+ 全局不能太泛（<15%）—— 两条都过才算「有描述力的相关标签」
      .filter((x) => x.cover >= CHIP_MIN_COVER && x.global < CHIP_MAX_GLOBAL_RATIO)
      .sort((a, b) => b.cover - b.global - (a.cover - a.global) || a.g.localeCompare(b.g));
    const chips = [main];
    for (const x of related) {
      if (chips.length >= CHIP_MAX) break;
      chips.push(x.g);
    }
    topics.push({
      // id **只由主标签派生**：主题身份 = 业务标签，跨构建稳定（页面 hash 锚定要用它）。
      // ⚠️ 曾拼上「首个节点 id」→ 每天语料变、首节点跟着变 → id 漂移 → 收藏/分享的
      // `#topic=xxx` 隔天就失效。
      id: topicIdOf(TOPIC_LABELS[main]),
      label: TOPIC_LABELS[main],
      tags: chips,
      dates,
      spanDays: dayGapKey(dates[0] ?? "", dates[dates.length - 1] ?? "") + 1,
      nodes: capped.map((n) => ({
        date: n.date,
        d: n.d,
        i: n.i,
        t: n.t,
        s: n.s,
        k: n.k,
        x: n.x,
        m: n.m,
        u: n.u,
        repeat: n.repeat,
        seenDates: [...(n.seenDates ?? [n.date])].sort(),
      })),
    });
  }

  return topics
    .sort((a, b) => b.nodes.length - a.nodes.length || a.label.localeCompare(b.label))
    .slice(0, maxTopics);
}

/** 供装配层读取的扩展信息（质量分需要 rawCount，故聚类时一并带出）。 */
export function clusterTopicsDetailed(
  days: SlimDay[],
  opts: ClusterOpts = {},
): Array<{ topic: Topic; rawCount: number }> {
  const topics = clusterTopics(days, opts);
  // rawCount 用于密度因子：主标签分组下每个节点只进一组，去重前=去重后（密度恒 1）。
  // 保留该字段是为了接口稳定（未来若允许一节点多组，密度才有意义）。
  return topics.map((t) => ({ topic: t, rawCount: t.nodes.length }));
}
