/**
 * 文件系统适配器（副作用出口 #1）。
 *
 * 全仓库唯一直接 import node:fs 的地方（除本文件与 llm/http 外）。
 * 业务服务通过 FileStore 端口使用，不得直接碰 fs。
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { FileStore } from "../contracts/pipeline";

export class NodeFsAdapter implements FileStore {
  constructor(private readonly root: string = process.cwd()) {}

  private abs(p: string): string {
    return path.isAbsolute(p) ? p : path.join(this.root, p);
  }

  async readJson<T>(p: string): Promise<T | null> {
    try {
      const raw = await fsp.readFile(this.abs(p), "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async writeJson(p: string, data: unknown): Promise<void> {
    const a = this.abs(p);
    await fsp.mkdir(path.dirname(a), { recursive: true });
    await fsp.writeFile(a, JSON.stringify(data, null, 2), "utf8");
  }

  /** 原子写：先落 `${p}.tmp` 再 rename（同一文件系统上 rename 原子）。 */
  async writeJsonAtomic(p: string, data: unknown): Promise<void> {
    const a = this.abs(p);
    await fsp.mkdir(path.dirname(a), { recursive: true });
    const tmp = `${a}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fsp.rename(tmp, a);
  }

  async readText(p: string): Promise<string | null> {
    try {
      return await fsp.readFile(this.abs(p), "utf8");
    } catch {
      return null;
    }
  }

  async writeText(p: string, content: string): Promise<void> {
    const a = this.abs(p);
    await fsp.mkdir(path.dirname(a), { recursive: true });
    await fsp.writeFile(a, content, "utf8");
  }

  async exists(p: string): Promise<boolean> {
    try {
      await fsp.access(this.abs(p));
      return true;
    } catch {
      return false;
    }
  }

  async list(dir: string): Promise<string[]> {
    const a = this.abs(dir);
    try {
      const ents = await fsp.readdir(a, { withFileTypes: true });
      return ents.filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  async appendJsonl(p: string, obj: unknown): Promise<void> {
    const a = this.abs(p);
    await fsp.mkdir(path.dirname(a), { recursive: true });
    await fsp.appendFile(a, JSON.stringify(obj) + "\n", "utf8");
  }
}
