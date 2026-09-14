/**
 * 原始分组（`groupRaw`）与 GZ 口径表 / 标题去重（**业务规则**，2026-09-14 C-1 Phase2
 * 自 `render/full.ts` 纯搬移，行为零变化）。
 *
 * 为什么在 assemble 而不是 render：分组规则决定「哪些条目进哪个分类/子标签、每组合并后
 * 保留几条、哪些算重复」，是**业务判定**；此前与 HTML 主模板同居一个 1969 行的文件，
 * 单测要 import 整个渲染模块才能覆盖它。搬移后 `render/full.ts` 只负责把分组结果渲染出来。
 *
 * ⚠️ 残留耦合（Phase 2b 待办）：见 `./limits.ts` 头部说明 —— 共享词表仍来自 render 侧。
 */
import type { ArticleInput } from "../../contracts/article";
import { CATEGORY_ORDER, type Category } from "../../contracts/source";
import type { SourceDef, SourceTier } from "../../contracts/source";
import { IPO_CAPITAL_ACT_RE, IPO_FLOW_RE } from "../enrich/heuristics";
import {
  classifyGdIpo,
  inferStage,
  isGdStage,
  type GdIssuerRegistry,
  type GdStage,
} from "../classify/gd-ipo";
import { gdIpoStageOf } from "../classify/gd-ipo-spoken";
// 共享词表（Phase 2b 待下沉）：类型只在编译期存在（import type 会被擦除），
// 运行时依赖仅 CATEGORY_LABELS / sortByTierAndTime / SUBCATEGORY_LABELS / SUBCATEGORY_ORDER / V2EX_OFF_TOPIC_RE。
import type { RawByCategory, SourceGroup, SubGroup } from "../render/cards";
import { CATEGORY_LABELS, sortByTierAndTime } from "../render/cards";
import { SUBCATEGORY_LABELS, SUBCATEGORY_ORDER } from "../render/i18n";
import { V2EX_OFF_TOPIC_RE } from "../render/site-filters";
import {
  MERGE_PER_SOURCE_CAP,
  PRESERVE_FETCH_ORDER_SOURCES,
  SOURCE_DISPLAY_LIMITS,
  displayLimitFor,
  isSportsArticle,
  mergedLimitFor,
  takeFirstToday,
} from "./limits";

const GZ_NOISE_RE =
  /历史建筑|门前三包|禁燃|黑烟|柴油货车|限行|交通管制|禁停|环境保护|生态|绿化|消防|防汛|水务|河道|畜牧|兽医|文物|非遗|民政局|街道办|居委会|司法厅|决定书|注销|律师|执业|行政许可|招聘|竞投|摆卖|摊位|路灯|景观照明|电费补贴|排污|噪声|拆迁补偿|工伤|教师资格|招生|赛事|演出|博物馆|公园|厕所|殡葬|诊所备案|欠薪|养犬|渔港|见义勇为|储备土地|低保|入学|气瓶/;

/**
 * 上位法传导规则（「包含关系」，2026-08-19 用户要求）：finance（宏观政策）板块的
 * 全国/省级政策条目，若标题命中广州业务线关键词，渲染时镜像到 广州商机(gz) 板块的
 * 对应业务线子标签——国家/省级变动必然传导到广州分行辖区，广州板块必须能看到这条信号；
 * 宏观政策板块原样保留，广州商机板块额外传导一条（同一 URL 双板块展示）。
 *
 * 词表与 scripts/analyze-gz.ts 的 HEURISTIC_RULES 第 2-6 条（业务线）保持一致，
 * 避免「宏观里判信贷、商机里判无关」的口径分裂。
 */
const GZ_CONDUCTION_RULES: Array<{ sub: string; re: RegExp }> = [
  { sub: "gz-wealth", re: /理财|基金|保险|黄金|财富|资产配置|私人银行|代销|AUM|信托/ },
  { sub: "gz-credit", re: /信贷|贷款|房贷|消费贷|经营贷|按揭|公积金|利率|首付|融资担保/ },
  { sub: "gz-customer", re: /社零|消费|零售|居民|收入|人口|就业|物价|CPI|民生|储蓄|存款|支付|商圈|市场运行/ },
  { sub: "gz-private", re: /家族|股权|企业主|专精特新|半导体|集成电路|生物医药|高端制造|人工智能|芯片|知识产权|补贴|兑现|产业扶持|招商引资|独角兽/ },
];

/** 命中哪些广州业务线子标签（可多值：同一条上位政策可能影响多个业务线）。 */
export function conductToGzSubs(title: string): string[] {
  return Array.from(new Set(GZ_CONDUCTION_RULES.filter((r) => r.re.test(title)).map((r) => r.sub)));
}

/**
 * 全国业务线子标签（2026-08-21 用户：从宏观政策面板移入广州商机面板）：
 * finance 文章命中这些 subcategory 时改写 category=gz 进入广州商机面板的
 * 单一合并流（gz-all），由渲染层按权威等级拆「官方 / 媒体」tab。
 * 映射到业务线 id 仅为保留原业务线信息（渲染不再按业务线分桶）。
 */
const CN_BIZ_MAP: Record<string, string> = {
  "cn-wealth": "gz-wealth",
  "cn-credit": "gz-credit",
  "cn-private": "gz-private",
};

/**
 * 标签内主题去重词表（2026-08-19 用户要求）：同一子标签下「类似主题」最多展示
 * maxPerTheme 条，且若为 2 条，来源等级（tier）必须不同——避免同一政策/事件被
 * 多家媒体报道后堆满一个标签（如 gz-credit 出现 3+ 条公积金新政）。
 *
 * 主题键 = 标题命中的本词表词；两条目同主题 ⟺ 主题键交集非空。
 * 词表与 GZ_CONDUCTION_RULES（业务线传导）同源口径，仅粒度更细（具体业务词）。
 */
const GZ_THEME_TERMS: Record<string, string[]> = {
  "gz-wealth": ["理财", "基金", "保险", "黄金", "财富", "资产配置", "私人银行", "代销", "信托"],
  "gz-credit": ["公积金", "房贷", "消费贷", "经营贷", "按揭", "LPR", "利率", "首付", "融资担保", "信贷", "贷款"],
  "gz-customer": ["社零", "消费", "零售", "居民收入", "收入", "人口", "就业", "物价", "CPI", "民生", "储蓄", "存款", "支付", "商圈", "市场运行"],
  "gz-private": ["家族", "股权", "企业主", "专精特新", "半导体", "集成电路", "生物医药", "高端制造", "人工智能", "芯片", "知识产权", "产业扶持", "招商引资", "独角兽"],
};

/** 标题命中的主题词（按子标签词表；未命中返回空数组 = 不参与主题聚类）。 */
export function themeKeysOf(title: string, sub?: string): string[] {
  const words = sub ? GZ_THEME_TERMS[sub] : Object.values(GZ_THEME_TERMS).flat();
  if (!words || words.length === 0) return [];
  return Array.from(new Set(words.filter((w) => title.includes(w))));
}

/**
 * 标签内主题去重 + tier 去重：同主题簇（主题键交集非空）最多保留 maxPerTheme 条，
 * 且同一簇内同一 tier 只保留 1 条（用户规则：2 条必须是不同来源等级）。
 * 无主题词的条目不聚类（独立保留，不误删）。保持传入顺序（时间倒序 → 留最新）。
 */
export function capByThemeAndTier<T extends ArticleInput>(
  items: T[],
  maxPerTheme = 2,
  sub?: string,
): T[] {
  // 快路径仅对 1 条成立：2 条同主题也可能同 tier（不合规），必须走聚类检查。
  if (items.length <= 1) return items;
  const tierRank = (t?: SourceTier): number =>
    t === "T1" ? 3 : t === "T1.5" ? 2 : t === "T2" ? 1 : 0;
  const kept: T[] = [];
  for (const a of items) {
    const aKeys = themeKeysOf(a.title, sub);
    if (aKeys.length === 0) {
      kept.push(a);
      continue;
    }
    const cluster = kept.filter((k) =>
      themeKeysOf(k.title, sub).some((kw) => aKeys.includes(kw)),
    );
    if (cluster.length === 0) {
      kept.push(a);
      continue;
    }
    // 同簇：同一 tier 只留 1 条
    if (cluster.some((k) => k.tier === a.tier)) continue;
    // 簇未满 → 加入
    if (cluster.length < maxPerTheme) {
      kept.push(a);
      continue;
    }
    // 簇已满：tier 高的优先（T1 > T1.5 > T2），用更高 tier 的新条目替换簇内最低者
    // （避免时间优先把 T1 官方原文挤掉、只留 T2 媒体转载）。
    const lowest = cluster.reduce(
      (m, k) => (tierRank(k.tier) < tierRank(m.tier) ? k : m),
      cluster[0]!,
    );
    if (tierRank(a.tier) > tierRank(lowest.tier)) {
      kept.splice(kept.indexOf(lowest), 1, a);
    }
  }
  return kept;
}
function normalizeTitleForDedup(t: string): string {
  return (t ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenJaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Collapse same-story items inside a merged subgroup. The kept item (first
 * in list order) records the other sources in `alsoFrom` so the renderer can
 * show "多家来源：…". Thresholds are conservative to avoid merging distinct
 * stories that merely share keywords.
 */
function mergeSimilarStories(items: ArticleInput[]): ArticleInput[] {
  const groups: { rep: ArticleInput }[] = [];
  for (const a of items) {
    const norm = normalizeTitleForDedup(a.title);
    const tokens = norm.split(" ").filter(Boolean);
    const target = groups.find((g) => {
      const gNorm = normalizeTitleForDedup(g.rep.title);
      if (gNorm === norm) return true;
      if (tokens.length < 3) return false; // too short to risk a merge
      return tokenJaccard(tokens, gNorm.split(" ").filter(Boolean)) >= 0.75;
    });
    if (!target) {
      groups.push({ rep: a });
      continue;
    }
    if (a.source && a.source !== target.rep.source) {
      target.rep.alsoFrom = target.rep.alsoFrom ?? [];
      if (!target.rep.alsoFrom.includes(a.source)) target.rep.alsoFrom.push(a.source);
    }
  }
  return groups.map((g) => g.rep);
}
export function groupRaw(
  articles: ArticleInput[],
  registry: SourceDef[],
  /** 2.0 注入：配置全量源 id 集（含 disabled）与广东发行人注册表（gzinfo 内部读 fs，此处外移）。 */
  opts?: { knownSourceIds?: ReadonlySet<string>; gdIssuers?: GdIssuerRegistry },
): RawByCategory {
   const subcatOf = new Map<string, string | undefined>();
  for (const s of registry) subcatOf.set(s.id, s.subcategory);
  // Keep articles from *every* registered source id — including disabled ones
  // like gd-local-scraper. When scripts/render.ts re-renders against a stale
  // sidecar, that file still holds the disabled source's fetched data; we must
  // not silently drop it. (We deliberately do NOT filter by `enabled !== false`.)
  const knownSourceIds = opts?.knownSourceIds ?? new Set(registry.map((s) => s.id));
  // 源等级 tier 补齐（2026-08-19）：历史库条目（buildRolling 历史侧）不带 tier →
  // 标签内主题去重 capByThemeAndTier 会把不同权威性的来源（国务院 T1 / 央视 T1.5 /
  // 媒体 T2）误判为同 tier，只留 1 条且挤掉 T1 原文。此处按 registry 统一补齐，
  // 覆盖 daily/dry-run/render 所有入口（daily.ts 抓取路径已补，重复补无害）。
  const tierBySource = new Map<string, SourceTier | undefined>();
  for (const s of registry) tierBySource.set(s.id, s.tier);

  // console.log('[groupRaw] enabledIds 包含的 sourceId 列表:', Array.from(enabledIds));
  // console.log('[groupRaw] gd-local-scraper 是否在 enabledIds 中:', enabledIds.has('gd-local-scraper'));

  type Bucket = { sourceName: string; items: ArticleInput[] };
  const buckets: Record<Category, Map<string, Bucket>> = {
    tech: new Map(),
    finance: new Map(),
    politics: new Map(),
    'gd-ipo': new Map(),
    ipo: new Map(),
    gz: new Map(),
    stocks: new Map(),
  };

  // 广东地区IPO：文章级三道闸分类后，按 classifier 决定的子标签归桶
  // （一个源如巨潮可能同时含深/沪/京，不能再靠 sourceId 定 sub）。
  const gdSubs = new Map<string, Bucket>();
  // 全国IPO/新股：crawler 已按 region 分流好（非广东沪深 + 媒体源），
  // 直接按 registry 的 subcategory 归桶（sse/szse/ipo-media），不再过三道闸。
  const ipoSubs = new Map<string, Bucket>();
  // 广东公司但非IPO类（财报/分红/解禁等）→ 转财经要点「news」合并流
  const financeExtra: ArticleInput[] = [];
  const gdIssuers = opts?.gdIssuers;

  // console.log('[groupRaw] buckets keys:', Object.keys(buckets));
  // console.log('[groupRaw] buckets[gd-ipo] size:', buckets['gd-ipo']?.size);
  // Pre-seed empty buckets for every enabled source so per-source-tabbed
  // subcategories (e.g. cn-community) still render a tab for sources that
  // returned 0 items today. Without this, a transient LinuxDo Cloudflare
  // block would silently collapse the L3 tab nav, making users wonder
  // whether the other forum even exists.
  for (const s of registry) {
    if (s.enabled === false) continue;
    if (!buckets[s.category].has(s.id)) {
      buckets[s.category].set(s.id, { sourceName: s.name, items: [] });
    }
  }

  for (const a of articles) {
    if (!knownSourceIds.has(a.sourceId)) continue;
    // 历史条目补 tier（见上注释）：就地补齐，供主题去重与角标展示
    if (a.tier === undefined && tierBySource.has(a.sourceId)) {
      a.tier = tierBySource.get(a.sourceId);
    }
    // 条目级相关性过滤（2026-08-21 重构 #23）：AI/启发式判断「与银行业务无关」的
    // 条目不进任何面板——全板块生效（含 tech/ipo/politics）。重构后页面是
    // 「业务启示/科技前沿」等对分行有价值的精选流，demo 要求科技前沿只留与分行
    // 有真实连接点的内容（算力金融化/数据治理），故不再豁免参考区。
    if (a.relevant === false) continue;
    // 杂讯兜底（不依赖 LLM，2026-08-29 无状态源架构红线：不再以 category==="gz" 为前提，
    // 判定本身就是内容词表——城市治理/民生杂讯词命中即过滤，对所有采集分类统一生效）：
    // AI 未明确判相关(relevant!==true) 且标题命中电费补贴/招聘/摆卖/殡葬/诊所备案等 → 过滤。
    // 南沙/政府列表页会长期挂旧政策文件库存，LLM 分类偶有漏网（ai_relevant=null），
    // 此兜底保证垃圾内容绝不进商机面板。
    if (a.relevant !== true && GZ_NOISE_RE.test(a.title)) continue;
    if (a.category === "politics" && isSportsArticle(a.title)) continue;
    if (
      (a.sourceId === "v2ex-hot" || a.sourceId === "linuxdo") &&
      V2EX_OFF_TOPIC_RE.test(a.title)
    )
      continue;
    // 广东地区IPO：先过三道闸分类器，再决定归哪个子标签 / 是否转财经 / 丢弃
    if (a.category === "gd-ipo") {
      const res = classifyGdIpo(
        {
          title: a.title,
          excerpt: a.excerpt,
          url: a.url,
          sourceId: a.sourceId,
          source: a.source,
          publishedAt: a.publishedAt,
          stockCode: (a as ArticleInput & { stockCode?: string }).stockCode,
          registeredProvince: (a as ArticleInput & { registeredProvince?: string })
            .registeredProvince,
        },
        { gdIssuers },
      );
      if (res.action === "drop") continue;
      if (res.action === "finance") {
        financeExtra.push(a);
        continue;
      }
      // P4-② gdBasis 落库：把广东判定依据写回条目，便于审计与历史溯源
      if (res.basis) a.gdBasis = res.basis;
      // P4-① 结构化旁路：爬虫已给官方 ipoStage 时优先采用，否则回退关键词推断
      const stage: GdStage = isGdStage(a.ipoStage) ? a.ipoStage : inferStage(a.title, a.excerpt);
      let b = gdSubs.get(stage);
      if (!b) {
        b = { sourceName: SUBCATEGORY_LABELS[stage] ?? stage, items: [] };
        gdSubs.set(stage, b);
      }
      b.items.push(a);
      continue;
    }
    // 全国IPO/新股：按 sourceId → registry subcategory 归桶（sse/szse/bse 交易所权威源）
    if (a.category === "ipo") {
      // 2026-08-23：已上市公司资本运作公告（定增/审核问询/购买资产/解禁/回购等）
      // 不是「IPO 动态」，命中且非 IPO 流程词 → 转财经要点，避免污染 IPO 板块。
      const ipoText = `${a.title} ${a.excerpt || ""}`;
      if (IPO_CAPITAL_ACT_RE.test(ipoText) && !IPO_FLOW_RE.test(ipoText)) {
        financeExtra.push(a);
        continue;
      }
      const sub = subcatOf.get(a.sourceId) ?? "sse";
      let b = ipoSubs.get(sub);
      if (!b) {
        b = { sourceName: SUBCATEGORY_LABELS[sub] ?? sub, items: [] };
        ipoSubs.set(sub, b);
      }
      b.items.push(a);
      continue;
    }
    // —— 全国业务线子标签移入广州商机面板（2026-08-21 用户）——
    // 宏观政策(finance)不再承载 cn-wealth/cn-credit/cn-private：这类全国性业务线
    // 报道（理财/信贷/私行）并入广州商机(gz)面板的单一合并流（gz-all），
    // 由渲染层按权威等级拆「官方 / 媒体」tab。文章改写 category=gz 后继续。
    if (a.category === "finance") {
      const subsArr =
        a.subcategories && a.subcategories.length > 0
          ? a.subcategories
          : a.subcategory
            ? [a.subcategory]
            : [];
      const cnSub = subsArr.find((s) => CN_BIZ_MAP[s]);
      if (cnSub) {
        const gzMap = buckets["gz"];
        let gzb = gzMap.get(a.sourceId);
        if (!gzb) {
          gzb = { sourceName: a.source, items: [] };
          gzMap.set(a.sourceId, gzb);
        }
        gzb.items.push({
          ...a,
          category: "gz" as const,
          subcategory: CN_BIZ_MAP[cnSub],
          subcategories: [CN_BIZ_MAP[cnSub]],
        });
        continue;
      }
    }
    const map = buckets[a.category];
    let b = map.get(a.sourceId);
    if (!b) {
      b = { sourceName: a.source, items: [] };
      map.set(a.sourceId, b);
    }
    
    b.items.push(a);
    // console.log('[groupRaw] buckets[gd-ipo] size after filling:', buckets['gd-ipo']?.size);

    // —— 上位法传导（「包含关系」，2026-08-19）：finance（宏观政策）板块的全国/省级
    // 政策若影响广州业务线（标题命中传导词表），镜像到 广州商机(gz) 板块对应业务线
    // 子标签。宏观板块原样保留；a.relevant===false 的 finance 条目已在上面 continue
    // 过滤，此处仅剩相关/未判条目。镜像条目覆盖 category/subcategories 为 gz 维度。
    if (a.category === "finance") {
      const gzSubs = conductToGzSubs(a.title);
      if (gzSubs.length > 0) {
        const gzMap = buckets["gz"];
        let mb = gzMap.get(a.sourceId);
        if (!mb) {
          mb = { sourceName: a.source, items: [] };
          gzMap.set(a.sourceId, mb);
        }
        mb.items.push({
          ...a,
          category: "gz" as const,
          subcategory: gzSubs[0],
          subcategories: gzSubs,
        });
      }
    }
  }

  for (const cat of CATEGORY_ORDER) {
    for (const [id, b] of buckets[cat].entries()) {
      if (PRESERVE_FETCH_ORDER_SOURCES.has(id)) continue;
      b.items = sortByTierAndTime(b.items);
    }
  }

  // 广东公司但非IPO类（财报/分红/解禁等）→ 并入财经要点「国内财经」合并流
  if (financeExtra.length > 0) {
    const sid = "_gd_finance";
    subcatOf.set(sid, "cn-finance");
    const b =
      buckets["finance"].get(sid) ??
      ({ sourceName: "公司资本运作公告", items: [] } as Bucket);
    b.items.push(...financeExtra);
    buckets["finance"].set(sid, b);
  }

  // 按 SUBCATEGORY_ORDER 构建子标签，始终渲染全部二级标签（空则占位）。
  // gd-ipo 用三道闸分类结果 gdSubs；全国 ipo 用 subcatOf 归桶结果 ipoSubs。
  function buildOrderedSubs(subMap: Map<string, Bucket>, cat: Category): SubGroup[] {
    const order = SUBCATEGORY_ORDER[cat] ?? [];
    const subs: SubGroup[] = [];
    for (const subId of order) {
      const b = subMap.get(subId);
      if (!b || b.items.length === 0) {
        subs.push({
          id: subId,
          name: SUBCATEGORY_LABELS[subId] ?? subId,
          sources: [],
        });
        continue;
      }
      b.items = sortByTierAndTime(b.items);
      subs.push({
        id: subId,
        name: SUBCATEGORY_LABELS[subId] ?? subId,
        sources: [
          {
            sourceId: "_merged",
            sourceName: SUBCATEGORY_LABELS[subId] ?? subId,
            items: b.items,
            merged: true,
          },
        ],
      });
    }
    return subs;
  }

  function toSourceGroup(
    sourceId: string,
    b: Bucket,
    limit: number | undefined,
  ): SourceGroup {
    return {
      sourceId,
      sourceName: b.sourceName,
      items: limit ? takeFirstToday(b.items, limit) : b.items,
    };
  }

  function sortByRegistry(list: SourceGroup[]): SourceGroup[] {
    return [...list].sort((a, b) => {
      const ia = registry.findIndex((s) => s.id === a.sourceId);
      const ib = registry.findIndex((s) => s.id === b.sourceId);
      return ia - ib;
    });
  }

 const out: RawByCategory = {
  tech: [],
  finance: [],
  politics: [],
  'gd-ipo': [],
  ipo: [],
  gz: [],
  stocks: [],
  };
  
  for (const cat of CATEGORY_ORDER) {
    // 广东地区IPO / 全国IPO 已由各自分流逻辑（三道闸 / subcatOf）文章级分发，单独构建
    if (cat === "gd-ipo") {
      out["gd-ipo"] = buildOrderedSubs(gdSubs, "gd-ipo");
      continue;
    }
    if (cat === "ipo") {
      out["ipo"] = buildOrderedSubs(ipoSubs, "ipo");
      continue;
    }
    const order = SUBCATEGORY_ORDER[cat];
    if (!order) {
      // Flat: one synthetic subgroup with every source.
      const sources: SourceGroup[] = [];
      for (const [id, b] of buckets[cat].entries()) {
        sources.push(toSourceGroup(id, b, undefined));
      }
      out[cat] = sources.length
        ? [{ id: "all", name: CATEGORY_LABELS[cat], sources: sortByRegistry(sources) }]
        : [];
      continue;
    }
    // Subcategory split: bucket each source under its registered subcategory.
    const subs: SubGroup[] = [];
    for (const subId of order) {
      const mergeLimit = mergedLimitFor(cat, subId);
      if (mergeLimit !== undefined) {
        // Merge: flatten all sources under this subcategory into a single
        // time-sorted SourceGroup. Articles keep their `source` field so
        // the renderer can label them.
        const flat: ArticleInput[] = [];
        // Per-source cap: fixed for most merged subgroups; 国内财经 shares
        // its subcategory limit evenly across the enabled sources.
        let perCap = MERGE_PER_SOURCE_CAP[`${cat}:${subId}`];
        if (perCap === undefined && subId === "cn-finance") {
          const n = registry.filter(
            (s) =>
              s.category === cat &&
              s.subcategory === subId &&
              s.enabled !== false,
          ).length;
          if (n > 0) perCap = Math.ceil((mergeLimit ?? 20) / n);
        }
        for (const [id, b] of buckets[cat].entries()) {
          // 条目级 subcategory 优先（AI/启发式分类），注册表源级兜底
          const matched = b.items.filter(
            (a) => {
            const subs =
              a.subcategories && a.subcategories.length > 0
                ? a.subcategories
                : a.subcategory
                  ? [a.subcategory]
                  : [];
            // 广州商机面板为单一合并流（gz-all）：收该桶全部文章（含 cn-* 移入与上位法镜像）。
            // 其余子标签：条目级 subcategory 优先（AI/启发式分类），注册表源级兜底；
            // gz 板块标题词表补判（上位法传导，防御老数据）见非 merge 分支注释。
            if (cat === "gz" && subId === "gz-all") return true;
            return subs.length > 0
              ? subs.includes(subId) ||
                  (cat === "gz" && conductToGzSubs(a.title).includes(subId))
              : subcatOf.get(id) === subId;
          },
          );
          if (matched.length) {
            flat.push(...(perCap ? takeFirstToday(matched, perCap) : matched));
          }
        }
        if (flat.length === 0) {
          if (cat === "finance") {
            subs.push({
              id: subId,
              name: SUBCATEGORY_LABELS[subId] ?? subId,
              sources: [],
            });
          }
          continue;
        }
        const flatSorted = sortByTierAndTime(flat);
        const top = takeFirstToday(flatSorted, mergeLimit);
        if (top.length === 0) continue;
        // Cross-source story dedup: several sources may cover the same story.
        // Collapse near-identical titles into one item and record the other
        // sources on `alsoFrom` (cheap local heuristic — zero LLM calls).
        const deduped = mergeSimilarStories(top);
        subs.push({
          id: subId,
          name: SUBCATEGORY_LABELS[subId] ?? subId,
          sources: [
            {
              sourceId: "_merged",
              sourceName: SUBCATEGORY_LABELS[subId] ?? subId,
              items: deduped,
              merged: true,
            },
          ],
        });
        continue;
      }

      const limit = displayLimitFor(cat, subId);
      // 1) 子标签级聚合（跨源）：收集所有命中该子标签的条目（含 gz 板块传导补判）
      const perSourceMap = new Map<string, { sourceName: string; items: ArticleInput[] }>();
      for (const [id, b] of buckets[cat].entries()) {
        // 条目级 subcategory 优先（AI/启发式分类），注册表源级兜底
        const items = b.items.filter(
          (a) => {
            const subs =
              a.subcategories && a.subcategories.length > 0
                ? a.subcategories
                : a.subcategory
                  ? [a.subcategory]
                  : [];
            // 广州商机面板为单一合并流（gz-all）：收该桶全部文章。
            // 其余子标签：条目级 subcategory 优先，注册表源级兜底；gz 板块补判
            // （上位法传导，防御老数据）：条目带的是非 gz 标签（cn-*，全国性政策/财经，
            // 历史库老条目 category=gz 的错标）→ 按业务线词表补判归属，不因标签不匹配被吞掉。
            if (cat === "gz" && subId === "gz-all") return true;
            return subs.length > 0
              ? subs.includes(subId) ||
                  (cat === "gz" && conductToGzSubs(a.title).includes(subId))
              : subcatOf.get(id) === subId;
          },
        );
        if (items.length) perSourceMap.set(id, { sourceName: b.sourceName, items });
      }
      // 2) 标签内主题去重（跨源，2026-08-19 用户要求）：同主题 ≤2 条、2 条必须 tier 不同。
      //    在子标签层面对所有源的条目统一裁剪（央视/国务院/媒体同报一个政策只留 ≤2 条）。
      //    排序用 tier 权威等级 + 时间（2026-08-21 用户要求，只有日期的沉底）。
      const all = sortByTierAndTime(
        [...perSourceMap.values()].flatMap((g) => g.items),
      );
      const keepUrls = new Set(capByThemeAndTier(all, 2).map((a) => a.url));
      // 3) 合并输出（2026-08-21 用户要求：渲染只到子标签，去掉 L3 信息源 tabs）：
      //    保留被裁剪后的条目为单一时间流（merged），来源降级为卡片上的来源小字。
      const kept = all.filter((a) => keepUrls.has(a.url));
      // 财经要点 / 广州商机 的二级标签始终渲染，即使当天为空也保留
      // 标签 + “暂无内容”占位，保证结构稳定可见（不折叠成单子标签）。
      // （gd-ipo/ipo 已在循环开头 continue 单独构建，此处不可达，不重复判断）
      if (kept.length === 0) {
        if (cat === 'finance' || cat === 'gz') {
          subs.push({ id: subId, name: SUBCATEGORY_LABELS[subId] ?? subId, sources: [] });
          continue;
        }
        continue;
      }
      subs.push({
        id: subId,
        name: SUBCATEGORY_LABELS[subId] ?? subId,
        sources: [
          {
            sourceId: "_merged",
            sourceName: SUBCATEGORY_LABELS[subId] ?? subId,
            items: kept,
            merged: true,
          },
        ],
      });
    }
    out[cat] = subs;
  }
  // Safety net: if gd-ipo has data but the subcategory split above produced
  // an empty panel (e.g. a future source whose subcategory isn't in
  // SUBCATEGORY_ORDER), force a flat render so the data is never lost.
  if (buckets['gd-ipo'] && buckets['gd-ipo'].size > 0 && (out['gd-ipo'] || []).length === 0) {
    const flatSources: SourceGroup[] = [];
    for (const [id, b] of buckets['gd-ipo'].entries()) {
      flatSources.push(toSourceGroup(id, b, undefined));
    }
    if (flatSources.length > 0) {
      out['gd-ipo'] = [{
        id: 'all',
        name: CATEGORY_LABELS['gd-ipo'],
        sources: sortByRegistry(flatSources),
      }];
    }
  }
  return out;
}

// ----- report-item card renderer（新管线 schema: ReportItem）-----

/**
 * 板块卡渲染。
 *
 * @param stage 可选：**仅广东IPO 面板传入**其阶段值（经 gdIpoStageOf 判定）。传入时启用
 *   IPO 专属呈现——`data-stage`（供阶段筛选条过滤）、结构化副信息 `ipoMeta`
 *   （保荐/拟板块/受理日，避免被 50 字通用截断吞掉）、相对时距、交易所官方源双链接。
 * @param progressHtml 可选：同企业阶段进展条（P2-6），仅 IPO 面板对该企业最新一条传入。
 */
/** 筛选维度定义：供「板块内筛选条」复用。 */

/**
 * 广东 IPO 阶段展示顺序 —— 与 `BIZ_VALUE_RANK`（商机价值优先）**同序**：
 * 辅导备案（Pre-IPO，最佳商机）→ 辅导完成（临近申报）→ 注册发行（募资在即）→ 在审 → 已上市（已兑现）。
 * 刻意与顶部横滑卡保持同一顺序，避免同一份数据在页面里出现两种读法。
 *
 * 2026-09-14（P0-3）：本文件此前的私有副本已删除，改由 `services/classify/gd-ipo.ts` 导入。
 */

