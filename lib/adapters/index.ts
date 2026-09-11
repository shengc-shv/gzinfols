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
import type { Clock, FileStore, HttpClient, Logger, LlmPort, PipelineDeps } from "../contracts/pipeline";

export interface AdapterOverrides {
  fs?: FileStore;
  clock?: Clock;
  llm?: LlmPort;
  http?: HttpClient;
}

export function createAdapters(overrides: AdapterOverrides = {}): PipelineDeps {
  return {
    fs: overrides.fs ?? new NodeFsAdapter(),
    clock: overrides.clock ?? new SystemClock(),
    llm: overrides.llm ?? new LlmAdapter(),
    http: overrides.http ?? new FetchAdapter(),
  };
}

export { NodeFsAdapter, SystemClock, FetchAdapter, LlmAdapter, ConsoleLogger };
