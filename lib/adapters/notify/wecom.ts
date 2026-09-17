/**
 * 企业微信消息推送 — 简报外发渠道（自 gzinfo lib/notify/wecom.ts 移植，2026-09-15）。
 *
 * ⚠️ 单一通道（2026-09-17 定案）：仅保留**群机器人 Webhook**。
 *    自建应用 message/send 与公众号已**永久移除**（用户确认不再使用）。
 *    群机器人自带 key 鉴权，不受「企业可信 IP」白名单限制，从 CI 直接 POST 即可。
 *
 * 架构定位：本文件在 **adapters 层**（唯一副作用出口）；只依赖全局 fetch，
 * 由 scripts/notify-daily.ts 编排调用。
 *
 * 设计约束：
 *   - 发送失败不中断整体（try/catch 收集 failed）
 *   - 任何阶段失败都返回 { ok:false, error }，不抛异常 → 调用方决定是否阻断
 *   - fetch 可注入（fetchImpl），测试零 mock 全局
 */

export interface WecomNotifyResult {
  ok: boolean;
  targets: number;
  sent: number;
  failed: { userid: string; reason: string }[];
  /** 整体失败原因（token/发送失败等），逐条失败则只进 failed */
  error?: string;
}

const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/**
 * 广东IPO 摘要行（可选）：把当日「广东IPO」口播稿（store.json 的
 * executive.guangdong_ipo.spoken）压缩成一行随推送发出——否则领导必须点开简报
 * 才知道当天有没有可跟进的 IPO 商机。
 */
function ipoLineOf(ipoLine?: string): string {
  const t = (ipoLine || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return `🏦 广东IPO｜${t.length > 80 ? `${t.slice(0, 80)}…` : t}`;
}

/**
 * 组装 markdown 正文（不被 40 字截断；完整定调 + 跳转链接）。
 * 企业微信 markdown 语法有限：# 标题 / **加粗** / [链接](url) / > 引用 / <font color>。
 */
export function buildWecomMarkdown(
  heroLine: string,
  dateStr: string,
  url: string,
  ipoLine?: string,
): string {
  const weekday = WEEKDAY_CN[new Date(`${dateStr}T12:00:00+08:00`).getDay()] ?? "";
  const title = "# 📢 今日分行简报已生成";
  const dateLine = `📅 ${dateStr}（${weekday}）`;
  const hero = heroLine
    ? `> **【今日定调】** ${heroLine}`
    : "> ⚠️ 今日暂无定调，点击查看完整简报";
  const ipo = ipoLineOf(ipoLine);
  const link = `[点击查看完整简报 →](${url})`;
  return [title, dateLine, "", hero, ...(ipo ? ["", ipo] : []), "", link].join("\n");
}

/**
 * 组装**纯文本**正文（群机器人默认格式）。
 *
 * 为什么需要纯文本版：微信侧不支持渲染 markdown 消息——个人微信收到 markdown 会显示
 * 「暂不支持此消息类型，请在企业微信中查看」。text 消息在个人微信可正常阅读。
 *
 * 因此面向「个人微信可见」的群机器人通道默认用 text：
 *   - 不用 # / ** / []() 等 markdown 语法（微信端会原样显示成噪音字符）
 *   - 不用 <font color> 等企业微信专属 inline html（微信端会显示成字面标签）
 *   - URL 单独一行**明文**给出 → 微信/企业微信都会自动识别为可点链接
 *   - emoji 与全角标点在两端都能正常渲染，用于保留可读性
 */
export function buildWecomText(
  heroLine: string,
  dateStr: string,
  url: string,
  ipoLine?: string,
): string {
  const weekday = WEEKDAY_CN[new Date(`${dateStr}T12:00:00+08:00`).getDay()] ?? "";
  const title = "📢 今日分行简报已生成";
  const dateLine = `📅 ${dateStr}（${weekday}）`;
  const hero = heroLine ? `【今日定调】${heroLine}` : "【今日定调】今日暂无定调，请点击下方链接查看完整简报";
  const ipo = ipoLineOf(ipoLine);
  return [
    title,
    dateLine,
    "",
    hero,
    ...(ipo ? ["", ipo] : []),
    "",
    "👉 点击查看完整简报：",
    url,
  ].join("\n");
}

/**
 * ── 群机器人 Webhook 通道（唯一保留的外发通道）──
 *
 * 报送方式：企业微信任意群 → 群设置 → 群机器人 → 添加 → 复制
 *   https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxx
 * 把整串 URL 填进 WECOM_WEBHOOK 即可，无需 corpId/agentId/secret/userIds。
 */

/**
 * 群机器人支持的消息类型。
 * - text（默认）：**个人微信可直接阅读**。markdown 消息在微信端显示「暂不支持此消息
 *   类型，请在企业微信中查看」。
 * - markdown：排版更好（标题/加粗/引用/字体色），但**只能在企业微信 App 内查看**。
 */
export type WecomWebhookMsgType = "text" | "markdown";

/** 向群机器人 webhook 发送一条消息（失败抛错）。默认 text，保证个人微信可直接阅读。 */
export async function sendWecomWebhook(
  webhookUrl: string,
  content: string,
  fetchImpl: typeof fetch = fetch,
  msgtype: WecomWebhookMsgType = "text",
): Promise<void> {
  // 群机器人两种格式的字段层级不同：text → { text: { content } }；markdown → { markdown: { content } }
  const contentBody = msgtype === "markdown" ? { markdown: { content } } : { text: { content } };
  const payload = { msgtype, ...contentBody };
  const res = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as { errcode?: number; errmsg?: string };
  if (body.errcode && body.errcode !== 0) {
    throw new Error(`企业微信群机器人发送失败(errcode=${body.errcode}): ${body.errmsg ?? JSON.stringify(body)}`);
  }
}

/** 群机器人主编排：组装正文 → 发送。 */
export async function pushWecomWebhook(
  webhookUrl: string,
  content: string,
  url: string,
  fetchImpl?: typeof fetch,
  msgtype: WecomWebhookMsgType = "text",
): Promise<WecomNotifyResult> {
  try {
    await sendWecomWebhook(webhookUrl, content, fetchImpl, msgtype);
    return { ok: true, targets: 1, sent: 1, failed: [] };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: false, targets: 1, sent: 0, failed: [{ userid: "(webhook)", reason }] };
  }
}
