/**
 * 研报解读页（2026-10-19）：把各期日报 `researchPanel` 聚合成独立主页。
 *
 * 数据来源由调用方（build-site）决定：各期 report JSON 的 `researchPanel.items`。
 * 设计口径（与 topics.html 同族）：
 *  - 浅色卡片流、系统字体、单列布局；正文 16px / 辅助 13px（手机不缩字号）；
 *  - 触摸目标 ≥44px（标题行整行可点，链接 stretched 到卡片）；
 *  - 无 JS、无外链依赖；全部文本走 esc()（标题来自外部源，防 XSS）；
 *  - 空态给「为什么空 + 什么时候会有」，不是白屏。
 */

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CSS = `
  :root { --bg:#f6f6f8; --card:#fff; --ink:#1a1a1c; --muted:#6b6b73; --line:#e4e4e9; --accent:#185fa5; }
  * { box-sizing: border-box; }
  body { margin:0; padding:20px 14px 48px; background:var(--bg); color:var(--ink);
         font:16px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; }
  .wrap { max-width:760px; margin:0 auto; }
  h1 { margin:0 0 4px; font-size:22px; letter-spacing:.3px; }
  .sub { margin:0 0 14px; font-size:13px; color:var(--muted); line-height:1.7; }
  /* 返回按钮（2026-10-19 sc：手机端必须能回来源页；其余导航一律不保留） */
  .back { display:inline-flex; align-items:center; gap:.25rem; min-height:36px; padding:6px 14px;
          margin:0 0 12px; border:1px solid var(--line); border-radius:999px; background:var(--card);
          color:var(--ink); font-size:14px; text-decoration:none; -webkit-tap-highlight-color:transparent; }
  .back:hover { border-color:var(--accent); color:var(--accent); }
  .back:active { transform:scale(.98); }
  @media (max-width:719.98px) { .back { min-height:44px; padding:8px 16px; font-size:15px; } }
  .group { margin:0 0 18px; }
  .day { display:flex; align-items:baseline; gap:8px; margin:0 0 8px; font-size:14px; color:var(--muted); font-weight:600; }
  .day .n { font-weight:400; font-size:12.5px; color:#9a9aa2; }
  .list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; }
  .item { position:relative; padding:12px 14px; background:var(--card); border:1px solid var(--line);
          border-radius:12px; }
  .item:active { background:#f2f6fb; }
  .title { color:var(--accent); text-decoration:none; font-size:16px; line-height:1.5; display:block; }
  .title::after { content:""; position:absolute; inset:0; }  /* 整卡可点 */
  .meta { margin:5px 0 0; font-size:13px; color:var(--muted); line-height:1.55; }
  .empty { padding:28px 18px; text-align:center; color:var(--muted); font-size:14px;
           background:var(--card); border:1px dashed var(--line); border-radius:12px; line-height:1.8; }
  footer { margin-top:22px; font-size:12px; color:#9a9aa2; line-height:1.8; }
  @media (max-width:719.98px) {
    body { padding:16px 12px 40px; }
    .item { padding:13px 14px; }  /* 手机端再放宽触摸区 */
    .title { font-size:16.5px; }
  }
`;

function itemHtml(it) {
  const meta = [it.org, it.researchers, it.industry].filter(Boolean).map(esc).join(" · ");
  return `<li class="item">
      <a class="title" href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a>
      <p class="meta">${meta}${meta ? " ｜ " : ""}${esc(String(it.publishedAt).slice(5))}</p>
    </li>`;
}

export function renderResearchPage({ reports, generatedAt, latest }) {
  const list = Array.isArray(reports) ? reports : [];
  const total = list.reduce((n, r) => n + (r.items || []).length, 0);
  const groups = list
    .map(
      (r) => `<section class="group">
      <h2 class="day">${esc(r.date)}<span class="n">${(r.items || []).length} 篇</span></h2>
      <ul class="list">${(r.items || []).map(itemHtml).join("")}</ul>
    </section>`,
    )
    .join("");
  const empty = `<div class="empty">本期尚未收录研报。<br>研报参考区在每日管线中自动抓取，下一期日报发布后即可查看。</div>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>研报解读 · 每日资信简报</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <a class="back" href="${latest ? `./${esc(latest)}/${esc(latest)}.html` : "./index.html"}" onclick="if(document.referrer&&document.referrer.indexOf(location.host)>=0){history.back();return false;}">← 返回</a>
  <h1>📐 研报解读</h1>
  <p class="sub">券商研报索引 · 覆盖 ${list.length} 期 · 共 ${total} 篇${generatedAt ? ` · 生成于 ${esc(generatedAt)}` : ""}<br>仅作深度参考，点击标题查看原文。</p>
  ${total ? groups : empty}
  <footer>研报标题与机构信息来自公开研报索引；本页不构成投资建议。</footer>
</div>
</body>
</html>
`;
}
