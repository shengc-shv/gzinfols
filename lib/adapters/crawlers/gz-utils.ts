/**
 * 广州商机抓取 - 共享解析工具
 *
 * 政府网站列表页结构基本一致（<li> 或 <ul> 内 <a href=".../content/post_xxx.html" title="标题">），
 * 这里用「宽容扫描」：匹配所有 content/post_*.html 链接，标题取 title 属性（权威）或标签文本，
 * 日期从链接前 400 字符上下文里找 YYYY-MM-DD，找不到就留空（上游 fallback）。
 *
 * M3-A 移植：原 scripts/crawlers/gz-utils.mjs 逐字移植（纯函数，含测试）。
 */

/** 剥离 HTML 标签 + 空白 */
export function strip(s: string): string {
  return (s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 把日期字符串归一成 ISO（日期级 -> UTC 零点，避免时区偏移） */
export function dateToIso(s: string): string | null {
  const m = String(s || "").match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}T00:00:00.000Z`;
}

/**
 * 解析政府列表页 HTML
 * @param html
 * @param opts.minLen 标题最小长度
 * @param opts.lookback 在链接前回溯多少字符找日期
 * @param opts.maxItems 最多返回条数
 */
export function parseGovList(
  html: string,
  opts: { minLen?: number; lookback?: number; maxItems?: number } = {},
): Array<{ title: string; url: string; excerpt: string; publishedAt?: string }> {
  const { minLen = 8, lookback = 400, maxItems = 60 } = opts;
  const articles: Array<{
    title: string;
    url: string;
    excerpt: string;
    publishedAt?: string;
  }> = [];
  // 匹配 <a> 整标签：捕获 attrs（含 href/title）+ 内部文本。title 取开标签属性（权威，避免"有效"等状态文本混入）
  const aRe = /<a([^>]+)>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = aRe.exec(html)) !== null) {
    const attrs = m[1];
    const inner = m[2];
    const href = (attrs.match(/href=["']([^"']*)["']/) || [])[1];
    if (!href || !/post_\d+\.html/.test(href)) continue;
    const titleAttr = (attrs.match(/title=["']([^"']*)["']/) || [])[1];
    const text = strip(inner);
    const title = titleAttr || text;
    if (!title || title.length < minLen || title.length > 200) continue;

    // 日期可能在链接前(lookback，兼容 gz-gov 等日期前置结构)，
    // 也可能在链接后同 <li> 内(统计局列表 `<span>YYYY-MM-DD</span>` 在 </a> 之后，超出原 +120)。
    // 将上下文上界扩展到当前 <li> 结束(而非固定 +120)，确保捕获链接后日期，
    // 同时不越界到下一个 <li> 误取其他条目日期；仍取窗口内最后一个日期(即本条目日期)。
    const liEnd = html.indexOf("</li>", m.index);
    const ctxEnd = liEnd >= 0 ? liEnd : m.index + 400;
    const ctx = html.slice(Math.max(0, m.index - lookback), ctxEnd);
    const dates = ctx.match(/20\d\d[-/]\d{1,2}[-/]\d{1,2}/g);
    const publishedAt = dates ? dateToIso(dates[dates.length - 1]) || undefined : undefined;

    articles.push({
      title,
      url: href,
      excerpt: "",
      ...(publishedAt ? { publishedAt } : {}),
    });
    if (articles.length >= maxItems) break;
  }
  return articles;
}

/** 把相对链接拼成绝对 URL */
export function absUrl(href: string, base: string): string {
  if (!href) return href;
  if (/^https?:\/\//i.test(href)) return href;
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}
