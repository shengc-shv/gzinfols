/**
 * Strip the LLM's chatty wrapping (markdown code fences, "Here is the JSON:"
 * preamble) and return just the balanced JSON payload starting at the first
 * `{` or `[`.
 *
 * 关键修复：旧实现用「第一个 `{` → 最后一个 `}`」截取，对**裸数组**提示
 * （如 PASS1/PASS2 把文章/保留条目以 `[{...},...]` 注入）完全失效——数组元素
 * 自带 `{`，会把「首个元素 `{」到「末尾示例 `{"items":[...]}` 的 `}`」之间的整段
 * 非 JSON 文本一起截出，导致 JSON.parse 失败。现改为从最靠前的 `{`/`[` 起做
 * 括号平衡扫描，命中即返回，对对象与数组都正确（含嵌套）。
 *
 * Does NOT validate parsability — callers still pipe the result through
 * JSON.parse with a jsonrepair fallback for unescaped-quote issues.
 */
export function extractJson(raw: string): string {
  let text = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  if (fence) text = fence[1].trim();

  const firstBrace = text.indexOf("{");
  const firstBrack = text.indexOf("[");
  let start = -1;
  if (firstBrace === -1) start = firstBrack;
  else if (firstBrack === -1) start = firstBrace;
  else start = Math.min(firstBrace, firstBrack);
  if (start === -1) return text;

  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  // 未找到匹配的闭合符（畸形输入）→ 退回原样，交由调用方 jsonrepair/报错
  return text;
}
