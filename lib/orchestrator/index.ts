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
  PipelineConfig,
  PipelineContext,
  PipelineDeps,
  RunMode,
} from "../contracts/pipeline";
import { createAdapters, type AdapterOverrides } from "../adapters";
import { ConsoleLogger } from "../adapters/logger";

/** 从 sources.config.json 载入源注册表（唯一真源）。兼容顶层数组与 {sources:[...]} 两种形状。 */
export async function loadSources(fs: FileStore): Promise<SourceDef[]> {
  const cfg = await fs.readJson<SourceDef[] | { sources?: SourceDef[] }>("sources.config.json");
  const sources = Array.isArray(cfg) ? cfg : cfg?.sources;
  if (!sources || sources.length === 0)
    throw new Error("sources.config.json 缺少 sources 字段或为空");
  return sources;
}

function buildTierMap(sources: SourceDef[]): Map<string, SourceTier> {
  return new Map(sources.map((s) => [s.id, s.tier ?? "T2"]));
}

/** `X=off` 形式的环境旁路开关：默认开启，显式 off 才关闭。 */
function envFlag(name: string): boolean {
  return process.env[name] !== "off";
}

/**
 * 默认运行配置：组合根从环境变量读取（服务层不直读 env）。
 * 全项目唯一允许读这些 env 的地方；换口径只改此处。
 */
function defaultConfig(): PipelineConfig {
  return {
    windowDays: Number(process.env.FETCH_WINDOW_DAYS || 2),
    maxPerSection: Number(process.env.MAX_PER_SECTION || 18),
    maxPerSourcePerSection: Number(process.env.MAX_PER_SOURCE_PER_SECTION || 4),
    eventMemory: (process.env.EVENT_MEMORY ?? "1") !== "0",
    filters: {
      keyword: envFlag("KEYWORD_FILTER"),
      keywordFallback: envFlag("KEYWORD_FILTER_FALLBACK"),
      dedupSimilar: envFlag("DEDUP_SIMILAR"),
    },
    models: {
      pass1: process.env.PASS1_MODEL?.trim() || undefined,
      pass2: process.env.PASS2_MODEL?.trim() || undefined,
    },
  };
}

export interface ContextOpts {
  date: string;
  mode: RunMode;
  sources: SourceDef[];
  log?: Logger;
  /** 覆盖默认运行配置（窗口/配额；测试注入用）。 */
  config?: Partial<PipelineConfig>;
  /** 覆盖运行起始时间（测试注入固定时钟用）。 */
  startTime?: Date;
  /** 覆盖初始 stats 计数（测试注入用）。 */
  stats?: Record<string, number>;
}

/** 构造跨阶段共享上下文。 */
export function createContext(opts: ContextOpts): PipelineContext {
  return {
    startTime: opts.startTime ?? new Date(),
    date: opts.date,
    mode: opts.mode,
    sources: opts.sources,
    tierBySource: buildTierMap(opts.sources),
    config: { ...defaultConfig(), ...opts.config },
    stats: { ...opts.stats },
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
