/**
 * PDF 文本抽取适配器（实网模式用；样本模式不调用）。
 * 依赖 unpdf —— 抽取失败返回空串（判定侧会因此标 unverified，宁缺毋滥）。
 */
export async function extractPdfText(url: string): Promise<string> {
  try {
    const res = await fetch(url);
    if (!res.ok) return "";
    const buf = new Uint8Array(await res.arrayBuffer());
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(buf);
    const { text } = await extractText(pdf, { mergePages: true });
    return text ?? "";
  } catch {
    return "";
  }
}
