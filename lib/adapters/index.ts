/**
 * 适配器工厂：组合根在此把「具体实现」装配成 PipelineDeps。
 *
 * 业务服务只认端口接口；要换实现（如测试用内存 FS、固定时钟），只在组合根改这里。
 */
import { NodeFsAdapter } from "./fs";
import { SystemClock } from "./clock";
import { FetchAdapter } from "./http";
import { LlmAdapter } from "./llm";
import { ConsoleLogger } from "./logger";
import { TtsAdapter } from "./tts";
import { fetchCrawledArticles } from "./crawlers";
import type {
  Clock,
  CrawlerRegistry,
  FileStore,
  HttpClient,
  Logger,
  LlmPort,
  PipelineDeps,
  TtsPort,
} from "../contracts/pipeline";

export interface AdapterOverrides {
  fs?: FileStore;
  clock?: Clock;
  llm?: LlmPort;
  http?: HttpClient;
  /** 爬虫注册表（默认装配真实爬虫；测试传 null 显式关闭，或不传 = 真实爬虫）。 */
  crawlers?: CrawlerRegistry | null;
  /** 语音合成（默认按 AUDIO_ENABLED === "true" 装配；测试传 null 显式关闭）。 */
  tts?: TtsPort | null;
}

export function createAdapters(overrides: AdapterOverrides = {}): PipelineDeps {
  const crawlers: CrawlerRegistry = { fetchCrawledArticles };
  return {
    fs: overrides.fs ?? new NodeFsAdapter(),
    clock: overrides.clock ?? new SystemClock(),
    llm: overrides.llm ?? new LlmAdapter(),
    http: overrides.http ?? new FetchAdapter(),
    // 默认装配真实爬虫；测试注入 overrides.crawlers === null 显式关闭（不传 = 真实爬虫）。
    crawlers: overrides.crawlers === null ? undefined : (overrides.crawlers ?? crawlers),
    // TTS：AUDIO_ENABLED === "true" 才装配（CI Generate 步骤显式注入；本地默认关闭）。
    tts: overrides.tts === null ? undefined : (overrides.tts ?? (process.env.AUDIO_ENABLED === "true" ? new TtsAdapter() : undefined)),
  };
}

export { NodeFsAdapter, SystemClock, FetchAdapter, LlmAdapter, ConsoleLogger, TtsAdapter };
