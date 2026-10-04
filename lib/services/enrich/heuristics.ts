/**
 * 板块归属内容判定启发式（自 gzinfo lib/output/render/cards.ts 移植）。
 *
 * 无状态源架构红线（2026-08-29 用户）：板块归属一律由**内容判定**，数据源分类只是
 * 采集元数据。本模块是 SKIP_AI 降级分类与（B6 渲染期）卡面判定的共用词表，
 * 与 PASS1/child 判定同源，避免「播报与卡片两套口径漂移」。
 */

// 广东企业判定（名单注册表，lib/guangdong.mjs 纯数据模块；与 voice/渲染同源）
import { isGuangdongEnterprise } from "../../guangdong.mjs";
import type { ReportSectionKey } from "../../contracts/report";

/** 广州严格锚（2026-08-21 gzinfo 重构 #9：「广州本地」板块严格过滤，宁缺毋滥） */
export const GZ_ANCHOR_RE =
  /广州|穗|天河|海珠|越秀|荔湾|白云|黄埔|番禺|南沙|增城|从化|花都|琶洲|珠江新城|白鹅潭|广州开发区|中新知识城/;

/**
 * 广州本地业务相关性红线（2026-08-29 gzinfo 用户拍板：广州本地板块须与客群/财富/私行/信贷挂钩）。
 * 「广州本地」是稀缺位，植物园志愿者、公安暂停服务、学校上新这类本地生活政务
 * 虽含广州锚，但与零售银行业务无关，不应占用该板块（宁缺毋滥的补充门槛）。
 */
export const GZ_BUSINESS_RE =
  /银行|信贷|房贷|按揭|消费|理财|财富|私行|基金|保险|投资|金融|楼市|购房|房地产|房价|IPO|上市|融资|企业|商户|就业|消费券|补贴|利率|存款|黄金|代发|客群|公积金|税务|社保|外贸|出口|制造|经济|项目|商圈/;

/** 是否为「广州本地板块」候选：内容含广州锚 + 与银行业务相关（两个条件都按内容判定）。 */
export function isGzLocalCandidate(title: string, excerpt = ""): boolean {
  const text = `${title} ${excerpt}`;
  return GZ_ANCHOR_RE.test(text) && GZ_BUSINESS_RE.test(text);
}

/**
 * 政策与市场板块的内容判定（2026-08-29 无状态源架构红线）：标题/摘要命中任一：
 *  - 地域锚：**国内外地**（`FOREIGN_REGION_RE`）或**境外/国际**（`INTL_REGION_RE`）
 *  - 政策动作词（发文/办法/通知/实施/监管…）
 *  - 全国市场词（利率/楼市/股市/债市…）
 * 即归「政策与市场」；否则归「业务启示」。
 */
export function isPolicyMarketCandidate(title: string, excerpt = ""): boolean {
  const text = `${title} ${excerpt}`;
  return (
    FOREIGN_REGION_RE.test(text) ||
    INTL_REGION_RE.test(text) ||
    POLICY_ACTION_RE.test(text) ||
    MARKET_SIGNAL_RE.test(text)
  );
}

/** 外地地名锚（广州本地严格过滤用）：命中任一 → 全国/外地政策，归政策与市场。 */
export const FOREIGN_REGION_RE =
  /上海|北京|深圳|江苏|浙江|南京|苏州|杭州|宁波|成都|重庆|天津|武汉|长沙|合肥|青岛|济南|福州|厦门|昆明|西安|郑州|东莞|佛山|珠海|中山|惠州|汕头|湛江|茂名|肇庆|江门|清远|韶关|梅州|河源|阳江|揭阳|汕尾|潮州|云浮|广东/;

/**
 * 境外 / 国际地域锚（2026-10-04 补，sc「检查全部归栏逻辑」）。
 *
 * ## 为什么必须补
 * 本模块此前**只有 `FOREIGN_REGION_RE`（国内外地省/市）**，于是
 * 「美股三大指数收涨纳指创新高」「G7 联手释放能源储备」「欧洲债市剧震」
 * 「美联储非农大幅低于预期」这类**国际宏观没有任何锚可命中** →
 * 全部落到兜底 `biz_insight`。而该栏是候选最拥挤的栏（10-04 实测
 * **81 条候选争 8 个展示位**，留存率 5%；同期 `policy_market` 9 条候选占 8 位、
 * 离限额 12 还空 4 位）→ 宏观类在那栏必被业务条目挤出。
 * 后果实测：**读者看不到国际面，定调也拿不到宏观素材**（10-04 定调只能写 1 个方面）。
 *
 * ## 收词原则（两条，都是实测教训）
 * 1. **只收「具体国家 / 地区 / 央行 / 国际机构」** —— 锚要能指认一个地方；
 * 2. ⛔ **刻意不收泛化词**「全球 / 国际 / 海外 / 世界 / 美元 / 黄金 / 原油」：
 *    实测裸词「国际」会把**本地新闻**误吸走 ——
 *    「中国国际漫画节广州开幕」「花都…广州国际商业港建设一线」都被拉进政策与市场。
 *    （同「中文关键词防跨词误配」教训：高危泛词不收或加前置断言。）
 *
 * 另收 `港股/港交所/恒生`：广州分行处粤港澳大湾区，港股属**境外市场**（10-03 sc 口径），
 * 归「政策与市场」而非业务软资讯。
 */
export const INTL_REGION_RE =
  /美国|欧洲|欧盟|欧元区|英国|法国|德国|意大利|西班牙|荷兰|瑞士|日本|韩国|俄罗斯|印度|越南|泰国|新加坡|马来西亚|印尼|中东|伊朗|以色列|乌克兰|土耳其|巴西|加拿大|澳大利亚|亚太|东南亚|非洲|拉美|新兴市场|华尔街|美联储|欧央行|日央行|非农|美股|欧股|日股|美债|IMF|世界银行|G7|G20|OPEC|WTO|港股|港交所|恒生/;

/** 政策动作词（内容判定：发文/新规/实施类） */
export const POLICY_ACTION_RE =
  /新规|发文|意见|办法|通知|印发|出台|发布|实施|监管|政策|方案|规划|指引|细则|试点|扩容|放宽|收紧|下调|上调|降息|降准|贴息|重组|调整|落地|延长|推出|宣布|要求|规定|条例|法规/;

/** 全国市场信号词（内容判定：政策敏感的市场/信贷类词；不含纯行情词——
 *  黄金/理财/基金/股市涨跌等属「业务启示」软资讯，不吸走 policy_market 稀缺位） */
export const MARKET_SIGNAL_RE =
  /利率|LPR|房贷|按揭|楼市|房价|购房|房地产|贷款|信贷|降息|降准|贴息|存款准备金|汇率|外汇|宏观|稳增长|扩内需|消费贷|经营贷|普惠|减税|退税|专项债|国债发行|万亿|基准利率/;

/**
 * IPO 阶段强词（内容判定，gzinfo 2026-08-30）：仅「企业 IPO 进展类」事件。
 * 刻意不含泛化词「上市/IPO」裸词，避免「上市培育计划」「IPO 培训」类政务/活动新闻
 * 被拉进 IPO 动态板块；须与名单企业名/城市判定（isGuangdongEnterprise）组合使用。
 */
// 2026-08-30 补 IPO受理 / IPO问询：东财在审表这两种状态最高频（「已受理」「已问询」），
// 原强词表只覆盖 过会/提交注册/注册生效，导致 60%+ 在审动态落不进板块与口播。
// 用 IPO 前缀限定，避免裸「受理」「问询」误伤（投诉受理 / 监管问询函）。
export const IPO_PROGRESS_RE =
  /注册生效|同意注册|IPO注册|首次公开发行|过会|上会|上市委|提交注册|注册申请|辅导备案|IPO辅导|辅导验收|招股|申购|路演|敲钟|新股上市|递表|拟上市|发行审核|发行注册|注册制上市|IPO已?受理|IPO已?问询/;

/**
 * 已上市公司资本运作公告词（gzinfo 2026-08-23 IPO 桶分流；2026-09-10 上移集中）。
 * 命中且非 IPO 流程词 → 转财经要点，避免定增/审核问询/购买资产/解禁等污染 IPO 板块。
 */
export const IPO_CAPITAL_ACT_RE =
  /(定增|增发|可转债|解禁|限售|回购|减持|增持|特定对象|发行股份购买资产|重大资产重组|资产重组|并购|审核问询|问询函|问询回复|年报|中报|季报|财报|分红|派息|业绩快报|澄清|停牌|复牌|诉讼|质押|担保|员工持股)/i;
/** IPO 流程词（与 IPO_CAPITAL_ACT_RE 组合使用：有资本运作词但命中本词 → 仍属 IPO 流程）。 */
export const IPO_FLOW_RE =
  /(受理|辅导|备案|招股|过会|上市委|注册生效|提交注册|询价|申购|路演|拟登陆|pre-?ipo|新股上市|上市公告|发行结果|中签|已受理)/i;

/**
 * 「广东企业 IPO 动态」内容判定（gzinfo 2026-08-30，无状态源红线合规：纯内容判定）：
 * 媒体源会即时报道「证监会同意粤芯半导体IPO注册」这类注册生效事件——东财在审表
 * 状态滞后（实测粤芯 08-28 批复，表里还停在 08-20），需要媒体报道补位。
 * 判定：① 广东企业（名单公司名/别名/广东城市词，三层识别）② 标题/摘要含 IPO 阶段强词。
 */
export function isGdIpoCandidate(title: string, excerpt = ""): boolean {
  const text = `${title} ${excerpt}`;
  return IPO_PROGRESS_RE.test(text) && isGuangdongEnterprise(text);
}

/**
 * 采集分类 + 内容判定 → 渲染板块（**单一真源**，2026-10-04 上移集中）。
 *
 * ## 为什么上移到本模块
 * 该函数此前有**两份实现**：`enrich/pipeline.ts`（生产管线 SKIP_AI 归栏用）与
 * `render/report-from-articles.ts`（`npm run render` / dry-run / render-preview 用）。
 * 两份**已经漂移**：render 版多一条 `isGdIpoCandidate → ipo` 判定，enrich 版没有
 * —— 即「同一条媒体源的广东 IPO 报道，预览脚本归 IPO 栏目、生产管线归业务启示」。
 *
 * 上移到本模块的理由：本模块已是三个判定函数 + 词表的真源（`render/cards.ts`
 * 即从此处 re-export），且 `render → enrich` 是既有正常依赖方向
 * （`report-from-articles.ts` 已 import `enrich/tag-rollup`）。
 *
 * ## 归栏顺序（**顺序即优先级，不得调换**）
 *  1. `tech` —— 独立内容栏目，按采集分类直通；
 *  2. `ipo` / `gd-ipo` —— 同上（东财在审表等 IPO 专用源）；
 *  3. `isGdIpoCandidate` —— **媒体源的广东企业 IPO 报道**（注册生效/辅导/过会，在审表滞后时补位）
 *     → 内容判定归 IPO 栏目。⚠️ 此行只有 render 版有，2026-10-04 补齐；
 *     实测影响面 0 条（10-03/10-04 两天数据均无条目命中），属**零风险对齐**；
 *  4. `isGzLocalCandidate` —— 广州锚 ∧ 业务线（宁缺毋滥）；
 *  5. `isPolicyMarketCandidate` —— 地域锚（国内外地 / 境外国际）/ 政策动作词 / 全国市场信号；
 *  6. 兜底 `biz_insight`。
 *
 * ⚠️ `gz_local` 必须排在 `policy_market` **之前**：否则「含广州锚 + 含境外词」的条目
 * （如「广州企业赴美上市」）会被异地锚抢走。
 */
export function categoryToSection(cat?: string, title = "", excerpt = ""): ReportSectionKey {
  if (cat === "tech") return "tech";
  if (cat === "ipo" || cat === "gd-ipo") return "ipo";
  if (isGdIpoCandidate(title, excerpt)) return "ipo";
  if (isGzLocalCandidate(title, excerpt)) return "gz_local";
  if (isPolicyMarketCandidate(title, excerpt)) return "policy_market";
  return "biz_insight";
}
