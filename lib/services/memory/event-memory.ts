/**
 * 内容记忆与去重（Content Memory & De-duplication）
 * ============================================================================
 * 解决的问题：
 *   每日抓取的新闻源高度重复。同一事件（如「房贷期限从 30 年延长至 40 年」）
 *   会在未来数周持续产生大量报道。若连续多天口播同一新闻，行长会觉得系统
 *   不专业；但完全屏蔽后续报道，又会漏掉真实进展（如政策落地、细则出台、
 *   银行跟进、数据验证）。
 *
 * 设计要点：
 *   1. 事件级记忆：基于「事件指纹 + 主题标签」去重，而非文本完全匹配；
 *      记忆库持久化到 data/event-memory.json（随 CI 归档提交，跨运行生效）。
 *   2. 判定规则：量化「信息增量」，区分「新进展（progress）」与「重复表述（duplicate）」。
 *   3. 冷却与衰减：按事件类型给冷却期，冷却期随时间衰减；重大事件可打破冷却。
 *   4. 角度轮换：必须再次播报时，强制切换到未用过的切入角度。
 *   5. 板块差异化：hero / must_read / insights / risk 四板块参数互不相同。
 *   6. 兜底：候选全命中去重时分三级放宽，绝不产出空板块。
 *
 * 纯函数层（不碰 fs，便于单测）；持久化见 ./store.ts。
 */

import { eventFingerprint, dice, titleBigrams } from "../select/filters/dedup-similar";
// P2-3 收敛（2026-09-10）：口播窗常量改引全链路唯一来源（此前本文件与
// pipeline/side-outputs/gd-ipo.ts 各定义一份，值相同但是真隐患——改一处不生效）。
import { IPO_VOICE_WINDOW_DAYS } from "../../ipo-config";
// 仅引入运行时函数；broadcast-time 对本文件只做 `import type`，无循环依赖
// 2026-09-03：isTestBroadcastAt（9:00 启发式）已从结算路径退役 —— 结算闸门改为
// 「交付信号」（deliveries：人工确认推送过才算正式交付），broadcastAt 仅用于溯源/人工分区。
import { formatBroadcastAt } from "./broadcast-time";

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 2026-09-14（C-1 Phase4）：本文件拆分为 5 个职责模块，此处只做 **re-export 门面**，
// 对外 API（`services/memory` 与 `exec-guard` 等消费方的 import 路径）零变化。
// 拆分地图与依赖方向见 ./event-types.ts 头部。
// ---------------------------------------------------------------------------
export * from "./event-types";
export * from "./event-text";
export * from "./event-decide";
export * from "./event-settle";
export * from "./event-brief";
