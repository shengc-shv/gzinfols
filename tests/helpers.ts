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
import { extractJson } from "../lib/services/enrich/json-util";

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
  calls = 0;
  /** PASS1 keep 覆盖：url → keep（默认 true）。 */
  keepOverrides = new Map<string, boolean>();

  async complete(opts: { system?: string; prompt: string }): Promise<string> {
    this.calls++;
    const sys = opts.system ?? "";
    const slice = (p: string) => {
      try {
        // extractJson：从首个 {/[ 起括号平衡扫描（正确处理模板尾部的示例 JSON 文本）
        const cleaned = extractJson(p);
        const parsed = JSON.parse(cleaned);
        return Array.isArray(parsed) ? parsed : (parsed?.items ?? []);
      } catch {
        return [];
      }
    };
    if (sys.includes("资讯筛选编辑")) {
      // PASS1 协议：items=[{url,keep,section,source_type,locale,locale_evidence,tags,title_cn,title_orig,importance_candidate}]
      const arr = slice(opts.prompt) as Array<{ url: string; title?: string; category?: string }>;
      return JSON.stringify({
        items: arr.map((it) => ({
          url: it.url,
          keep: this.keepOverrides.get(it.url) ?? true,
          section: it.category === "tech" ? "tech" : it.category === "ipo" || it.category === "gd-ipo" ? "ipo" : "biz_insight",
          source_type: "media",
          locale: "national",
          locale_evidence: "",
          tags: ["市场"],
          title_cn: it.title ?? "",
          title_orig: "",
          importance_candidate: 2,
        })),
      });
    }
    if (sys.includes("总编辑")) {
      // PASS2 协议：hero_line + sections（must_read/insights 恒空，B3 旁路产出）
      const arr = slice(opts.prompt) as Array<{
        url: string; title_cn: string; title_orig?: string; source: string; source_type: string;
        date: string; tags: string[]; locale: string; locale_evidence?: string; section: string; raw_text?: string;
      }>;
      const sections: Record<string, unknown[]> = { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] };
      for (const it of arr) {
        (sections[it.section] ?? sections.biz_insight).push({
          url: it.url,
          title_cn: it.title_cn,
          title_orig: it.title_orig ?? "",
          source: it.source,
          source_type: it.source_type,
          date: it.date,
          summary: `【改写】${(it.raw_text ?? "").slice(0, 40)}`,
          importance: 2,
          tags: it.tags ?? [],
          locale: it.locale,
          locale_evidence: it.locale_evidence ?? "",
        });
      }
      return JSON.stringify({
        hero_line: "今日关注：金融科技与财富管理动态，详见各板块。",
        must_read: [],
        insights: [],
        sections,
      });
    }
    return JSON.stringify({ hero_line: "", must_read: [], insights: [], sections: {} });
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
