/**
 * 管道运行时契约（契约层 · 零逻辑）。
 *
 * 这里是「端口（Port）」的定义：业务服务只依赖这些接口，不依赖具体实现。
 * 具体实现在 lib/adapters/（唯一副作用出口）。组合根 lib/orchestrator/ 负责把
 * 实现注入到 PipelineDeps。这就是端口 / 适配器架构的核心。
 */

import type { SourceDef, SourceTier } from "./source";
import type {
  DailyReport,
  ReportInsight,
  ReportItem,
  ReportMustRead,
  ReportSections,
  RiskItem,
} from "./report";
import type { ArticleInput, CrawledArticle, RawArticle } from "./article";

/** 文件系统端口（唯一磁盘出口）。 */
export interface FileStore {
  readJson<T>(path: string): Promise<T | null>;
  writeJson(path: string, data: unknown): Promise<void>;
  readText(path: string): Promise<string | null>;
  writeText(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(dir: string): Promise<string[]>;
  appendJsonl(path: string, obj: unknown): Promise<void>;
}

/** 时钟端口（测试可注入固定时间）。 */
export interface Clock {
  now(): Date;
  /** TZ 感知的今日键（如 2026-09-11）。 */
  todayKey(tz?: string): string;
}

/** LLM 端口（唯一 AI 出口）。 */
export interface LlmPort {
  /** 返回模型文本；失败抛错（上游负责重试）。 */
  complete(opts: LlmRequest): Promise<string>;
}

export interface LlmRequest {
  system?: string;
  prompt: string;
  /** 期望结构化输出时用 jsonrepair 兜底。 */
  expectJson?: boolean;
  temperature?: number;
  maxTokens?: number;
}

/** HTTP 端口（唯一网络出口，除采集专用 fetch 外）。 */
export interface HttpClient {
  getText(url: string, opts?: { useCurl?: boolean; headers?: Record<string, string> }): Promise<string>;
}

/** 日志端口。 */
export interface Logger {
  info(stage: string, msg: string, meta?: Record<string, unknown>): void;
  warn(stage: string, msg: string, meta?: Record<string, unknown>): void;
  error(stage: string, msg: string, meta?: Record<string, unknown>): void;
}

/** 运行模式：AI 正常 / 跳过 AI（复用缓存）。 */
export type RunMode =
  | { kind: "ai" }
  | {
      kind: "skip-ai";
      summaryCache: Map<string, string>;
      relevantUrls: Set<string>;
    };

/** 管道运行上下文（跨阶段共享的只读环境）。 */
export interface PipelineContext {
  startTime: Date;
  date: string;
  mode: RunMode;
  sources: SourceDef[];
  tierBySource: Map<string, SourceTier>;
  /** 错误聚合：每阶段 push 一条，末尾统一汇总。 */
  errors: Array<{ stage: string; source?: string; message: string; ts?: string }>;
  log: Logger;
}

/** 依赖注入容器：运行时把端口实现注入进来（组合根负责装配）。 */
export interface PipelineDeps {
  fs: FileStore;
  clock: Clock;
  llm: LlmPort;
  http: HttpClient;
}

/** 采集阶段产物。C1 只产出 RawArticle（publishedAt 可能缺失），红线 #1 由 C2 裁决。 */
export interface IngestResult {
  articles: RawArticle[];
  crawled: { ipo: CrawledArticle[]; gz: CrawledArticle[]; stocks: CrawledArticle[] };
}

/** 归一化阶段产物。 */
export interface NormalizedResult {
  articles: ArticleInput[];
}

/** 筛选阶段产物。 */
export interface SelectResult {
  articles: ArticleInput[];
  filterResults: Map<string, FilterResult>;
}

/** 富集阶段产物。 */
export interface EnrichedResult {
  report: DailyReport;
}

/** 组装阶段产物。sections 为已排序定档的最终面板；其余字段为「富集 extras」的兜底回写。 */
export interface AssembledResult {
  sections: ReportSections;
  must_read: ReportMustRead[];
  insights: ReportInsight[];
  hero_line?: string;
  risk?: RiskItem;
}

/** 漏斗结果（确定性过滤，零成本）。 */
export interface FilterResult {
  pass: boolean;
  score: number;
  dimensions: string[];
  opportunities?: Array<{ tracker: string; priority: "S" | "A" | "B"; label: string; fields: string[]; action: string }>;
  risks?: Array<{ tracker: string; priority: "S" | "A" | "B"; label: string; fields: string[]; action: string }>;
  gray?: boolean;
  matched: string[];
  bucket: "daily" | "opportunity" | "weekly" | "dropped";
}
