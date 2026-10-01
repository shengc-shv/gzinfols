/**
 * SEC EDGAR HTML 文档 → 纯文本抽取适配器（美股红筹源专用）。
 *
 * 为什么需要它：港交所申请版本是 PDF（走 `pdf-text.ts` / unpdf），而 SEC EDGAR 的
 * F-1 主文档是 **HTML**（`formf-1.htm`，2~8MB）——unpdf 不适用。本模块用
 * 正则去标签 + 实体反转义抽取纯文本，供 `classifyProject` 的封面注册地句式与
 * 广东词频判定复用（与 PDF 抽取产物同构：纯文本串）。
 *
 * 2026-10-01 实测（LYC HEALTHCARE (CAYMAN) LTD 的 F-1，2.5MB）：抽取 58 万字符，
 * 封面注册地句式 `incorporated in the Cayman Islands` 命中 —— 与 `extractDomicile`
 * 的 COVER_COMPACT 正则完全匹配，判定链路无需改动。
 *
 * 失败口径：任何异常返回空串（判定侧因此标 `unverified`，宁缺毋滥——与 pdf-text 一致）。
 */

/** HTML → 纯文本（去标签 / 去 script / style / 注释 / 实体反转义 / 空白规整）。 */
export function htmlToText(raw: string): string {
  if (!raw) return "";
  try {
    // 1. 去掉 script/style/注释块（避免把 JS 文案算进词频）
    let s = raw.replace(/<script[\s\S]*?<\/script>/gi, " ");
    s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
    s = s.replace(/<!--[\s\S]*?-->/g, " ");
    // 2. 去标签：块级换行保留，其余替换为空格
    s = s.replace(/<\/(p|div|tr|h[1-6]|li|table|section|br)>/gi, "\n");
    s = s.replace(/<br\s*\/?>/gi, "\n");
    s = s.replace(/<[^>]+>/g, " ");
    // 3. 实体反转义（&amp; &nbsp; 等）
    s = s.replace(/&nbsp;/gi, " ");
    s = s.replace(/&amp;/gi, "&");
    s = s.replace(/&lt;/gi, "<");
    s = s.replace(/&gt;/gi, ">");
    s = s.replace(/&quot;/gi, '"');
    s = s.replace(/&#39;/gi, "'");
    s = s.replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
    // 4. 空白规整
    s = s.replace(/[ \t]+/g, " ").replace(/\n\s+/g, "\n");
    return s.trim();
  } catch {
    return "";
  }
}

/** 从 URL 下载并抽取文本（失败返回空串，判定侧降级 unverified）。 */
export async function extractEdgarHtmlText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        // SEC 官方要求可辨识的 UA（EDGAR 限流策略会拒绝裸浏览器 UA）。
        "User-Agent":
          "gzinfols-local/1.0 (local redchip us sync; contact: admin@example.com)",
      },
    });
    if (!res.ok) return "";
    const raw = await res.text();
    return htmlToText(raw);
  } catch {
    return "";
  }
}
