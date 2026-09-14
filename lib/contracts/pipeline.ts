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
import type { AiStage } from "./metrics";

/** 文件系统端口（唯一磁盘出口）。 */
export interface FileStore {
  readJson<T>(path: string): Promise<T | null>;
  writeJson(path: string, data: unknown): Promise<void>;
  readText(path: string): Promise<string | null>;
  writeText(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(dir: string): Promise<string[]>;
  appendJsonl(path: string, obj: unknown): Promise<void>;
  /**
   * 原子写 JSON（可选能力）：先写 `${path}.tmp` 再 rename。
   * gzinfo render-and-write 同款，避免写大文件中途崩溃留下「半个报告」。
   * 未实现该能力的 FileStore（测试 MemFs）由调用方回退普通 writeJson。
   */
  writeJsonAtomic?(path: string, data: unknown): Promise<void>;
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
  /** 模型覆盖（gzinfo PASS1_MODEL / PASS2_MODEL 语义）。 */
  model?: string;
  /** 业务阶段（stage 层埋点用；缺省记 "other"，见 contracts/metrics.ts AiStage）。 */
  stage?: AiStage;
}

/** HTTP 端口（唯一网络出口，除采集专用 fetch 外）。 */
export interface HttpClient {
  getText(url: string, opts?: { useCurl?: boolean; headers?: Record<string, string> }): Promise<string>;
}

/**
 * 语音合成端口（唯一 TTS 出口）。
 * 组合根按 AUDIO_ENABLED === "true" 装配；失败抛错，由管线 catch 降级为「页面无播放器」（不阻断发布）。
 * 落盘由适配器负责（双路径：daily_reports/<date>/audio/ 归档 + site/<date>/audio/ 站点）。
 */
export interface TtsPort {
  synthesize(
    script: string,
    date: string,
  ): Promise<{ backend: "tencent" | "piper"; bytes: number; durationSec: number }>;
}

/** 日志端口。 */
export interface Logger {
  info(stage: string, msg: string, meta?: Record<string, unknown>): void;
  warn(stage: string, msg: string, meta?: Record<string, unknown>): void;
  error(stage: string, msg: string, meta?: Record<string, unknown>): void;
}

/**
 * 运行模式（gzinfo ai/mode.ts 语义对齐）：
 *  - ai：全量 LLM 管线（PASS1→PASS2，全 AI 模式内部构建 prefillCache 复用历史摘要）
 *  - skip-ai：零 LLM 本地合成（CI 失败恢复/预分析复用）。summaryCache=url→已分析摘要
 *    （SKIP_AI PASS2 确定性复用）；relevantUrls=历史库已判定相关条目（SKIP_AI PASS1 只保留其中条目，
 *    防止今日新抓的非 L0 垃圾混入板块；缺省 = 全 keep 供无缓存兜底/测试）。
 */
export type RunMode =
  | { kind: "ai" }
  | {
      kind: "skip-ai";
      summaryCache: Map<string, string>;
      relevantUrls?: Set<string>;
    };

/** 过滤链旁路开关（默认全开；对应 env 的 `=off` 旁路由组合根读入）。 */
export interface FilterFlags {
  /** 关键词漏斗（KEYWORD_FILTER）。 */
  keyword: boolean;
  /** 漏斗全量误杀时的回退保底（KEYWORD_FILTER_FALLBACK）。 */
  keywordFallback: boolean;
  /** 标题相似度判重（DEDUP_SIMILAR）。 */
  dedupSimilar: boolean;
}

/** 运行配置（由组合根从环境变量注入，服务层禁止直读 process.env）。 */
export interface PipelineConfig {
  /** 采集窗口（天）：仅取该窗口内发布的条目。 */
  windowDays: number;
  /** 单板块展示条数上限。 */
  maxPerSection: number;
  /** 单板块内单源条数上限。 */
  maxPerSourcePerSection: number;
  /** 事件记忆总开关（EVENT_MEMORY=0 关闭，回滚/A-B 用）。 */
  eventMemory: boolean;
  /** 过滤链旁路开关。 */
  filters: FilterFlags;
  /** LLM 模型覆盖（PASS1_MODEL / PASS2_MODEL；空则走后端默认）。 */
  models: { pass1?: string; pass2?: string };
  /**
   * 分享卡片基址（REPORT_BASE_URL；渲染 og:image 用）。空 = 不输出 og:image
   * （2026-09-14 P1-2：不再回落到他仓硬编码地址，避免必然 404 的外域缩略图）。
   */
  reportBaseUrl: string;
  /** Web 模式（WEB_MODE=true → 渲染「归档」链接）。 */
  webMode: boolean;
}

/** 管道运行上下文（跨阶段共享的只读环境）。 */
export interface PipelineContext {
  startTime: Date;
  date: string;
  mode: RunMode;
  sources: SourceDef[];
  tierBySource: Map<string, SourceTier>;
  /** 运行配置（窗口 / 配额），由组合根注入。 */
  config: PipelineConfig;
  /** 阶段观测计数：llmCalls / llmFailures / recheckDropped 等，管线末尾汇总打日志。 */
  stats: Record<string, number>;
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
  /** 可选爬虫注册表（IPO 六源 + 广州商机三源接入通道；缺省不装配）。 */
  crawlers?: CrawlerRegistry;
  /** 可选语音合成（AUDIO_ENABLED 门控；缺省不装配 = 页面无播放器）。 */
  tts?: TtsPort;
}

/** 爬虫注册表端口（TS 爬虫产物接入通道；契约层只定义形状，实现由组合根装配）。 */
export interface CrawlerRegistry {
  /** 返回爬虫产物（IPO / 广州商机 / 昨日股市）。无爬虫源时返回空。 */
  fetchCrawledArticles(): Promise<{
    ipo: CrawledArticle[];
    gz: CrawledArticle[];
    stocks: CrawledArticle[];
  }>;
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
