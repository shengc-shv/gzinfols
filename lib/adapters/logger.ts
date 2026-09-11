/**
 * 日志适配器（副作用出口）：结构化输出到 stderr（不污染 stdout 产物）。
 * 业务服务只认 Logger 端口，不直接 console。
 */
import type { Logger } from "../contracts/pipeline";

export class ConsoleLogger implements Logger {
  constructor(private readonly name = "gzinfols") {}

  private emit(level: string, stage: string, msg: string, meta?: Record<string, unknown>): void {
    const t = new Date().toISOString().slice(11, 19);
    const m = meta ? ` ${JSON.stringify(meta)}` : "";
    process.stderr.write(`[${t}] ${level} ${this.name}/${stage}: ${msg}${m}\n`);
  }

  info(stage: string, msg: string, meta?: Record<string, unknown>): void {
    this.emit("INFO", stage, msg, meta);
  }
  warn(stage: string, msg: string, meta?: Record<string, unknown>): void {
    this.emit("WARN", stage, msg, meta);
  }
  error(stage: string, msg: string, meta?: Record<string, unknown>): void {
    this.emit("ERROR", stage, msg, meta);
  }
}
