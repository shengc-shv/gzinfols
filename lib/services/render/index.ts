/**
 * 渲染服务 C7：把 DailyReport 渲染为「单文件 HTML + Markdown」。
 *
 * 设计原则：
 *  - 纯函数，零副作用（不读写磁盘，由 scripts 负责落盘）。
 *  - 自包含：CSS 内联、tab 切换用极简内联 JS，无外部依赖、无网络。
 *  - 结构对齐 gzinfo 已跑通的简报版面：Hero 定调 → 今日必读 → 商机洞察 → 5 板块 tab → 今日风险。
 *  - 所有用户文本经 esc() 转义，杜绝标题/摘要里的 HTML 注入。
 */
import type {
  DailyReport,
  ReportInsight,
  ReportItem,
  ReportMustRead,
  ReportSectionKey,
  RiskItem,
} from "../../contracts/report";
import { SECTION_LABELS, SECTION_ORDER } from "../../contracts/report";
import type { SourceTier } from "../../contracts/source";

export interface RenderOptions {
  title?: string;
  /** 站点根（用于 latest 链接，可选）。 */
  siteRoot?: string;
  /** 音频元数据（TTS 成功时注入 sticky 播放器；缺省无播放器）。 */
  audio?: { src: string; duration: string; backend?: string };
}

/** tab 顺序与标签由契约层常量派生（单一真源，不重复定义）。 */
const SECTION_META: Array<{ key: ReportSectionKey; label: string }> = SECTION_ORDER.map(
  (key) => ({ key, label: SECTION_LABELS[key] }),
);

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function tierBadge(tier?: SourceTier): string {
  if (!tier) return "";
  const map: Record<string, { cls: string; text: string }> = {
    T1: { cls: "t1", text: "官方一手" },
    T1_5: { cls: "t15", text: "准官方" },
    T2: { cls: "t2", text: "媒体" },
  };
  const m = map[String(tier).toUpperCase().replace(".", "_")] ?? map["T2"];
  return `<span class="badge ${m.cls}">${m.text}</span>`;
}

function localeBadge(locale?: string): string {
  if (locale === "gz") return `<span class="badge gz">广州</span>`;
  if (locale === "overseas") return `<span class="badge ov">海外</span>`;
  if (locale === "national") return `<span class="badge na">全国</span>`;
  return "";
}

function itemCard(it: ReportItem): string {
  const imp = it.importance >= 3 ? " top" : "";
  const tags = (it.tags ?? [])
    .map((t) => `<span class="tag">${esc(t)}</span>`)
    .join("");
  const meta = [
    esc(it.source),
    tierBadge(it.tier),
    `<span class="date">${esc(it.date)}</span>`,
    localeBadge(it.locale),
  ].join(" ");
  return `
    <article class="card${imp}">
      <h3><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title_cn)}</a></h3>
      <div class="meta">${meta}</div>
      <p class="sum">${esc(it.summary)}</p>
      ${tags ? `<div class="tags">${tags}</div>` : ""}
    </article>`;
}

function mustReadBlock(items: ReportMustRead[]): string {
  if (!items.length) return "";
  const cards = items
    .map(
      (m) => `
      <div class="mr">
        <span class="mr-why">${esc(m.why)}</span>
        <a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title ?? m.url)}</a>
      </div>`,
    )
    .join("");
  return `<section class="block must"><h2>今日必读</h2>${cards}</section>`;
}

function insightsBlock(items: ReportInsight[]): string {
  if (!items.length) return "";
  const cards = items
    .map((ins) => {
      const segs = (ins.segments ?? []).map((s) => `<span class="seg">${esc(s)}</span>`).join("");
      const srcs = (ins.sources ?? [])
        .map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`)
        .join("、");
      return `
      <div class="ins">
        <h4>${esc(ins.topic)}</h4>
        <p><b>影响：</b>${esc(ins.impact)}</p>
        <p><b>动作：</b>${esc(ins.action)}</p>
        ${segs ? `<div class="tags">${segs}</div>` : ""}
        ${srcs ? `<div class="srcs">来源：${srcs}</div>` : ""}
      </div>`;
    })
    .join("");
  return `<section class="block ins-block"><h2>商机洞察</h2>${cards}</section>`;
}

function riskBlock(risk?: RiskItem): string {
  if (!risk) return "";
  return `
    <section class="block risk">
      <h2>今日风险</h2>
      <div class="ins">
        <h4>${esc(risk.topic)}</h4>
        <p><b>证据：</b>${esc(risk.evidence)}</p>
        <p><b>影响：</b>${esc(risk.impact)}</p>
        <p><b>动作：</b>${esc(risk.action)}</p>
      </div>
    </section>`;
}

const CSS = `
:root{--bg:#f7f8fa;--card:#fff;--ink:#1f2329;--muted:#6b7280;--line:#e5e7eb;--brand:#b01e2e;--accent:#1d4ed8;}
*{box-sizing:border-box;}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--ink);line-height:1.6;}
header{padding:28px 24px 18px;background:linear-gradient(135deg,#7f1d1d,#b01e2e);color:#fff;}
header .date{font-size:13px;opacity:.85;}
header .hero{font-size:20px;font-weight:600;margin-top:6px;}
.wrap{max-width:920px;margin:0 auto;padding:0 16px 60px;}
.block{margin-top:22px;}
.block h2{font-size:16px;border-left:4px solid var(--brand);padding-left:8px;margin:0 0 10px;}
.mr{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:8px;background:#fffaf0;}
.mr-why{display:block;color:var(--muted);font-size:13px;margin-bottom:2px;}
.mr a{color:var(--brand);font-weight:600;text-decoration:none;}
.ins{border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:10px;background:var(--card);}
.ins h4{margin:0 0 6px;color:var(--accent);}
.ins p{margin:4px 0;font-size:14px;}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:24px 0 14px;position:sticky;top:0;background:var(--bg);padding:8px 0;z-index:5;}
.tab{border:1px solid var(--line);background:var(--card);border-radius:18px;padding:6px 14px;cursor:pointer;font-size:14px;color:var(--muted);}
.tab.active{background:var(--brand);color:#fff;border-color:var(--brand);}
.panel{display:none;}
.panel.active{display:block;}
.card{border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:12px;background:var(--card);}
.card.top{border-left:4px solid var(--brand);}
.card h3{margin:0 0 6px;font-size:16px;}
.card h3 a{color:var(--ink);text-decoration:none;}
.card h3 a:hover{color:var(--brand);}
.meta{font-size:12px;color:var(--muted);display:flex;gap:6px;flex-wrap:wrap;align-items:center;}
.sum{margin:8px 0 0;font-size:14px;}
.tags{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;}
.tag,.seg{background:#eef2ff;color:#3730a3;font-size:12px;padding:2px 8px;border-radius:10px;}
.seg{background:#ecfdf5;color:#047857;}
.srcs{margin-top:6px;font-size:12px;color:var(--muted);}
.badge{font-size:11px;padding:1px 7px;border-radius:9px;}
.badge.t1{background:#fde2e2;color:#b01e2e;}
.badge.t15{background:#e0ecff;color:#1d4ed8;}
.badge.t2{background:#f1f1f1;color:#555;}
.badge.gz{background:#fff7e6;color:#b45309;}
.badge.na{background:#eef2f7;color:#475569;}
.badge.ov{background:#f3e8ff;color:#7e22ce;}
.date{font-variant-numeric:tabular-nums;}
.audio-bar{position:fixed;bottom:0;left:0;right:0;display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.96);border-top:1px solid var(--line);padding:8px 16px;z-index:20;backdrop-filter:blur(4px);}
.audio-label{font-size:13px;color:var(--muted);white-space:nowrap;}
.audio-bar audio{flex:1;height:32px;}
.wrap{padding-bottom:80px !important;}
`;

/** 渲染单文件 HTML 报告。 */
export function renderHtml(report: DailyReport, opts: RenderOptions = {}): string {
  const title = opts.title ?? `某股分行每日资信简报 · ${report.date}`;
  const tabsNav = SECTION_META.map(
    (s, i) =>
      `<button class="tab${i === 0 ? " active" : ""}" data-tab="${s.key}">${s.label}</button>`,
  ).join("");
  const panels = SECTION_META.map((s, i) => {
    const items = report.sections[s.key] ?? [];
    const body = items.length
      ? items.map(itemCard).join("")
      : `<p class="meta">本板块今日暂无条目。</p>`;
    return `<div class="panel${i === 0 ? " active" : ""}" id="panel-${s.key}">${body}</div>`;
  }).join("");

  const js = `
    document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>{
      document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(x=>x.classList.remove('active'));
      t.classList.add('active');
      document.getElementById('panel-'+t.dataset.tab).classList.add('active');
    }));`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <div class="date">${esc(report.date)}</div>
  ${report.hero_line ? `<div class="hero">${esc(report.hero_line)}</div>` : ""}
</header>
<div class="wrap">
  ${mustReadBlock(report.must_read)}
  ${insightsBlock(report.insights)}
  <div class="tabs">${tabsNav}</div>
  ${panels}
  ${riskBlock(report.risk)}
</div>
${audioBar(opts.audio)}
<script>${js}</script>
</body>
</html>`;
}

/** sticky 音频播放器条（TTS 成功时注入；gzinfo 播放器口径的轻量版，段落联动高亮待 render 对齐时移植）。 */
function audioBar(audio?: { src: string; duration: string; backend?: string }): string {
  if (!audio) return "";
  const badge = audio.backend ? `（${esc(audio.backend === "tencent" ? "腾讯云" : "本地合成")}）` : "";
  return `
<div class="audio-bar">
  <span class="audio-label">🔊 语音播报 ${esc(audio.duration)}${badge}</span>
  <audio controls preload="none" src="${esc(audio.src)}"></audio>
</div>`;
}

/** 渲染 Markdown 报告（便于归档 / 公众号 / 邮件）。 */
export function renderMarkdown(report: DailyReport): string {
  const out: string[] = [];
  out.push(`# 某股分行每日资信简报 · ${report.date}`);
  if (report.hero_line) out.push(`> ${report.hero_line}`);
  out.push("");

  if (report.must_read.length) {
    out.push("## 今日必读");
    for (const m of report.must_read)
      out.push(`- [${m.title ?? m.url}](${m.url}) — ${m.why}`);
    out.push("");
  }
  if (report.insights.length) {
    out.push("## 商机洞察");
    for (const ins of report.insights) {
      out.push(`### ${ins.topic}`);
      out.push(`- 影响：${ins.impact}`);
      out.push(`- 动作：${ins.action}`);
      if (ins.segments?.length) out.push(`- 客群：${ins.segments.join("、")}`);
    }
    out.push("");
  }
  for (const s of SECTION_META) {
    const items = report.sections[s.key] ?? [];
    out.push(`## ${s.label}`);
    if (!items.length) {
      out.push("_本板块今日暂无条目。_");
    } else {
      for (const it of items)
        out.push(
          `${it.rank}. [${it.title_cn}](${it.url}) — ${it.summary}（${it.source} · ${it.date}）`,
        );
    }
    out.push("");
  }
  if (report.risk) {
    out.push("## 今日风险");
    out.push(`- **${report.risk.topic}**`);
    out.push(`- 证据：${report.risk.evidence}`);
    out.push(`- 影响：${report.risk.impact}`);
    out.push(`- 动作：${report.risk.action}`);
  }
  return out.join("\n");
}
