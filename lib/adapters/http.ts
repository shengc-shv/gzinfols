/**
 * HTTP 适配器（副作用出口 #3）。
 *
 * 网络出口统一走这里；对 TLS 指纹挑战的主机走 curl 兜底。
 *
 * 超时 + 重试（2026-10-04 sc「R5 重试 3 次」）：
 * 此前**既无超时也无重试** —— 网络抖动 / 源站 5xx 会让该源直接失败（`Promise.allSettled`
 * 只隔离不重试），表现为「某源当天是暗的」而无任何补救；且 `fetch` 分支没有超时，
 * 一个挂起的源会一直占住整轮（curl 分支有 `--max-time 30`，两条路径不一致）。
 *
 * 重试口径（**只对幂等 GET**）：
 *  - ✅ 重试：网络错误 / 超时 / **5xx** / **429**（限流）
 *  - ⛔ 不重试：其余 **4xx**（客户端错误，重试无意义且会放大压力）
 *  - 退避：800ms → 2000ms（**总尝试 3 次** = 首次 + 2 次重试）
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HttpClient } from "../contracts/pipeline";

const execFileP = promisify(execFile);

/** 总尝试次数（含首次）。 */
const HTTP_ATTEMPTS = 3;
/** 单次请求超时（两条路径统一）。 */
const HTTP_TIMEOUT_MS = 30_000;
/** 第 n 次失败后的退避时长（ms）。 */
const BACKOFF_MS = [800, 2000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 只有服务端错误与限流才值得重试；其余 4xx 是客户端问题，重试只会放大压力。 */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

/** 从 `HTTP 503 for <url>` 这类消息里取出状态码；网络错误/超时返回 null（视为可重试）。 */
function statusOf(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /HTTP (\d{3})/.exec(msg);
  return m ? Number(m[1]) : null;
}

export class FetchAdapter implements HttpClient {
  async getText(
    url: string,
    opts?: { useCurl?: boolean; headers?: Record<string, string> },
  ): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= HTTP_ATTEMPTS; attempt++) {
      try {
        return await this.once(url, opts);
      } catch (err) {
        lastErr = err;
        if (attempt >= HTTP_ATTEMPTS) break;
        const status = statusOf(err);
        // status === null → 网络错误/超时 → 可重试；4xx（除 429）→ 立即放弃
        if (status !== null && !isRetryableStatus(status)) break;
        await sleep(BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** 单次请求（内部不重试）。 */
  private async once(
    url: string,
    opts?: { useCurl?: boolean; headers?: Record<string, string> },
  ): Promise<string> {
    if (opts?.useCurl) {
      const args = ["-sL", "--max-time", String(HTTP_TIMEOUT_MS / 1000)];
      for (const [k, v] of Object.entries(opts.headers ?? {})) {
        args.push("-H", `${k}: ${v}`);
      }
      args.push(url);
      const { stdout } = await execFileP("curl", args, { maxBuffer: 32 * 1024 * 1024 });
      return stdout;
    }
    // 此前无超时 → 挂起的源会占住整轮；与 curl 分支统一到 30s
    const res = await fetch(url, {
      headers: opts?.headers,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  }
}
