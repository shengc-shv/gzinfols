/**
 * 测试辅助：内存版端口实现（不落盘、不联网、不调真实 LLM）。
 * 用于离线端到端验证管线逻辑与红线行为。
 */
import type {
  Clock,
  FileStore,
  HttpClient,
  Logger,
  LlmPort,
} from "../lib/contracts/pipeline";

export class MemFs implements FileStore {
  private json = new Map<string, unknown>();
  private text = new Map<string, string>();

  async readJson<T>(p: string): Promise<T | null> {
    return (this.json.get(p) as T) ?? null;
  }
  async writeJson(p: string, d: unknown): Promise<void> {
    this.json.set(p, d);
  }
  async readText(p: string): Promise<string | null> {
    return this.text.get(p) ?? null;
  }
  async writeText(p: string, c: string): Promise<void> {
    this.text.set(p, c);
  }
  async exists(p: string): Promise<boolean> {
    return this.json.has(p) || this.text.has(p);
  }
  async list(): Promise<string[]> {
    return [];
  }
  async appendJsonl(p: string, o: unknown): Promise<void> {
    const arr = (this.json.get(p) as unknown[]) ?? [];
    arr.push(o);
    this.json.set(p, arr);
  }
  // 测试便捷方法
  setJson(p: string, d: unknown): void {
    this.json.set(p, d);
  }
  getText(p: string): string | null {
    return this.text.get(p) ?? null;
  }
}

export class FakeHttp implements HttpClient {
  constructor(private readonly body: string) {}
  async getText(): Promise<string> {
    return this.body;
  }
}

/**
 * 假 LLM：按 system 关键词分流三类调用（顺序即优先级）：
 *  1. 相关性回检（system 含「相关性」）→ 从 prompt 提取 url，全部判 relevant=true；
 *  2. 批量富集（system 含「简报编辑」）→ 解析批内序号，返回逐条改写 JSON 数组；
 *  3. 报告级调用 → 返回 hero/insights/must_read/risk（must_read.url 用 e2e 真实条目 url）。
 */
export class FakeLlm implements LlmPort {
  /** 调用次数（供观测断言）。 */
  calls = 0;

  async complete(opts: {
    system?: string;
    prompt: string;
    expectJson?: boolean;
  }): Promise<string> {
    this.calls++;
    const sys = opts.system ?? "";
    if (sys.includes("相关性")) {
      const urls = [...opts.prompt.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]);
      return JSON.stringify(urls.map((u) => ({ url: u, relevant: true })));
    }
    if (sys.includes("简报编辑")) {
      const items = [...opts.prompt.matchAll(/(\d+)\. 标题：/g)].map((m) => ({
        i: Number(m[1]),
        title_cn: "AI 大模型驱动银行金融科技升级",
        summary: "某行发布 AI 中台，理财与风控效率显著提升。",
        tags: ["AI", "金融科技"],
        importance: 3,
      }));
      return JSON.stringify(items);
    }
    return JSON.stringify({
      hero_line: "今日科技主线：AI 重塑银行中后台。",
      insights: [
        { topic: "AI 中台", impact: "提升运营效率", action: "关注相关标的机会", segments: ["零售AUM"] },
      ],
      must_read: [{ url: "https://example.com/a", why: "头部条目" }],
      risk: {
        topic: "模型风险",
        evidence: "数据治理不足",
        impact: "合规压力上升",
        action: "加强内控",
      },
    });
  }
}

export class FakeClock implements Clock {
  now(): Date {
    return new Date("2026-09-11T08:00:00Z");
  }
  todayKey(): string {
    return "2026-09-11";
  }
}

export class SilentLog implements Logger {
  info(): void {}
  warn(): void {}
  error(): void {}
}
