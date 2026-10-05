/**
 * 分行相关性评分层（branch-relevance score）
 * ============================================================================
 * 设计目标：让「以本行（广州）为客户」成为结构化的硬约束，
 * 而不是只靠 LLM 临场发挥（现状：select-top.ts 直接「保持 AI 给的原始顺序」，
 * 客户相关性排序 100% 委托给模型，无评分/无测试/无兜底）。
 *
 * 特征：
 *  - 纯函数、确定性、可单测；
 *  - 可解释：每条结果带 signals[]，说明加分/判级来源（调试与可信度）；
 *  - 不依赖 LLM 标签（tags / importance）—— 仅从原始字段
 *    (title / category / subcategory / sourceId / summary) 计算，
 *    因此在 SKIP_AI（无 AI 富化）下也能独立工作，
 *    可作为 must_read / insights 排序的「护栏 + 喂料」。
 *
 * 业务线词表对齐 prompts.ts:35 与 select-top.ts:19（行长5分钟核心 = 财富/私行/客群/信贷）。
 *
 * 接入说明：本模块是「评分器」，不修改任何管线文件。要把分数真正喂进
 * 必读排序，需要改动 lib/ai/exec-pool.ts / pipeline.ts 等（属用户红线保护的 7 文件，
 * 需用户另行授权）。本层可先作为回归护栏 + 人工抽检工具使用。
 */

// Tier/Vertical 类型词汇表归契约层（与 ValueTag 同源，gzinfo 定义于 relevance-score 本地）
import type { RelevanceTier as Tier, RelevanceVertical as Vertical } from "../../../contracts/report";
export type { Tier, Vertical };

export interface BranchRelevance {
  /** 0-100 综合相关性分（越高越该给分行看） */
  score: number;
  /** 优先级档位 */
  tier: Tier;
  /** 落位建议：risk = 威胁/合规向（进风险卡），其余同 tier */
  vertical: Vertical;
  /** 命中的业务线（按权重降序，取前 3） */
  businessLines: string[];
  /** 发布/发文方权威度 0-1 */
  authority: number;
  /** 可行动性 0-1（政策/风险行动 > 数据解读 > 软资讯） */
  actionability: number;
  /** 地域贴近度 0-1（广州/南沙 > 广东 > 全国/国际） */
  locality: number;
  /** 是否风险/合规向 */
  risk: boolean;
  /** 外埠区域性银行（他省城商行/农商行）→ 仅「参考」意义，不进必读（2026-08-29 用户） */
  foreignRegional?: boolean;
  /** 可解释性：每条加分 / 判级来源 */
  signals: string[];
  /** 若硬规则触发，记录原因（否则 undefined） */
  override?: string;
}

export interface ScorableArticle {
  title: string;
  category?: string;
  subcategory?: string;
  sourceId?: string;
  summary?: string;
  url?: string;
  tags?: string[];
  locale?: string;
  /**
   * 发布时间；时效衰减用，缺省则不衰减。
   * 两种形态都收：`ArticleInput` 用 `Date`、`ReportItem` 用 ISO 串。
   */
  publishedAt?: string | Date;
}

/** 评分可选项（注入式，服务层不得自己取时间 —— 红线 R1/R5） */
export interface ScoreOptions {
  /** 「现在」由组合根注入（如 FilterContext.startTime()）。不传 = 不做时效衰减。 */
  now?: Date;
}

// ---------------------------------------------------------------------------
// 1) 业务线词表（权重 = 对分行的核心程度；行长5分钟核心线权重最高）
// ---------------------------------------------------------------------------
interface LineRule {
  line: string;
  weight: number;
  kws: string[];
}

const BUSINESS_LINES: LineRule[] = [
  // 信贷 = 房贷 / 消费贷 / 小微贷 三类（2026-08-29 用户拍板：住房金融属信贷子集，不再单列一条线）
  //
  // 「普惠」去裸词（2026-10-04 sc 选 A）：原表用裸词「普惠」，被**市政语境**误配 ——
  //   「将24小时面向全社会**普惠**开放，广州琶洲南 CBD 高空立体公共客厅项目获批」
  //   → 命中信贷线 1.0 + 广州本地 = **76 insight**，在 exec 池里**排第 2**（实测 10-04）。
  //   而该条是城市规划/市政项目，与分行零售业务无直接关系。
  // 对照探针：「普惠小微贷款新政落地」命中 ✓、「**面向全社会普惠开放**」应不再命中 ✗。
  // 真实普惠金融新闻不会因此漏判 —— 它们同时命中「小微贷 / 小微金融 / 经营贷 / 贷款」。
  { line: "信贷", weight: 1.0, kws: ["房贷", "按揭", "抵押贷", "个贷", "住房金融", "房地产信贷", "楼市", "购房", "房抵", "存量房贷", "信托", "房地产", "地产", "消费贷", "小微贷", "小微金融", "小微", "普惠金融", "普惠贷款", "普惠小微", "普惠信贷", "经营贷", "信贷", "贷款", "授信", "放贷", "利率", "降息", "降准", "LPR"] },
  { line: "客群", weight: 0.9, kws: ["客群", "零售", "获客", "新客", "拓客", "拉新", "开户", "客户增长", "客户数", "客户经营", "客群经营", "零售转型", "收单", "收单商户", "商户拓展", "社零", "居民消费", "消费回暖", "居民收入", "人口", "就业", "薪资", "工资", "县域", "下沉"] },
  // 财富（2026-10-03 sc 追加）：原词表只收**申购侧**（新股/IPO/打新/申购/发行价/招股/路演），
  // 不收**二级市场**词 → 一条纯 A 股情绪稿业务线权重为 0，综合分仅 **21（drop 档）**，
  // 与「港股」类内容（走跨境线 1.0 → 66 分）差了整整两个档位（sc 实测：「A股节后上涨胜率超60%」
  // vs 同内容改写为「港股」= 66）。sc 口径：**A 股与港股应属同一水平**。
  // ⚠️ 刻意**不收**「股票」「券商」两个更宽泛的词（195 条真实标题实测的假阳性）：
  //    「韩国天价离婚！顶级大佬**卖股票**，筹集47亿分手费」（娱乐八卦）
  //    「固态电池迎重大利好！**券商**力推设备端」（卖方研报观点）
  //    二者都会被抬进 insight 档、挤占商机候选 —— 属红线 R7（业务相关性）要防的噪声。
  // 贵金属词族（2026-10-04 sc：「补充金价」）：原表只有「黄金」「贵金属」，
  // ⛔ **漏了「金价」** → 实测**同一件事两个分数**：
  //   「黄金XAUUSD，白银XAGUSD - 周末分析」  59 insight [财富]（含「黄金」）
  //   「金价银价"巨震"，深圳水贝商家已断货」 21 **drop** [-]（「金价」不含「黄金」）
  //   而后者正是 10-04 定调「贵金属异动，资金搬家」的来源之一 —— 素材在定调里有、
  //   在分值排序里却被整条排掉。**同「A股 vs 港股」的教训：换个说法就差两个档位。**
  // ⚠️ 刻意不收裸词「金银」（「金银花」会误配 —— 实测探针已锁定）。
  // S1 补词（2026-10-06 sc 授权）：**存单 / ETF / 私募**
  // 背景（10-05 独立评估实测）：当天 5 张最具业务价值的卡**业务线权重为 0 → 一律 25 分 context**，
  //   而它们恰恰是 importance 最高的几张卡。根因是词表只收「存款」不收「存单」等**同族异说**
  //   —— 与已修的「金价 vs 黄金」「A股 vs 港股」是**同一类病**。
  // 配对探针（全池 465 条真标题，2026-10-06 实测，逐条人工判误配）：
  //   「存单」2 条 —— ①多家银行重启5年期大额存单（目标 ✓）
  //     ②男子存1万定期…丢失**存单**挂失…起诉银行（存款纠纷；标题已含「存款」，本就命中财富线 → **无新增误配**）
  //   「ETF」3 条 —— ①占比超八成！个人投资者大举涌入新上市ETF（目标 ✓）
  //     ②「ETF #股票#财经 #投资 #基金 #ETF」标签稿（已含「基金」，无新增影响）③英文稿 two ETFs（漏斗外）
  //   「私募」5 条 —— ①62家百亿私募集体调研（目标 ✓）②百亿私募增至159家 ③中基协私募月报（规模25.75万亿）
  //     ④券商搭台、私募出壳…涉千万雪球违规（原已命中监管合规 0.85 → 加词后 0.9，仅 +2 分，可接受）
  //     ⑤私募基金规模达23.66万亿（✓）
  // ⛔ 刻意**不收 0 召回的词**：etf(小写 0)、被动投资(0)、指数基金(0)、反催收(0)、盗用支付(0)
  //    —— 零召回只增加词表面积与未来误配风险，不带来收益。
  // ⛔ 「大额存单」「百亿私募」为**子串冗余**（已由「存单」「私募」覆盖），不重复列举。
  { line: "财富", weight: 0.9, kws: ["财富", "理财", "基金", "保险", "黄金", "存款", "资管", "AUM", "贵金属", "债基", "新股", "IPO", "打新", "申购", "发行价", "招股", "路演", "上市申购", "A股", "Ａ股", "股市", "大盘", "两市", "股指", "上证", "深证", "创业板", "科创板", "开门红", "持股", "股民", "金价", "银价", "金饰", "存单", "ETF", "私募"] },
  { line: "私行", weight: 0.9, kws: ["私行", "家族", "高净值", "企业主", "家族信托", "家族办公室"] },
  // S1 补词（2026-10-06）：**盗刷 / 刷走**
  // 原表只有「刷卡」→「随手连公共Wi-Fi误点弹窗，银行卡被**刷走**850元！紧急提醒」
  //   （防盗刷提醒，对零售客群有直接执行关联）业务线权重 0 → **25 分 drop**。
  // 探针：盗刷 1 条（万事达卡批量境外**盗刷**调查 ✓）、刷走 1 条（即目标 ✓），**零误配**。
  { line: "信用卡", weight: 0.7, kws: ["信用卡", "借记卡", "刷卡", "盗刷", "刷走"] },
  { line: "代发", weight: 0.7, kws: ["代发", "代发工资", "工资代发"] },
  { line: "养老", weight: 0.6, kws: ["养老", "养老金融", "个人养老金"] },
  // S1 补词（2026-10-06）：**代理维权**
  // 原表「催收」不含「代理维权」→「抽取50%提成、恶意索赔遭整肃 金融领域"代理维权"打击持续」
  //   业务线权重 0 → **25 分 drop**，而它是对公/零售双线都直接相关的合规整肃信号。
  // 探针：命中 1 条（即目标条），**零误配**。⛔ 不收裸词「维权」（非金融维权威权会误配）。
  { line: "监管合规", weight: 0.85, kws: ["罚", "处罚", "违规", "整改", "通报", "不良", "逾期", "催收", "风险敞口", "压降", "踩雷", "爆雷", "代理维权"] },
  { line: "竞对动态", weight: 0.7, kws: ["竞对", "他行", "工行", "建行", "中行", "农行", "邮储", "兴业", "平安银行", "中信", "民生", "光大", "华夏", "浦发", "国有大行", "股份行"] },
  { line: "政银合作", weight: 0.6, kws: ["政银", "政务", "银政", "财政补贴"] },
  { line: "科技金融", weight: 0.6, kws: ["科技金融", "数字人民币", "金融科技", "数字银行"] },
  // 跨境（2026-10-03 sc）：广州分行身处**粤港澳大湾区**，港股与中国香港、中国澳门的资讯
  // 对它格外重要 —— 与信贷同级（1.0），不按"泛国际"对待。
  // 原状：权重 0.5（最低档之一）且关键词只有「跨境/外汇/结售汇/出海/离岸」，
  //       **不含港股、港交所、沪深港通、澳门** → 「港股重挫扰动持仓客户」业务线权重 0，
  //       综合分仅 **19（drop 档）**，在「按分值取」的定调里被整条排掉（实测 10-03）。
  // 现状：0.5 → 0.85 → **1.0**（sc 追加：「港澳和跨境的分值要提高一点」，且**不设保底位**，
  //       靠分值自然进入）→ 港股类内容 19 分 → 约 70 分，可进定调。
  //
  // 国际货币政策 / 汇率（2026-10-04 sc：「给美联储/美元/美债/汇率配上业务线指标」）：
  // 这四类此前**一条业务线都不命中** → 纯国际宏观稿全部落在 drop/context，实测：
  //   「美联储官员集体警示通胀依旧过高」21 **drop** · 「美元指数走弱人民币汇率升破7.1」21 **drop**
  //   ·「美国财政部回购 60 亿美元较长期国债」34 context
  // 而 LLM（PASS1）一直在把这些内容 keep 进展板（10-04 线上「政策与市场」栏
  // 有「欧洲经济冲击」「美联储鹰派软化」，评分器却判它们 drop）→ **两条尺子口径打架**。
  // sc 判断：这类内容对身处大湾区的广州分行**有价值**（汇率/涉外资产/客户预期），
  // 应并入「跨境」线（1.0 档，与信贷同级）—— 逻辑：**国际货币政策与汇率是跨境业务的输入端**。
  // ⚠️ 只收**特异的国际金融词**；⛔ 不收「国债」「债市」（属国内债市，语义不同）、
  //   不收「加息/降息」（已在信贷线，且国内语境下为存款利率，避免重复计分）。
  // 注：「美元指数」由「美元」覆盖、「人民币汇率」由「汇率」覆盖、「外汇储备」由「外汇」覆盖，
  //   故不重复列举（关键词为**子串匹配**）。
  // ⚠️ 已知副作用（实测样本 2/205）：关键词为 `text.includes` 子串匹配，故「美元」也会命中
  //   **金额描述**（「估值剑指2万亿**美元**」「拟将80亿**美元**英伟达芯片剥离」）→
  //   含大额美元金额的**国际商业新闻**会随之提档。实测这 2 条本身具有国际资本市场属性
  //   （跨境/涉外资产相关），可接受；如需收紧可改为「美元指数 / 美元走强 / 美元走弱」等精确词。
  { line: "跨境", weight: 1.0, kws: ["跨境", "外汇", "结售汇", "出海", "离岸", "港股", "港股通", "沪深港通", "恒生", "港交所", "港元", "H股", "澳门", "澳门元", "横琴", "粤港澳", "跨境理财通", "QDII", "QFII", "美联储", "美元", "美债", "汇率", "非农", "欧央行", "日央行"] },
];

/** 行长5分钟核心线（select-top.ts:19 DEPT_TAGS；2026-08-29 起住房金融并入信贷） */
const CORE_LINES = ["信贷", "客群", "财富", "私行"];

/**
 * 外埠区域性银行（他省城商行 / 农商行）：对广州分行只有「参考」意义，没有「借鉴」意义。
 * 2026-08-29 用户：客户是广州的股份行领导，其他区域的银行（如江苏银行）不具本地执行关联，
 * 不该与广州本地或全国性银行的信号同分、更不该占必读名额。
 * 注：国有大行与全国性股份行（工建中农交邮储、中信兴业浦发民生光大平安华夏广发浙商等）
 * 在广州同城竞争，属全国性信号，不降权。
 */
const FOREIGN_REGIONAL_BANK_RE =
  /江苏银行|宁波银行|南京银行|杭州银行|北京银行|上海银行|成都银行|长沙银行|青岛银行|重庆银行|郑州银行|西安银行|苏州银行|齐鲁银行|兰州银行|厦门银行|贵阳银行|江西银行|九江银行|中原银行|河北银行|徽商银行|盛京银行|大连银行|哈尔滨银行|天津银行|威海银行|日照银行|潍坊银行|烟台银行|东营银行|济宁银行|德州银行|枣庄银行|莱商银行|临商银行|湖北银行|汉口银行|无锡银行|常熟银行|张家港行|江阴银行|苏农银行|紫金银行|渝农商行|沪农商行|青农商行|瑞丰银行/;

// ---------------------------------------------------------------------------
// 权威度：谁发布的（央行/金监总局/国务院 > 省市政府 > 协会/银行 > 媒体 > 未知）
// ---------------------------------------------------------------------------
// 🔴 「美联储」已于 2026-10-03 从 TOP_ISSUER 移出（sc 口径：**美联储按媒体级处理，与港股类内容同级**）。
//    原状：把它与央行/金监总局/国务院并列 0.95 → 「沃什淡化利率前瞻性指引…」拿到 **79 分**、全库第一
//    （45 业务线[利率撞信贷] + 23.75 权威 + 10 可行动）。移出后该条权威度回落媒体档 0.42 → **66 分**，
//    与「港股」类内容同一水平。
//    ⚠️ 连带影响：美联储类内容**不再触发** `issuerTop` 的两条加成 ——
//    ① 可行动性不再因「国家核心发文方」上浮到 0.8；② 不再参与硬规则A（必读置顶）。
//    这二者与「降为媒体级」是同一件事的三面，属预期结果。
const TOP_ISSUER_RE =
  /央行|人民银行|国家金融监督管理总局|金融监管总局|金监总局|国务院|财政部|发改委|国资委|住建部|证监会|外汇局/;
const HIGH_ISSUER_RE = /省(政府|委|厅|金融监管局)|市(政府|委)|银保监|金融监管局/;
const ORG_ISSUER_RE = /协会|总行|银行业/;

function issuerScore(text: string): number {
  if (TOP_ISSUER_RE.test(text)) return 0.95;
  if (HIGH_ISSUER_RE.test(text)) return 0.8;
  if (ORG_ISSUER_RE.test(text)) return 0.6;
  return 0;
}

/** 源 id → 权威度（媒体只是转述，权威度低于发文方） */
const SOURCE_AUTHORITY: Record<string, number> = {
  "govcn-policy": 0.95,
  govcn: 0.95,
  pbc: 0.95,
  cnfin: 0.6,
  stcn: 0.6,
  "21jingji-finance": 0.55,
  "sina-finance": 0.5,
  "sina-bank": 0.5,
  guancha: 0.5,
  "eastmoney-a": 0.5,
  "eastmoney-hk": 0.5,
};

function sourceScore(sourceId?: string, subcategory?: string): number {
  let s = SOURCE_AUTHORITY[sourceId ?? ""] ?? 0.42;
  if (subcategory === "cn-policy" || subcategory === "govcn-policy") s = Math.max(s, 0.9);
  if (subcategory === "cn-finance") s = Math.max(s, 0.6);
  return s;
}

// ---------------------------------------------------------------------------
// 3) 可行动性：这条能不能让分行「做点什么」
// ---------------------------------------------------------------------------
// ⛔ 「重组」已移出（2026-10-06 sc 授权 S2）：它是**企业动作**，不是政策动作，
//    留在表里会让任何含「重组」的企业稿戴上政策光环（可行动性 0.9，与央行发文同级）。
//    实测 10-05：全池 465 条里含「重组」的仅 1 条 ——
//      「港股异动 | 百威亚太(01876)跌超2% 内部重组及计提拨备将影响三季度利润」
//      原分 **74 must_read**（含「港股」→ 跨境线 1.0 + policy_action 0.9）；
//      移出后可行动性落到 default 0.5 → **66 insight**，与同类港股快讯同档。
//    影响面极小（1/465），但修的是**系统性倾向**：企业动作 ≠ 政策动作。
//    ⚠️ 真·政策语境的重组（如监管发文要求重组）会由「发文/通知/办法」等词接管，不受影响。
const POLICY_ACTION_RE =
  /新规|发文|意见|办法|通知|印发|出台|发布|延长|下调|上调|降息|降准|贴息|宽松|收紧|扩容|提额|试点|调整|落地|实施|监管/;
const RISK_ACTION_RE = /罚|处罚|违规|整改|通报|不良|逾期|违约|风险敞口/;
const DATA_CONTEXT_RE = /数据|统计|同比|环比|回落|增长|下跌|大涨|大跌|震荡|分析|解读|回顾|展望|波动/;
// 软资讯：获奖/榜单/出口 之外，重点是**银行自家营销活动与 PR 通告**
// （2026-08-29 用户：「工银财富季」这类活动启动通告对广州分行无执行关联，不配进必读）。
// 这类标题不含可执行的政策/市场信号，可行动性压到最低档，避免挤占条线名额。
const SOFT_RE =
  /获奖|榜单|排名|论坛|峰会|出口|签约|发布产品|活动正式启动|活动启动|启动仪式|开业|庆典|公益|赞助|冠名|招募|报名|年会|发布会|购物节|品牌日|财富季|营销|宣传周|直播|启幕|来袭/;

function actionabilityScore(text: string): { score: number; type: string } {
  if (POLICY_ACTION_RE.test(text)) return { score: 0.9, type: "policy_action" };
  if (RISK_ACTION_RE.test(text)) return { score: 0.85, type: "risk_action" };
  if (DATA_CONTEXT_RE.test(text)) return { score: 0.4, type: "data_context" };
  if (SOFT_RE.test(text)) return { score: 0.2, type: "soft" };
  return { score: 0.5, type: "default" };
}

// ---------------------------------------------------------------------------
// 4) 地域贴近度：广州/南沙 > 广东/大湾区 > 全国/国际
// ---------------------------------------------------------------------------
const GZ_RE = /广州|穗|天河|海珠|琶洲|南沙|番禺|越秀|黄埔|花都|增城|从化|白云/;
// 粤港澳大湾区在口径上包含中国香港与中国澳门，故港澳与省内同级（2026-10-03 sc：
// 广州分行在大湾区，港股与港澳资讯对它重要 —— 原正则不含港澳，这类内容地域分恒为 0）。
const GD_RE = /广东|大湾区|珠三角|香港|澳门|港澳|横琴/;

function localityScore(text: string, locale?: string): number {
  if (GZ_RE.test(text)) return 1.0;
  if (GD_RE.test(text)) return 0.9;
  if (locale === "gz") return 0.9;
  return 0;
}

/**
 * RSS **栏目标识**（2026-10-04 sc 选「局部剥离」）：形如 `【21财经·粤港澳】`、`【21财经·金融】`。
 *
 * ⛔ **只匹配含「·」的形式** —— 这是「媒体·频道」写法的特征；
 * 纯文字的 `【新华社】` 是**通讯社署名**，`TOP_ISSUER_RE` 靠它判权威度（0.95），
 * 一旦剥掉会让权威媒体稿降级为普通媒体档。
 */
const CHANNEL_TAG_RE = /【[^】]{0,12}·[^】]{0,12}】[ \t]*/g;

// ---------------------------------------------------------------------------
// 5) 时效衰减（2026-10-06 sc 授权 S3）
// ---------------------------------------------------------------------------
/**
 * 问题（10-05 独立评估实测）：评分器**完全没有时效项**，导致
 *   ρ(发布时间, 分数) = **−0.38** —— 越新鲜反而越低分。
 *   09-29 的央行降息 PSL 稿拿全池最高 **87**，2024 年的旧稿 74，
 *   而当天真新闻因不含关键词只有 21 分。分数因此**同时服务不了两个场景**：
 *   滚动库存（要长期可比）与当日排序（要新鲜优先）。
 *
 * 设计：**单调衰减 + 注入 now**。now 由组合根注入（服务层禁 `Date.now()` / 裸 `new Date()`，红线 R1/R5）。
 *   age ≤ 1 天 ×1.00 · ≤ 2 天 ×0.90 · 3 天及以上 ×0.80
 *
 * ⚠️ **只在传入 now 时生效**：不传 = 不衰减，保持纯函数与既有调用点行为逐字不变
 *    （`exec-guard` / `importance` / `exec-pool` 等调用点拿不到注入时间，保持原样）。
 * ⚠️ **IPO 状态稿豁免**：IPO 是「受理/辅导/过会/递表」的**状态**而非新闻，本身就有
 *    独立窗口（IPO_VOICE_WINDOW_DAYS=2 / exec 池 7 天）；对它做衰减会把「刚披露的
 *    辅导备案」与「上周的老状态」人为拉开，不符合状态类内容的语义。
 * ⚠️ 硬规则 A/B 的 override 用 `Math.max(score, 84)`，因此**不受时效衰减影响** ——
 *    这是刻意取舍（国家核心监管政策置顶优先于新鲜度），如需让旧政策稿也让位需另行授权。
 */
const AGE_TIERS: { maxDays: number; factor: number }[] = [
  { maxDays: 1, factor: 1.0 },
  { maxDays: 2, factor: 0.9 },
  { maxDays: Number.POSITIVE_INFINITY, factor: 0.8 },
];

/** IPO 状态稿判定（category 取值见 contracts/article.ts；subcategory 见 sources.config） */
function isIpoStateDoc(a: ScorableArticle): boolean {
  return (
    a.category === "ipo" ||
    a.category === "gd-ipo" ||
    /^(ipo-|gz-ipo|stage-listed)/.test(a.subcategory ?? "")
  );
}

export function timelinessFactor(
  article: ScorableArticle,
  now?: Date,
): { factor: number; ageDays?: number; exempt?: boolean } {
  if (!now || !article.publishedAt) return { factor: 1 };
  if (isIpoStateDoc(article)) return { factor: 1, exempt: true };
  const t =
    typeof article.publishedAt === "string"
      ? Date.parse(article.publishedAt)
      : article.publishedAt.getTime();
  if (Number.isNaN(t)) return { factor: 1 };
  const ageDays = (now.getTime() - t) / 86_400_000;
  // 未来时间戳（源站时区错乱）：不衰减也不抬升，避免反向激励
  if (ageDays < 0) return { factor: 1, ageDays };
  for (const tier of AGE_TIERS) {
    if (ageDays <= tier.maxDays) return { factor: tier.factor, ageDays };
  }
  return { factor: 0.8, ageDays };
}

// ---------------------------------------------------------------------------
// 主函数
// ---------------------------------------------------------------------------
export function scoreBranchRelevance(
  article: ScorableArticle,
  opts?: ScoreOptions,
): BranchRelevance {
  const text = [article.title, article.summary ?? "", article.subcategory ?? ""].join(" ");
  // 业务线匹配专用文本：**剥掉 RSS 栏目标识**（2026-10-04 sc 选「局部剥离」）。
  //
  // 为什么：RSS 摘要常以频道名开头，如「【21财经·粤港澳】将24小时面向全社会普惠开放，
  // 广州琶洲南 CBD…」，其中「粤港澳」会被**跨境线**（权重 1.0）命中 → 一条**市政项目**
  // 得 76 insight，在 exec 池里排第 2（实测 10-04）。已修的「普惠」裸词是同一分量的
  // 另一个误配来源 —— 两者效果完全等同（业务线权重都是 1.0，分数都是 76）。
  //
  // ⛔ **只剥「含『·』」的 `【X·Y】`**：RSS 频道名几乎都是「媒体·频道」写法；
  // 而**纯文字的 `【新华社】`是通讯社署名**，`issuerScore` 靠它判权威度（0.95），
  // 剥掉会让权威媒体稿降级 —— 所以 `text`（权威/可行动性用）**保持原文**，
  // 只有业务线匹配走剥离版。实测 205 条里含 `【…·…】` 的仅 6 条，影响面可控。
  const lineMatchText = [
    article.title,
    (article.summary ?? "").replace(CHANNEL_TAG_RE, " "),
    article.subcategory ?? "",
  ].join(" ");
  // 地域判定**只看标题与子分类**，绝不含 summary：
  // 我们自己生成的摘要几乎每条都写「对广州分行…有影响」，若纳入会把"广州"注入每一条，
  // 使地域维度彻底失真（2026-08-29 实测：江苏银行因摘要含广州被误判为本地）。
  const locText = [article.title, article.subcategory ?? ""].join(" ");
  const signals: string[] = [];

  // 业务线匹配（用剥离栏目标识的文本）
  const matched = BUSINESS_LINES.filter((r) => r.kws.some((kw) => lineMatchText.includes(kw)))
    .map((r) => ({ line: r.line, weight: r.weight }))
    .sort((a, b) => b.weight - a.weight);
  const lineW = matched[0]?.weight ?? 0;
  const businessLines = matched.slice(0, 3).map((m) => m.line);
  if (matched.length) signals.push(`业务线[${businessLines.join("/")}] 权重${lineW}`);

  // 权威度
  const authW = Math.max(issuerScore(text), sourceScore(article.sourceId, article.subcategory));
  if (authW >= 0.95) signals.push("权威发文方(央行/金监总局/国务院级) +0.95");
  else if (authW >= 0.8) signals.push("地方政府/监管局级 +0.8");
  else if (authW >= 0.6) signals.push("权威媒体/政策源 +0.6");

  // 可行动性（国家核心监管「发文/出政策」本身即强行动信号；讲话/数据不构成）
  const baseAct = actionabilityScore(text);
  const issuerTop = issuerScore(text) >= 0.95;
  const actW =
    issuerTop && baseAct.type === "policy_action" ? Math.max(baseAct.score, 0.8) : baseAct.score;
  if (baseAct.type === "policy_action") signals.push("政策/新规动作 +0.9");
  else if (baseAct.type === "risk_action") signals.push("风险/违规动作 +0.85");
  else if (baseAct.type === "data_context") signals.push("数据解读(非动作) +0.4");
  else if (baseAct.type === "soft") signals.push("软资讯(获奖/出口等) +0.2");

  // 地域
  const locW = localityScore(locText, article.locale);
  if (locW >= 1.0) signals.push("广州本地 +1.0");
  else if (locW >= 0.9) signals.push("广东/大湾区 +0.9");

  // 综合分
  const base = Math.round(
    100 * (0.45 * lineW + 0.25 * authW + 0.2 * actW + 0.1 * locW),
  );
  // 时效衰减（S3）：只在注入 now 且非 IPO 状态稿时生效
  const tl = timelinessFactor(article, opts?.now);
  if (tl.exempt) signals.push("IPO 状态稿 → 豁免时效衰减");
  else if (tl.factor < 1 && tl.ageDays !== undefined) {
    signals.push(`时效衰减 ×${tl.factor}（距今 ${tl.ageDays.toFixed(1)} 天）`);
  }
  const baseTl = Math.round(base * tl.factor);
  // 外埠区域性银行（他省城商行/农商行）→ 仅参考意义，降权；本地(广州/广东)语境下不降
  const foreignRegional = FOREIGN_REGIONAL_BANK_RE.test(text) && locW < 0.9;
  const score = foreignRegional ? Math.round(baseTl * 0.72) : baseTl;
  if (foreignRegional) signals.push("外埠区域性银行（仅参考意义）降权 0.72");

  // 风险向判定
  let risk = matched.some((m) => m.line === "监管合规") || baseAct.type === "risk_action";

  let override: string | undefined;
  let tier: Tier;

  // 硬规则 A：国家核心监管政策 + 直击分行核心业务 → 必读置顶（房贷40年型）
  if (issuerTop && matched.some((m) => CORE_LINES.includes(m.line)) && actW >= 0.7) {
    override = "国家核心监管政策直击分行核心业务(信贷含房贷/消费贷/小微贷·财富·私行·客群) → 必读置顶";
    tier = "must_read";
    risk = false; // 政策机会向，非威胁
    signals.push("【硬规则A触发】必读置顶");
  }
  // 硬规则 B：广州本地监管/合规事件 → 必读(风险向)
  else if (locW >= 0.9 && matched.some((m) => m.line === "监管合规")) {
    override = "广州本地监管/合规事件 → 必读(风险向)";
    tier = "must_read";
    risk = true;
    signals.push("【硬规则B触发】风险必读");
  }
  // 常规档位：必读需「可行动」(actW>=0.6)，否则封顶为 insight（避免纯市场数据占必读位）
  else {
    const actionable = actW >= 0.6;
    if (score >= 68 && actionable) tier = "must_read";
    else if (score >= 45) tier = "insight";
    else if (score >= 25) tier = "context";
    else tier = "drop";
  }

  // 营销活动 / PR 通告（soft）对分行无执行关联 → 最高只到 context，不进必读与商机
  // （2026-08-29 用户：「工银财富季」这类活动启动通告对广州分行无逻辑/执行关联，不配进必读）
  if (baseAct.type === "soft" && (tier === "must_read" || tier === "insight")) {
    tier = "context";
    signals.push("营销/活动类通告 → 不进必读与商机");
  }
  // 外埠区域性银行：只作参考，不占必读名额（可进商机当参考）
  if (foreignRegional && tier === "must_read") {
    tier = "insight";
    signals.push("外埠区域性银行 → 仅参考意义，不进必读");
  }

  const finalScore = override ? Math.max(score, tier === "must_read" ? 84 : score) : score;

  const vertical: Vertical = risk
    ? "risk"
    : tier === "must_read"
      ? "must_read"
      : tier === "insight"
        ? "insight"
        : tier === "context"
          ? "context"
          : "drop";

  return {
    score: finalScore,
    tier,
    vertical,
    businessLines,
    authority: authW,
    actionability: actW,
    locality: locW,
    risk,
    ...(foreignRegional ? { foreignRegional: true } : {}),
    signals,
    override,
  };
}

// ---------------------------------------------------------------------------
// 批量排序（供人工抽检 / 接入管线）
// ---------------------------------------------------------------------------
export interface RankedArticle {
  article: ScorableArticle;
  relevance: BranchRelevance;
}

export function rankByRelevance(articles: ScorableArticle[], opts?: ScoreOptions): RankedArticle[] {
  return articles
    .map((a) => ({ article: a, relevance: scoreBranchRelevance(a, opts) }))
    .sort((x, y) => {
      if (y.relevance.score !== x.relevance.score) return y.relevance.score - x.relevance.score;
      return y.relevance.authority - x.relevance.authority;
    });
}
