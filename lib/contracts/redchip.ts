/**
 * 红筹项目监测 · 契约层（零逻辑：只放类型 / 常量）。
 *
 * 口径（2026-09-15 用户确认，**阈值策略**）：
 *   红筹 = 境外注册 ∧ 广东运营实体词频 ≥ 3
 *   · 境外注册：申请版本封面页固定句式 → 注册地 ∈ 离岸法域集合
 *   · 广东连接：招股书文本中广东城市词频 ≥ GD_CITY_HIT_THRESHOLD（3）
 *     ⚠️ 词频**只统计「集团实体语境」句**内的命中（见 `classify.ts` 的 `countGdCityHits`）：
 *     裸提及会把「董事住址」「中介地址」「深交所名称」都算进来（实测单册 127 次里仅 10 次属实体语境），
 *     导致阈值恒成立、判定退化为「只看是否离岸」。裸提计数保留在 `gdCityMentions` 供展示/追溯。
 *   · VIE：仅作展示画像字段，**不参与判定**
 * 数据源：港交所披露易「新上市申請版本及相關資料」公开静态地址（免鉴权；red 已验证路径）。
 *
 * 红线：本模块及全链路**不引入任何加密资产**；**不出现银行主体信息**。
 */
export type RedchipVie = "current" | "historical" | "none" | "unverified";
export type RedchipVerdict = "redchip" | "non-redchip" | "unverified";

/** 单个红筹监测项目。 */
export interface RedchipProject {
  /** 港交所申请编号（去重主键）。 */
  appId: string;
  nameCn: string;
  nameEn: string;
  board: string;
  status: string;
  stockCode?: string;
  /** YYYY-MM-DD（官方递表日）。 */
  submitDate?: string;
  /** 注册地（封面页判定结果原文）。 */
  domicile?: string;
  /** 境外注册（离岸法域）——红筹必要条件之一。 */
  isOffshore: boolean;
  /** 广东城市词频 —— **仅统计「集团实体语境」句**内的命中（判定输入）。 */
  gdCityHits: number;
  /** 广东城市**裸提及**总数（不设语境门槛，仅供展示/追溯；恒 ≥ gdCityHits）。 */
  gdCityMentions?: number;
  /** 广东连接达标（gdCityHits ≥ 阈值）——红筹必要条件之一。 */
  isGdConnected: boolean;
  /** VIE 安排（仅画像，不参与判定）。 */
  vie: RedchipVie;
  /** 判定结果。 */
  verdict: RedchipVerdict;
  /** 首次入快照的北京时间 ISO（发现时间）。 */
  discoveredAt: string;
  /** 申请版本 PDF 直链（回原文核对入口）。 */
  sourceUrl?: string;
}

/** 一次监测的完整快照。 */
export interface RedchipSnapshot {
  /** 抓取时刻（北京时间 ISO）。 */
  capturedAt: string;
  count: number;
  projects: RedchipProject[];
}

export type RedchipChangeType = "added" | "removed" | "changed";

/** 变更记录（可追溯：时间 / 类型 / 编号 / 前后值 / 来源链接）。 */
export interface RedchipChange {
  at: string;
  type: RedchipChangeType;
  appId: string;
  nameCn?: string;
  /** changed 类型的字段名。 */
  field?: string;
  from?: string;
  to?: string;
  sourceUrl?: string;
}

/** 离岸法域（注册地命中其一即视为境外注册）。 */
export const OFFSHORE_JURISDICTIONS: readonly string[] = [
  "开曼群岛",
  "开曼",
  "Cayman Islands",
  "Cayman",
  "百慕大",
  "百慕達",
  "Bermuda",
  "英属维尔京群岛",
  "英屬維爾京群島",
  "British Virgin Islands",
  "BVI",
];

/** 广东城市词表（中英文；命中即计一次词频）。 */
export const GD_CITIES: readonly string[] = [
  "广州", "廣州", "guangzhou",
  "深圳", "shenzhen",
  "东莞", "東莞", "dongguan",
  "佛山", "foshan",
  "珠海", "zhuhai",
  "中山", "zhongshan",
  "惠州", "huizhou",
  "汕头", "汕頭", "shantou",
  "江门", "江門", "jiangmen",
  "清远", "清遠", "qingyuan",
  "肇庆", "肇慶", "zhaoqing",
  "茂名", "maoming",
  "湛江", "zhanjiang",
  "揭阳", "揭陽", "jieyang",
  "韶关", "韶關", "shaoguan",
  "梅州", "meizhou",
  "汕尾", "shanwei",
  "河源", "heyuan",
  "云浮", "雲浮", "yunfu",
  "阳江", "陽江", "yangjiang",
  "潮州", "chaozhou",
];

/** 广东连接阈值（词频 ≥ 3 视为达标，`gd_opco_count ≥ 3` 同款策略）。 */
export const GD_CITY_HIT_THRESHOLD = 3;

/** VIE 关键词（仅画像）。 */
export const VIE_KEYWORDS: readonly string[] = [
  "VIE",
  "可变利益实体",
  "可變利益實體",
  "协议控制",
  "協議控制",
  "结构性合约",
  "結構性合約",
  "contractual arrangements",
];

/** 封面页判定注册地的固定句式前缀。 */
export const COVER_DOMICILE_PATTERNS: readonly RegExp[] = [
  /Incorporated in (?:the )?([A-Za-z\s]+?) with limited liability/i,
  /A joint stock company incorporated in (?:the )?([A-Za-z\s]+?) with limited liability/i,
  /於([^\s，,。]{2,12})(?:註冊|注册)成立(?:的|之)?(?:有限公司|股份有限公司)/,
];

/** 快照与变更日志的存储路径（相对仓库根）。 */
export const REDCHIP_DIR = "data/redchip";
export const REDCHIP_LATEST_PATH = "data/redchip/latest.json";
export const REDCHIP_CHANGELOG_PATH = "data/redchip/changelog.jsonl";
/** 线索库（**须入库**：人工冻结快照，供渲染读取；运行时产物另三条见 .gitignore）。 */
export const REDCHIP_LEADS_PATH = "data/redchip/leads.json";

// ---------- 展示侧契约（2026-09-15 · plan-redchip-crawl-push §2）----------

/**
 * 可访问的红筹报告引用（会前版本 / L1 深度 / L2 人工）。
 * 由 `adapters/redchip/report-resolver` 探测站点目录得出。
 */
export interface RedchipReportRef {
  kind: "pre-meeting" | "deep" | "manual";
  /** 站内相对路径（如 `redchip/r/108804.html`）。 */
  url: string;
  title: string;
  /** 生成时刻（北京时间 ISO）。 */
  generatedAt: string;
}

/**
 * 线索级模型 = `RedchipProject` + 展示侧补充字段（写入 `leads.json`，**入库**）。
 *
 * ⚠️ 与 `RedchipProject` 的关系：判定字段全部沿用，**不再复制一份**（防两套口径漂移）；
 * 展示侧只追加「报告引用 / 时间线 / 证据摘录」这类派生数据。
 */
export interface RedchipLead extends RedchipProject {
  /** = `appId`，全链路唯一标识（显式字段便于展示侧阅读）。 */
  leadId: string;
  /** 最近一次字段变更时间（由 changelog 归并，北京时间 ISO）。 */
  lastChangedAt?: string;
  /** 广东连接原文摘录（1–3 条，供报告页「证据」版块）。 */
  gdEvidence?: Array<{ text: string; page?: number }>;
  /** 架构要点（离岸地 / 持股路径 / VIE 安排，供报告页）。 */
  archNotes?: string[];
  /** 可访问报告（会前/深度/人工）。 */
  reports?: RedchipReportRef[];
}

/** 徽章文案（红线「线索 ≠ 结论」：一律用「线索」口径）。 */
export const REDCHIP_LABELS = {
  redchip: "红筹线索",
  unverified: "红筹线索·待核",
} as const;

/**
 * 红筹展示面板条目（页面「红筹线索」面板；不入库，渲染期派生）。
 *
 * 与徽章的区别：徽章挂在**已匹配到 IPO 条目**的卡片上（T2）；面板额外收录
 * **匹配失败**的线索（T7：不进 IPO 卡片，但要在红筹展示页可见，否则线索会静默消失）。
 */
export interface RedchipPanelEntry {
  leadId: string;
  nameCn: string;
  nameEn: string;
  board: string;
  status: string;
  verdict: RedchipVerdict;
  /** 徽章文案（与卡片一致，避免两处口径漂移）。 */
  label: (typeof REDCHIP_LABELS)[keyof typeof REDCHIP_LABELS];
  domicile?: string;
  gdCityHits: number;
  vie: RedchipVie;
  submitDate?: string;
  /** 本次 `added` → 「新」角标。 */
  isNew: boolean;
  changedFields?: string[];
  /** 是否已匹配到 IPO 卡片（匹配失败者仅供展示，不参与卡片/口播）。 */
  matched: boolean;
  reportUrl?: string;
  sourceUrl?: string;
}

/** 红筹面板（`DailyReport.redchipPanel`）。 */
export interface RedchipPanel {
  entries: RedchipPanelEntry[];
  /** 快照抓取时刻（北京时间 ISO）；缺省 = 未取到快照。 */
  capturedAt?: string;
}

/**
 * 卡片级徽章（`ReportItem.redchip`）。
 *
 * 只放渲染与口播**当场需要**的字段；判定明细（domicile 原文、vie、证据）留在 lead/report 层。
 */
export interface RedchipBadge {
  /** 港交所申请编号（= lead.leadId，便于卡片直接回链）。 */
  leadId: string;
  label: (typeof REDCHIP_LABELS)[keyof typeof REDCHIP_LABELS];
  verdict: RedchipVerdict;
  /** 本次 `added` → 角标「新」。 */
  isNew: boolean;
  /** 本次 `changed` 的字段标签（如「状态」「注册地」）。 */
  changedFields?: string[];
  /** 站内相对路径：`redchip/r/<leadId>.html`（深度版存在时指向深度版）。 */
  reportUrl?: string;
  reportKind?: RedchipReportRef["kind"];
  // —— 以下为口播拼装所需的最小结构化数据（免 LLM）——
  /** 注册地标签（如「开曼群岛」）。 */
  domicile?: string;
  /** 广东运营命中数（实体语境计数）。 */
  gdCityHits?: number;
  /** `changed` 时的人话摘要（如「状态 处理中→已受理」）。 */
  changeSummary?: string;
}
