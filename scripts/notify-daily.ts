/**
 * 简报外发：**企业微信群机器人（Webhook）** 单一通道。
 * （自 gzinfo scripts/notify-daily.ts 移植，2026-09-15；2026-09-17 移除公众号与自建应用）
 *
 * 用法：npm run notify（由 .github/workflows/notify.yml 人工触发调用）
 *
 * ⚠️ **唯一外发通道（2026-09-17 定案）**：公众号（微信测试号模板消息）与企业微信
 *    自建应用（message/send）已**永久移除**——用户确认今后不再使用。仅保留群机器人
 *    Webhook：自带 key 鉴权，不受企业可信 IP 白名单限制，从 CI 直接 POST 即可。
 *
 * ⚠️ **记忆结算闸门**：群机器人真正送达 → notify 退出 0 → notify.yml 写当日交付信号
 *    并**立即结算**进长期记忆（见 mark-delivered.ts）。未送达 → 退出 1，**不结算**
 *    （宁漏勿误：未触达客户的内容不得进记忆，否则会误冷却后续真实新闻）。
 *
 * env（CI secrets / vars）：
 *     WECOM_WEBHOOK          必填 群机器人 Webhook 完整 URL（含 ?key=）
 *     WECOM_WEBHOOK_MSGTYPE  可选 text（默认，个人微信可直接读）/ markdown（仅企业微信 App 可读）
 *     REPORT_BASE_URL        可选 报告根 URL，默认 https://shengc-shv.github.io/gzinfols
 *     REPORT_TZ              可选 报告时区，默认 Asia/Shanghai
 *
 * 数据源：history/<date>/store.json → executive.hero_line（+ guangdong_ipo.spoken 一行）
 *
 * 退出码：群机器人送达 → 0（触发结算记忆）；未配置或推送失败 → 1。
 */
import "./_env";
import fs from "node:fs";
import path from "node:path";
import {
  buildWecomMarkdown,
  buildWecomText,
  pushWecomWebhook,
} from "../lib/adapters/notify/wecom";
import { REPORT_TZ } from "../lib/utils/time";

function log(msg: string) {
  console.log(`[notify] ${msg}`);
}

/**
 * 读 store.json 的执行摘要（宽松解析，缺字段返回空，绝不抛错）。
 * - heroLine：今日定调（模板消息 / markdown 正文主体）；
 * - ipoLine：当日「广东IPO」口播稿（推送正文补一行广东IPO，
 *   否则领导必须点开简报才知道当天有没有可跟进的 IPO 商机）。
 */
function loadExecSummary(storePath: string): { heroLine: string; ipoLine: string } {
  const empty = { heroLine: "", ipoLine: "" };
  if (!fs.existsSync(storePath)) {
    log(`未找到 ${storePath}，使用默认数据`);
    return empty;
  }
  try {
    const store = JSON.parse(fs.readFileSync(storePath, "utf8")) as {
      executive?: { hero_line?: string; guangdong_ipo?: { spoken?: string } };
    };
    return {
      heroLine: store.executive?.hero_line ?? "",
      ipoLine: store.executive?.guangdong_ipo?.spoken ?? "",
    };
  } catch (e) {
    log(`store.json 解析失败，使用默认数据: ${e instanceof Error ? e.message : String(e)}`);
    return empty;
  }
}

async function pushWecomViaWebhook(cfg: {
  webhookUrl: string;
  heroLine: string;
  ipoLine?: string;
  dateStr: string;
  reportUrl: string;
}): Promise<boolean> {
  // 默认 text：markdown 在个人微信显示「暂不支持此消息类型，请在企业微信中查看」，
  // text 才能在个人微信直接阅读。想要企业微信内的富文本排版时设 WECOM_WEBHOOK_MSGTYPE=markdown。
  const msgtype = (process.env.WECOM_WEBHOOK_MSGTYPE || "text").toLowerCase() === "markdown" ? "markdown" : "text";
  const content =
    msgtype === "markdown"
      ? buildWecomMarkdown(cfg.heroLine, cfg.dateStr, cfg.reportUrl, cfg.ipoLine)
      : buildWecomText(cfg.heroLine, cfg.dateStr, cfg.reportUrl, cfg.ipoLine);
  const result = await pushWecomWebhook(cfg.webhookUrl, content, cfg.reportUrl, undefined, msgtype);
  log(`消息格式: ${msgtype}`);
  if (result.error) {
    log(`❌ 企业微信(群机器人)推送失败: ${result.error}`);
    return false;
  }
  if (result.ok) {
    log(`✅ 企业微信(群机器人)推送完成：成功 ${result.sent}`);
    return true;
  }
  log(`❌ 企业微信(群机器人)部分失败：成功 ${result.sent}/${result.targets}`);
  for (const f of result.failed) log(`   失败 ${f.userid}: ${f.reason}`);
  return false;
}

async function main(): Promise<void> {
  // 时区固定北京时间（REPORT_TZ 单一真源，不接受 env 覆盖 —— 与全项目口径一致）
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const { heroLine, ipoLine } = loadExecSummary(path.join("history", dateStr, "store.json"));
  if (heroLine) {
    log(`读取定调: ${heroLine.slice(0, 40)}${heroLine.length > 40 ? "…" : ""}`);
  }
  if (ipoLine) {
    log(`读取广东IPO: ${ipoLine.slice(0, 40)}${ipoLine.length > 40 ? "…" : ""}`);
  }

  const base = (process.env.REPORT_BASE_URL || "https://shengc-shv.github.io/gzinfols").replace(/\/+$/, "");
  const reportUrl = `${base}/${dateStr}/${dateStr}.html`;

  // 唯一外发通道：企业微信群机器人（Webhook）。公众号 / 自建应用已于 2026-09-17 移除。
  const webhookUrl = process.env.WECOM_WEBHOOK ?? "";
  if (!webhookUrl) {
    log("❌ 未配置 WECOM_WEBHOOK（群机器人 Webhook 缺失）→ 无法外发，notify 退出 1");
    process.exitCode = 1;
    return;
  }
  const okWecomWebhook = await pushWecomViaWebhook({ webhookUrl, heroLine, ipoLine, dateStr, reportUrl });

  log(`报告链接: ${reportUrl}`);

  // ⚠️ 记忆结算闸门：群机器人真正送达 → 退出 0，notify.yml 写交付信号并结算记忆；
  // 未送达 → 退出 1，不结算（宁漏勿误：未触达客户的内容不得进记忆）。
  if (okWecomWebhook) {
    log(`✅ 群机器人送达（客户渠道）→ notify 退出 0，notify.yml 将写交付信号并结算`);
  } else {
    log("❌ 群机器人未成功送达（推送失败）→ 未交付，notify 退出 1（不结算记忆）");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  log(`❌ 未捕获异常: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
