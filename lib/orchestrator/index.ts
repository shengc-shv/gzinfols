/**
 * 组合根（Composition Root）：全仓库唯一「new 具体副作用实现」的地方。
 *
 * 业务服务只依赖 lib/contracts 的端口接口；本文件把具体适配器（NodeFsAdapter /
 * SystemClock / FetchAdapter / LlmAdapter）装配成 PipelineDeps，并从
 * sources.config.json 载入源注册表装配 PipelineContext。换实现（测试用内存、
 * 固定时钟）只改这里。
 */
import type { SourceDef, SourceTier } from "../contracts/source";
import type {
  FileStore,
  Logger,
  PipelineContext,
  PipelineDeps,
  RunMode,
} from "../contracts/pipeline";
import { createAdapters, type AdapterOverrides } from "../adapters";
import { ConsoleLogger } from "../adapters/logger";

/** 从 sources.config.json 载入源注册表（唯一真源）。 */
export async function loadSources(fs: FileStore): Promise<SourceDef[]> {
  const cfg = await fs.readJson<{ sources?: SourceDef[] }>("sources.config.json");
  if (!cfg?.sources || cfg.sources.length === 0)
    throw new Error("sources.config.json 缺少 sources 字段或为空");
  return cfg.sources;
}

function buildTierMap(sources: SourceDef[]): Map<string, SourceTier> {
  return new Map(sources.map((s) => [s.id, s.tier ?? "T2"]));
}

export interface ContextOpts {
  date: string;
  mode: RunMode;
  sources: SourceDef[];
  log?: Logger;
}

/** 构造跨阶段共享上下文。 */
export function createContext(opts: ContextOpts): PipelineContext {
  return {
    startTime: new Date(),
    date: opts.date,
    mode: opts.mode,
    sources: opts.sources,
    tierBySource: buildTierMap(opts.sources),
    errors: [],
    log: opts.log ?? new ConsoleLogger(),
  };
}

export interface BootstrapOpts {
  date: string;
  mode?: RunMode;
  adapterOverrides?: AdapterOverrides;
}

/**
 * 组合根入口：装配 deps + ctx。脚本只需调用本函数即可拿到完整运行环境。
 */
export async function bootstrap(
  opts: BootstrapOpts,
): Promise<{ ctx: PipelineContext; deps: PipelineDeps }> {
  const deps = createAdapters(opts.adapterOverrides ?? {});
  const sources = await loadSources(deps.fs);
  const mode: RunMode = opts.mode ?? { kind: "ai" };
  const ctx = createContext({ date: opts.date, mode, sources });
  return { ctx, deps };
}
