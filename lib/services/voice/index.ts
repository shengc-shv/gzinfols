/**
 * 语音服务 C8：口播稿拼装（自 gzinfo lib/audio/audio.ts 移植口径，纯函数、零副作用）。
 *
 * 与 gzinfo 对齐的口径（2026-09-11 版）：
 *  - 章节字数上限：hero 90 / must_read 250 / insights 520 / ipo 150 / risk 90 / stock 520；
 *  - 总时长目标 3:00 ~ 4:10（SCRIPT_MAX_CHARS = 250s × 5.2 字/秒 ≈ 1300 字）；
 *  - 股市段吃「总上限 − 已拼 − 收尾」的剩余额度，自适应让位；
 *  - 消毒（URL/Markdown/易碎符号/句界粘连清理）+ 句界截断（不念半句）；
 *  - 任何失败不阻断发布：全部章节缺失 → null（页面不出播放器）。
 *
 * 与 gzinfo 的差异（后续 parity 项，见 docs 差分清单）：
 *  - gzinfo 的 spoken_* 分稿由 executive-summary LLM 同次产出并持久化；2.0 暂从
 *    DailyReport 已有字段（hero_line/must_read/insights/risk）拼装，口径一致；
 *  - 广东IPO 段用 gzinfo 同款「进度词表 + guangdong 注册表」双层判定（确定性、免 LLM）；
 *    事件记忆库（同一企业 2 天口播去重）尚未移植，属 memory 差分项；
 *  - 股市段挂钩 StockRecap（C10 落地后自动接入），未产出时跳过该段（gzinfo 同款降级）。
 */
import type { DailyReport, ReportItem, StockRecap } from "../../contracts/report";
// 广东企业注册表（纯数据模块，与卡面判定同源；类型由 lib/guangdong.d.mts 提供）
import { isGuangdongEnterprise } from "../../guangdong.mjs";

/** 播放器元数据：renderHtml 注入 sticky 播放器时使用。 */
export interface AudioMeta {
  /** 站点相对路径（site/audio/briefing-<date>.mp3） */
  src: string;
  /** 展示用时长文案（如「约 2 分 0 秒」） */
  duration: string;
  /** 合成后端：tencent=腾讯云合成，piper=开源 Piper 本地合成 */
  backend?: "tencent" | "piper";
}

/** 音频段落：与 HTML 卡片 data-audio-ref 对应，timeupdate 驱动高亮（v2 联动的数据基座）。 */
export interface AudioSegment {
  id: string;
  startSec: number;
  durationSec: number;
  /** 该段提到的文章 URL 列表（供关联卡片） */
  refs: string[];
  text: string;
}

export interface AudioBuildResult {
  script: string;
  parts: Record<string, string>;
  durationSec: number;
  segments: AudioSegment[];
}

/**
 * 各章节口播字数上限（gzinfo 2026-09-11 版：上限 4 分 10 秒，为 7 条洞察 + 股市段腾预算）。
 */
export const AUDIO_SPEAK_LIMITS = {
  hero: 90,
  must_read: 250,
  insights: 520,
  ipo: 150,
  risk: 90,
  stock: 520,
} as const;

/** 总时长目标窗口（秒）：3 分 00 ~ 4 分 10。 */
export const AUDIO_DURATION_MIN_SEC = 180;
export const AUDIO_DURATION_MAX_SEC = 250;

// v2：去掉「行长」等称呼；「今天播报结束。」收尾，不下命令。
const OPENER = "早上好。";
const CLOSER = "今天播报结束。";
/** 广东IPO 段过渡语（2026-09-10 修正：口播窗口实为 2 天，「近两日」与卡面一致）。 */
const IPO_TRANSITION = "近两日有IPO动态的广东企业。";
/** 中文 TTS 语速估算（字/秒）：腾讯 Speed=1（1.2 倍）实测约 5.3 字/秒，取 5.2（2026-08-24 校准）。 */
const CHARS_PER_SEC = 5.2;
/** 全稿字数硬上限 = 时长上限 × 语速（250s × 5.2 ≈ 1300 字）。 */
export const SCRIPT_MAX_CHARS = Math.round(AUDIO_DURATION_MAX_SEC * CHARS_PER_SEC);

/**
 * IPO 进展词表（gzinfo lib/output/render/cards.ts IPO_PROGRESS_RE 逐字移植）。
 * 口径纪律：与卡面判定共用同一份词表，避免「播报与卡片两套正则漂移」。
 */
export const IPO_PROGRESS_RE =
  /注册生效|同意注册|IPO注册|首次公开发行|过会|上会|上市委|提交注册|注册申请|辅导备案|IPO辅导|辅导验收|招股|申购|路演|敲钟|新股上市|递表|拟上市|发行审核|发行注册|注册制上市|IPO已?受理|IPO已?问询/;

/** 去除 URL / Markdown / 链接 / 易碎符号，保留可朗读纯文本。 */
export function sanitize(t: string): string {
  if (!t) return "";
  let s = t;
  s = s.replace(/https?:\/\/\S+/g, ""); // 链接
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); // markdown 链接 → 文字
  s = s.replace(/[#*_`~>|]/g, ""); // 易碎符号
  s = s.replace(/^\s*[-+\d.、]\s*/gm, ""); // 列表前缀
  s = s.replace(/\n{2,}/g, "\n").trim();
  // 清理句界粘连（如「客户。；第二」「A，。B」）避免断句符号叠加
  s = s.replace(/([。！？])[；;]/g, "$1");
  s = s.replace(/[；;]([。！？])/g, "$1");
  s = s.replace(/，。/g, "。");
  s = s.replace(/。，/g, "，");
  return s;
}

/** 在句界（。！？；）截断到 limit 内，避免字数超限时断在半句。 */
export function truncateAtSentence(text: string, limit: number): string {
  const hard = Math.round(limit * 1.05);
  if (text.length <= hard) return text;
  const cut = text.slice(0, hard);
  for (let i = cut.length - 1; i >= 0; i--) {
    if ("。！？；".includes(cut[i])) return cut.slice(0, i + 1);
  }
  return cut;
}

export function estimateDurationSec(chars: number): number {
  return Math.max(1, Math.round(chars / CHARS_PER_SEC));
}

export function formatDuration(secs: number): string {
  if (secs < 60) return `约 ${secs} 秒`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `约 ${m} 分 ${s} 秒`;
}

/**
 * 从 IPO 板块条目挑出广东企业线索（gzinfo detectGdIpo 同款双层判定）：
 * 「粤」标优先（side-output 结构化条目标记），进度词表 + guangdong 注册表兜底
 * （「粤芯半导体：注册申请材料已受理」这类无地域字样的广东企业不漏）。
 */
export function detectGdIpo(ipoItems: ReportItem[]): string[] {
  const out: string[] = [];
  for (const it of ipoItems) {
    const title = it.title_cn || "";
    const summary = it.summary || "";
    const text = `${title} ${summary}`.trim();
    const isGd = it.tags?.includes("粤") || (IPO_PROGRESS_RE.test(text) && isGuangdongEnterprise(text));
    if (isGd && text) {
      out.push(text.slice(0, 200));
      if (out.length >= 5) break;
    }
  }
  return out;
}

/**
 * 拼装口播稿：从 DailyReport 已有章节拼装 → 消毒/句界截断 → 段落时序。
 * 全部内容段缺失时返回 null（调用方降级：页面不出播放器、不阻断发布）。
 */
export function assembleBriefingScript(
  report: DailyReport,
  opts: { stockRecap?: StockRecap | null } = {},
): AudioBuildResult | null {
  const parts: string[] = [OPENER];
  const partMap: Record<string, string> = {};
  const segments: AudioSegment[] = [];
  let cursor = estimateDurationSec(OPENER.length);
  let found = 0;

  segments.push({ id: "intro", startSec: 0, durationSec: cursor, refs: [], text: OPENER });

  // —— 今日定调（hero_line）——
  const hero = sanitize(report.hero_line ?? "");
  if (hero) {
    const t = truncateAtSentence(hero, AUDIO_SPEAK_LIMITS.hero);
    const segText = `先看今日定调。${t}`;
    parts.push(segText);
    partMap.hero = t;
    const dur = estimateDurationSec(segText.length);
    segments.push({ id: "hero", startSec: cursor, durationSec: dur, refs: [], text: segText });
    cursor += dur;
    found++;
  }

  // —— 今日必读（title + why）——
  const mrTexts = (report.must_read ?? [])
    .map((m) => sanitize(`${m.title ?? ""}。${m.why}`.replace(/^。/, "")))
    .filter(Boolean)
    .map((t) => truncateAtSentence(t, 70));
  if (mrTexts.length) {
    const t = truncateAtSentence(mrTexts.join(""), AUDIO_SPEAK_LIMITS.must_read);
    const segText = `接下去看今日必读。${t}`;
    parts.push(segText);
    partMap.must_read = t;
    const dur = estimateDurationSec(segText.length);
    const mrUrls = (report.must_read ?? []).map((m) => m.url).filter(Boolean);
    segments.push({ id: "must", startSec: cursor, durationSec: dur, refs: mrUrls, text: segText });
    cursor += dur;
    found++;
  }

  // —— 商机洞察（topic + impact + action）——
  const insTexts = (report.insights ?? [])
    .map((i) => sanitize(`${i.topic}。${i.impact}。${i.action}`))
    .filter(Boolean)
    .map((t) => truncateAtSentence(t, 80));
  if (insTexts.length) {
    const t = truncateAtSentence(insTexts.join(""), AUDIO_SPEAK_LIMITS.insights);
    const segText = `接下去是商机洞察。${t}`;
    parts.push(segText);
    partMap.insights = t;
    const dur = estimateDurationSec(segText.length);
    const insightUrls = (report.insights ?? [])
      .flatMap((i) => (i.sources ?? []).map((s) => s.url))
      .filter(Boolean);
    segments.push({ id: "insight", startSec: cursor, durationSec: dur, refs: insightUrls, text: segText });
    cursor += dur;
    found++;
  }

  // —— 风险预警（M 层，30s 预算；当日无风险 → 跳过）——
  const riskRaw = report.risk
    ? sanitize(`${report.risk.topic}。${report.risk.impact}。${report.risk.action}`)
    : "";
  if (riskRaw) {
    const t = truncateAtSentence(riskRaw, AUDIO_SPEAK_LIMITS.risk);
    const segText = `接下去是风险预警。${t}`;
    parts.push(segText);
    partMap.risk = t;
    const dur = estimateDurationSec(segText.length);
    const riskUrls = (report.risk?.sources ?? []).map((s) => s.url).filter(Boolean);
    segments.push({ id: "risk", startSec: cursor, durationSec: dur, refs: riskUrls, text: segText });
    cursor += dur;
    found++;
  }

  if (found === 0) {
    console.warn("⚠️ 定调/必读/洞察/风险口播内容全部缺失，无法生成语音播报（降级：页面不出播放器）");
    return null;
  }

  // —— 广东IPO：确定性拼装（进度词表 + 注册表双层判定，免 LLM；与卡面同一候选池口径）——
  const ipoItems = report.sections.ipo ?? [];
  const clues = detectGdIpo(ipoItems);
  if (clues.length) {
    const joined = clues
      .map((c) => truncateAtSentence(c, 50))
      .join("。");
    let ipo = truncateAtSentence(joined, AUDIO_SPEAK_LIMITS.ipo);
    ipo = ipo
      .replace(/^(?:另外[，,]?\s*)?(?:关注(?:一条)?)?广东IP[ＯO]?[^。：:]*[。：:]?\s*/, "")
      .trim();
    const segText = `${IPO_TRANSITION}${ipo}`;
    parts.push(segText);
    partMap.guangdong_ipo = ipo;
    const dur = estimateDurationSec(segText.length);
    segments.push({ id: "ipo", startSec: cursor, durationSec: dur, refs: [], text: segText });
    cursor += dur;
  }

  // —— 股市解读（挂钩 StockRecap；C10 落地后自动接入，未产出时跳过——gzinfo 同款降级）——
  const stockRecap = opts.stockRecap ?? report.stock_recap ?? null;
  if (stockRecap) {
    const ms = stockRecap.marketStatus;
    const dataDate = ms?.dataDate || stockRecap.quoteDate || "";
    const stockIntro = dataDate ? `下面是${dataDate}股市收盘信息。` : "下面是股市收盘信息。";
    // 预算：最后一个内容段吃「总上限 − 已拼 − 收尾」的剩余额度（gzinfo 同款自适应让位）。
    const usedChars = parts.join("").length + stockIntro.length;
    const stockBudget = Math.max(
      0,
      Math.min(AUDIO_SPEAK_LIMITS.stock, SCRIPT_MAX_CHARS - usedChars - CLOSER.length),
    );
    const markets: Array<{ key: "us" | "aShare" | "hk"; label: string }> = [
      { key: "us", label: "美股" },
      { key: "aShare", label: "A股" },
      { key: "hk", label: "港股" },
    ];
    const segs: string[] = [];
    for (const m of markets) {
      const body = sanitize(stockRecap[m.key]?.spoken ?? "");
      if (!body) continue;
      const prefixed = `${m.label}：${body.replace(/[。.]+$/, "")}`;
      segs.push(truncateAtSentence(prefixed, Math.floor(stockBudget / 3)));
    }
    if (segs.length) {
      const combined = truncateAtSentence(segs.join("。"), stockBudget) + "。";
      const segText = `${stockIntro}${combined}`;
      parts.push(segText);
      partMap.stock_recap = combined;
      const dur = estimateDurationSec(segText.length);
      segments.push({ id: "stock", startSec: cursor, durationSec: dur, refs: [], text: segText });
      cursor += dur;
      found++;
    }
  }

  parts.push(CLOSER);
  const script = parts.join("\n");
  const durationSec = estimateDurationSec(script.length);

  if (script.length > SCRIPT_MAX_CHARS) {
    console.warn(`::warning:: 口播稿 ${script.length} 字，超出 ${SCRIPT_MAX_CHARS} 字上限（约 4 分 10 秒）`);
  }
  if (durationSec < AUDIO_DURATION_MIN_SEC - 10 || durationSec > AUDIO_DURATION_MAX_SEC + 5) {
    console.warn(
      `::warning:: 估算音频时长 ${durationSec}s 超出目标窗口（${AUDIO_DURATION_MIN_SEC}~${AUDIO_DURATION_MAX_SEC}s），请检查口播稿字数`,
    );
  }

  return { script, parts: partMap, durationSec, segments };
}
