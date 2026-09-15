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
