/**
 * 分类 / 子分类标签与顺序（2026-09-14 Phase 2b 自 `render/i18n.ts` 与 `render/cards.ts` 下沉）。
 *
 * 单一真源：渲染层与组装层（assemble/group.ts）共用此处的词表，避免各存一份
 * （与 heuristics.ts 同一教训——调一处不生效的典型隐患）。
 */
import type { Category } from "../../contracts/source";
import { STR } from "./strings";

const SUBCATEGORY_ORDER: Partial<Record<Category, string[]>> = {
  // cn-community + overseas-community are listed last so the L1 "community"
  // panel (rendered separately via TECH_COMMUNITY_SUBS) can extract them.
  // Within the "tech" L1 panel itself, COMMUNITY_SUBS is filtered out.
  // Locale filtering at registry level decides which actually appears:
  // zh mode keeps cn-community (V2EX / LinuxDo); en mode keeps
  // overseas-community (Hacker News / r/stocks).
  // 技术动态：国内技术 / 国外技术（2026-08-20 清理：去掉 AI媒体/热门论文/X 推文子类）
  tech: ["cn-tech", "overseas-tech"],
  // 宏观政策：国家政策 / 国内财经(综合) / 广州政策 / 国际
  // （2026-08-21 用户：全国财富/信贷/私行 移出宏观政策，并入广州商机面板区分全国/广州）
  finance: ["cn-policy", "cn-finance", "gz-policy", "news"],
  'gd-ipo': ["stage-listed", "stage-registered", "stage-reviewing", "stage-tutoring"],
  // 参考区·全国IPO/新股：全部交易所+辅导（非广州辖区的广东企业也归此）
  ipo: ["sse", "szse", "bse", "hkex", "ipo-tutoring", "overseas"],
  // 广州商机：合并为单一「广州能参考的商机」流（2026-08-21 用户：不再按业务线/
  // 本地全国分层，面板内仅按「官方政府 / 媒体智库」两类 tab 展现）
  gz: ["gz-all"],
  politics: ["world"],
  // 昨日股市（2026-08-25 新增）：A股 / 美股 / 港股 三个市场分组
  stocks: ["a-share", "us", "hk"],
};

const SUBCATEGORY_LABELS: Record<string, string> = {
  "github-trending": "GitHub Trending",
  "trending-papers": STR.subTrendingPapers,
  "cn-community": STR.subCnCommunity,
  "overseas-community": STR.subOverseasCommunity,
  "ai-news": STR.subAiNews,
  "cn-tech": STR.subCnTech,
  "overseas-tech": STR.subOverseasTech,
  "x-viral": STR.subXViral,
  "blog-weekly": STR.subBlogWeekly,
  news: STR.subFinanceNews,
  "cn-finance": STR.subFinanceCn,
  "cn-wealth": "全国财富",
  "cn-credit": "全国零售信贷",
  "cn-private": "全国私行",
  "cn-policy": "国家政策",
  "gz-policy": "广州政策",
  world: STR.subWorld,
  // 广东地区IPO 的 6 个二级标签（地域→市场 分发；预备上市统一进 IPO辅导）
  szse: "深交所",
  sse: "上交所",
  bse: "北交所",
  hkex: "港交所",
  "ipo-tutoring": "IPO辅导",
  // 昨日股市三个市场分组（2026-08-25 新增）
  "a-share": "A股",
  us: "美股",
  hk: "港股",
  overseas: "境外",
  // 广东地区IPO 按「上市进度」分栏（任务二：看已上市 / 准备IPO 两类，找股份行广州分行商机）
  "stage-listed": "已上市·新股",
  "stage-registered": "注册生效·过会",
  "stage-reviewing": "在审·已受理",
  "stage-tutoring": "辅导备案·Pre-IPO",
  // 广州商机（合并流：广州可参考的商机，官方/媒体两 tab）
  "gz-all": "广州商机",
};

const CATEGORY_LABELS: Record<Category, string> = {
  tech: STR.catTech,
  finance: STR.catFinance,
  politics: STR.catPolitics,
  'gd-ipo': '广东地区IPO',
  ipo: STR.catIpo,
  gz: '广州商机',
  stocks: '昨日股市',
};

export { CATEGORY_LABELS, SUBCATEGORY_LABELS, SUBCATEGORY_ORDER };
