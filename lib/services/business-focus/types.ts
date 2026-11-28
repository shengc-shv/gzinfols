/**
 * 动态经营重点引擎 · 类型契约（二期 WP1）。
 *
 * 分层口径（规格 2.2 / 3.1）：
 *   层级 layer   = annual / quarterly / temporary —— 决定权重基线与展示高亮级别；
 *   等级 grade   = S / A / B —— 同一个「季度重点」内部的轻重；
 *   两者正交：layer 回答「这一层多重要」，grade 回答「这条重点本身多重要」。
 *
 * 与六大经营领域（`config/business-domains.json`）的关系：
 *   领域是**稳定分类**，重点是**随年度/季度变化的配置**；一个重点可关联多个领域。
 *   ⛔ 重点不产生新的领域 id，领域 id 也不因重点而改（历史报告 primary_domain 依赖它）。
 *
 * 红线：本层只做「配置 → 生效清单」的纯计算，零 IO、零 LLM、零时钟（today 由调用方注入）。
 */

/** 重点层级（决定默认权重与展示高亮级别）。 */
export type FocusLayer = "annual" | "quarterly" | "temporary";

/** 重点等级（层内轻重）。 */
export type FocusGrade = "S" | "A" | "B";

/** 启用状态：只有 active 且落在生效窗口内的重点参与匹配与加权。 */
export type FocusStatus = "active" | "inactive";

/** 匹配等级（规格 3.3）：M3 直接匹配 / M2 高度相关 / M1 间接相关 / M0 无关联。 */
export type FocusMatchLevel = "M3" | "M2" | "M1" | "M0";

/** 归一化后的经营重点（所有字段必有值，便于匹配器与评分器直接消费）。 */
export interface FocusItem {
  id: string;
  name: string;
  description: string;
  layer: FocusLayer;
  grade: FocusGrade;
  status: FocusStatus;
  /** 层级权重（规格 2.3）：annual 1.0 / quarterly 1.5 / temporary 2.0，可被配置覆盖。 */
  priority: number;
  /** 显式加权分值（缺省按 grade × layer 表计算，见 focus-scoring）。 */
  weight?: number;
  /** 是否首页高亮（规格 7.2）。 */
  highlight: boolean;
  /** YYYY-MM-DD，空 = 不限。 */
  start_date: string;
  end_date: string;
  /** 关联六大领域 id（至少 1 个合法值，否则该重点降级为不参与匹配）。 */
  domains: string[];
  /** 核心关键词：单独命中即可判 M3（须配合领域匹配）。 */
  core_keywords: string[];
  /** 一般关键词。 */
  keywords: string[];
  /** 同义词（与 keywords 等价计分）。 */
  synonyms: string[];
  /** 关联业务概念（判 M2 的第二类信号）。 */
  concepts: string[];
  /** 关联客群 / 关联产品（仅作匹配辅助信号与展示，不单独判级）。 */
  segments: string[];
  products: string[];
  /** 排除词：命中即一票否决（M0），防「金价」误配「黄金配置」。 */
  exclude_keywords: string[];
  /** 重点来源说明（如「季度经营重点」「监管专项」）。 */
  source: string;
  /** 给 AI 的补充说明（本期规则层不消费，留给二期 AI 语义匹配）。 */
  description_for_ai: string;
  /** 该重点来自哪个配置文件（排查用）。 */
  config_file: string;
}

/** 单条配置问题（不阻断整体加载，逐条丢弃 + 告警）。 */
export interface FocusConfigIssue {
  file: string;
  id?: string;
  field?: string;
  message: string;
}

/** 单个配置文件的读取状态：ok 正常 / missing 首跑无此文件 / corrupt 文件在但读不懂。 */
export type FocusFileState = "ok" | "missing" | "corrupt";

/** 一个配置文件的原始内容 + 状态。 */
export interface FocusFileInput {
  file: string;
  layer: FocusLayer;
  state: FocusFileState;
  /** state=ok 时为解析后的对象；否则为空。 */
  data?: unknown;
  error?: string;
}

/** 加载结果。 */
export interface FocusConfigResult {
  /** 全部合法重点（含 inactive / 已过期），供专题页与配置体检使用。 */
  items: FocusItem[];
  /** 当前生效：status=active 且 today 落在 [start_date, end_date] 内。 */
  active: FocusItem[];
  /** 合成版本号 `f-<hash8>`，随日报落盘，用于历史追溯。 */
  version: string;
  /** 归一化内容的稳定哈希（同内容同值，任一字段变化即变值）。 */
  configHash: string;
  /** 三个文件各自的声明版本（缺省空串）。 */
  versions: Record<FocusLayer, string>;
  issues: FocusConfigIssue[];
  /** 任一文件缺失或损坏 → true（此时引擎应降级为「无生效重点」而不是报错）。 */
  degraded: boolean;
}

/** 加权默认表（规格 4.3 初始建议值）：层级 × 匹配等级 → 加分。 */
export const FOCUS_BONUS_TABLE: Record<FocusLayer, Record<"M3" | "M2" | "M1", number>> = {
  annual: { M3: 15, M2: 10, M1: 3 },
  quarterly: { M3: 20, M2: 12, M1: 3 },
  temporary: { M3: 30, M2: 18, M1: 3 },
};

/** 单条资讯经营重点总加分上限（规格 4.3：封顶 30）。 */
export const FOCUS_BONUS_CAP = 30;

/** 层级权重默认值（规格 2.3）。 */
export const FOCUS_LAYER_PRIORITY: Record<FocusLayer, number> = {
  annual: 1.0,
  quarterly: 1.5,
  temporary: 2.0,
};
