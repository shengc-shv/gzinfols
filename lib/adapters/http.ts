/**
 * HTTP 适配器（副作用出口 #3）。
 *
 * 网络出口统一走这里；对 TLS 指纹挑战的主机走 curl 兜底。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HttpClient } from "../contracts/pipeline";

const execFileP = promisify(execFile);

export class FetchAdapter implements HttpClient {
  async getText(
    url: string,
    opts?: { useCurl?: boolean; headers?: Record<string, string> },
  ): Promise<string> {
    if (opts?.useCurl) {
      const args = ["-sL", "--max-time", "30"];
      for (const [k, v] of Object.entries(opts.headers ?? {})) {
        args.push("-H", `${k}: ${v}`);
      }
      args.push(url);
      const { stdout } = await execFileP("curl", args, { maxBuffer: 32 * 1024 * 1024 });
      return stdout;
    }
    const res = await fetch(url, { headers: opts?.headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  }
}
