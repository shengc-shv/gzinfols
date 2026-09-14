/**
 * 采集提供者（C1 内部子模块）：按 SourceDef.type 分派抓取。
 *
 * 只通过注入的 HttpClient / FileStore 端口访问外部，不直接 import 网络库。
 * 红线 #1（无 publishedAt 丢弃）不在此层做 —— 留给归一化 C2 集中裁决。
 */
import Parser from "rss-parser";
import * as cheerio from "cheerio";
import type { RawArticle } from "../../contracts/article";
import type { SourceDef } from "../../contracts/source";
import type { HttpClient } from "../../contracts/pipeline";
import { SITE_PLANS } from "./site-parsers";

/** RSS 源：标准 RSS/Atom 解析。 */
export async function fetchRss(source: SourceDef, http: HttpClient, now: Date): Promise<RawArticle[]> {
  const xml = await http.getText(source.url, { useCurl: source.useCurl });
  const parser = new Parser();
  const feed = await parser.parseString(xml);
  return (feed.items ?? []).map((it) => ({
    sourceId: source.id,
    title: it.title ?? "(无标题)",
    url: it.link ?? "",
    excerpt: it.contentSnippet ?? it.content?.slice(0, 200) ?? "",
    publishedAt: it.isoDate ? new Date(it.isoDate) : undefined,
    fetchedAt: now,
    category: source.category,
    summary: it.contentSnippet ?? "",
  }));
}

/** 列表页抓取：通用 cheerio 解析（标题 + 链接 + 可选时间）。具体站点选择器可在此注册。 */
export async function fetchScrape(source: SourceDef, http: HttpClient, now: Date): Promise<RawArticle[]> {
  // 站点专用解析（gzinfo per-source provider 移植）：命中计划 → 按计划的多 URL
  // 逐个抓取 + 专用正则解析（能从 URL/页面提取真实发布时间）；未命中 → 通用 cheerio。
  const plan = SITE_PLANS[source.id];
  if (plan) {
    const out: RawArticle[] = [];
    for (const url of plan.urls) {
      try {
        const html = await http.getText(url, {
          useCurl: plan.useCurl ?? source.useCurl,
          headers: plan.headers,
        });
        out.push(...plan.parse(html, url, source));
      } catch (e) {
        // 单频道失败不拖垮整源（gzinfo fetch21jingji 双频道同语义）
        console.warn(`[scrape] ${source.id} ${url} 抓取失败: ${e instanceof Error ? e.message : e}`);
      }
    }
    return out;
  }
  const html = await http.getText(source.url, { useCurl: source.useCurl });
  const $ = cheerio.load(html);
  const out: RawArticle[] = [];
  $("a[href]").each((_, el) => {
    const title = $(el).text().trim();
    const href = $(el).attr("href") ?? "";
    if (!title || title.length < 6) return;
    const abs = href.startsWith("http") ? href : new URL(href, source.url).toString();
    const timeSel = $(el).closest("li,div").find("time").attr("datetime");
    const publishedAt = timeSel ? new Date(timeSel) : undefined;
    out.push({
      sourceId: source.id,
      title,
      url: abs,
      excerpt: title,
      publishedAt,
      fetchedAt: now,
      category: source.category,
    });
  });
  return out.slice(0, 50);
}

/** 未知 JSON 形状的窄化守卫（替代 `as any[]`，2026-09-14 C-4-2）。 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** API 源：拉 JSON 后由调用方按字段映射；此处做最小通用提取。 */
export async function fetchApi(source: SourceDef, http: HttpClient, now: Date): Promise<RawArticle[]> {
  const text = await http.getText(source.url);
  try {
    const json: unknown = JSON.parse(text);
    // 结构未知（可能是数组 / {items} / {data} / 其他）→ 一律显式窄化，不做 `as any` 逃逸
    const container: unknown = Array.isArray(json)
      ? json
      : isRecord(json)
        ? (json.items ?? json.data ?? [])
        : [];
    const items: unknown[] = Array.isArray(container) ? container : [];
    return items.slice(0, 50).map((it) => {
      const o = isRecord(it) ? it : {};
      return {
        sourceId: source.id,
        title: String(o.title ?? o.name ?? "(无标题)"),
        url: String(o.url ?? o.link ?? ""),
        excerpt: String(o.summary ?? o.description ?? o.title ?? ""),
        publishedAt: o.date ? new Date(String(o.date)) : undefined,
        fetchedAt: now,
        category: source.category,
      };
    });
  } catch {
    return [];
  }
}

/** 单源分派。 */
export async function fetchOne(source: SourceDef, http: HttpClient, now: Date): Promise<RawArticle[]> {
  if (source.role === "crawled-input") return []; // 爬虫源由 CrawlerRegistry 提供，普通抓取跳过
  switch (source.type) {
    case "rss":
      return fetchRss(source, http, now);
    case "scrape":
      return fetchScrape(source, http, now);
    case "api":
      return fetchApi(source, http, now);
    default:
      return [];
  }
}
