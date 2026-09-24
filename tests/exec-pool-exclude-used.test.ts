/**
 * 定调补位「排除当天已用事件」（2026-09-24 用户要求）。
 *
 * 背景（实证 09-24）：定调「美联储10月加息概率逼近七成…」判重命中后从两天池补位，
 * 补位只按「分行关联度」挑、**不检查该事件是否已在当天其他板块讲过** —— 结果选中
 * 「中小银行压降网贷规模 助贷行业适配新规重塑合作模式」，而同一事件当天已在
 * **风险预警 + 商机洞察**里各出现一次（同一件事在一期报告里讲了 3 遍）。
 *
 * 本测试锁住三条语义：
 *   ① 判据双路：URL 规范化后相等 / 标题 bigram Dice ≥ `USED_EVENT_TITLE_DICE`
 *      （阈值刻意保守：只认「几乎同题」，多家改写报道由 URL 主判据兜）；
 *   ② 补位避让：池内与当天板块同事件的候选被跳过，改选独立事件；
 *   ③ 红线不变：池内已无「未被当日使用」的候选时**放宽排除**照常补位
 *      （宁可与别处重复，也不让定调留空）—— 日志须留下放宽痕迹。
 *
 * 全部 fixture 的时间戳均显式带 +08:00（时间红线：不得出现无发布时间的条目）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyMemoryGuard,
  collectUsedEvents,
  isUsedEvent,
  type GuardPoolItem,
} from "../lib/services/memory/exec-guard";
import {
  beginDay,
  emptyMemory,
  rememberBroadcast,
  settleTodayIntoEvents,
} from "../lib/services/memory/event-memory";
import { USED_EVENT_TITLE_DICE } from "../lib/services/memory/event-types";
import type { ExecutiveSummary } from "../lib/services/enrich/executive-summary";

const TODAY = "2026-09-24";
const YEST = "2026-09-23";
const AT = (d: string) => `${d}T08:00:00+08:00`;
const NOW = new Date("2026-09-24T08:00:00+08:00");

/** 09-24 实际被去重的定调（当日稍早在别处已播过同一事件 → 判重命中）。 */
const HERO = "美联储10月加息概率逼近七成，美元存款利率超4%，广州分行外币货架与结售汇窗口同步打开。";

/** 当天风险预警的来源链接（池内同事件条目就是靠它被识别出来的）。 */
const RISK_URL = "https://www.cnfin.com/hg-lb/detail/20260923/4473809_1.html";
const RISK_URL_WITH_NOISE = "https://www.cnfin.com/hg-lb/detail/20260923/4473809_1.html?utm_source=wechat";

/** 被判重命中的定调（含历史）——其余三个板块来自 09-24 真实产出（已脱敏为最小字段）。 */
function mkExec(): ExecutiveSummary {
  return {
    hero_line: HERO,
    must_read: [{ title: "上海楼市已止跌回稳", why: "住房金融条线关注度上升", url: "https://finance.eastmoney.com/a/202609233882370195.html" }],
    insights: [
      {
        topic: "助贷合作方适配排查",
        impact: "消费贷条线获客与分润结构或调整。",
        action: "风控部牵头排查存量助贷合作方适配进度。",
        sources: [
          {
            title: "助贷行业适配新规重塑合作模式",
            url: "https://finance.sina.com.cn/money/bank/bank_hydt/2026-09-23/doc-inisuaap8653732.shtml",
          },
          { title: "中小银行压降网贷规模 助贷行业适配新规重塑合作模式", url: RISK_URL },
        ],
      },
    ],
    risk: {
      topic: "助贷新规重塑合作模式",
      evidence: "助贷新规推动合作模式重塑，中小银行压降网贷规模。",
      impact: "消费贷条线获客与分润结构或调整。",
      action: "风控部应牵头排查存量助贷合作方适配进度。",
      sources: [
        {
          title: "助贷行业适配新规重塑合作模式",
          url: "https://finance.sina.com.cn/money/bank/bank_hydt/2026-09-23/doc-inisuaap8653732.shtml",
        },
        { title: "中小银行压降网贷规模 助贷行业适配新规重塑合作模式", url: RISK_URL },
      ],
    },
  };
}

/** 池内与当天板块同事件的条目（URL 与 risk.sources 相同 → 必须被排除）。 */
const POOL_USED: GuardPoolItem = {
  title: "中小银行压降网贷规模 助贷行业适配新规重塑合作模式",
  summary: "助贷新规推动合作模式重塑，中小银行压降网贷规模，存量合作方合规适配进度不一。",
  url: RISK_URL_WITH_NOISE, // 带追踪参数：验证 URL 规范化判据（不被 query 噪声绕过）
};

/** 池内独立事件（当天其他板块都没讲 → 应被选中）。 */
const POOL_FRESH: GuardPoolItem = {
  title: "广州首单净土贷落地 绿色信贷路径打通",
  summary: "广州落地首单净土贷，土壤治理类绿色信贷路径打通，本地环保与城投类客户融资需求显现。",
  url: "https://example.com/gz-soil-green-loan",
};

/** 构造「昨天已播过 HERO」的记忆库（结算进 events，供今天判重命中）。 */
function storeWithHeroHistory() {
  let store = emptyMemory();
  store = rememberBroadcast(store, {
    cand: { title: HERO, text: "" },
    section: "hero",
    date: YEST,
    novelty: 1,
    broadcastAt: AT(YEST),
  });
  return settleTodayIntoEvents(store, YEST);
}

// ---------------------------------------------------------------------------
// ① 判据
// ---------------------------------------------------------------------------

test("collectUsedEvents：收集 must_read / insights / risk 的标题与 URL，但不含 hero 自身", () => {
  const used = collectUsedEvents(mkExec());
  assert.ok(used.titles.includes("上海楼市已止跌回稳"), "必读标题应被收集");
  assert.ok(used.titles.includes("助贷合作方适配排查"), "商机 topic 应被收集");
  assert.ok(used.titles.includes("助贷新规重塑合作模式"), "风险 topic 应被收集");
  assert.ok(used.urls.size >= 2, "必读/风险的 URL 应被收集");
  assert.equal(
    isUsedEvent(used, "任一标题", RISK_URL),
    true,
    "风险来源 URL 纳入清单（收集时已规范化，故带 www 的原样 URL 也能命中）",
  );
  assert.ok(
    !used.titles.some((t) => t.startsWith("美联储10月加息")),
    "hero 自身不入清单 —— 它就是被去重的那条，不该阻止自己的补位",
  );
});

test("isUsedEvent：URL 规范化后相等即命中（www / 追踪参数 / 尾斜杠不放过）", () => {
  const used = collectUsedEvents(mkExec());
  assert.equal(isUsedEvent(used, "任意标题", RISK_URL), true, "同 URL 命中");
  assert.equal(isUsedEvent(used, "任意标题", RISK_URL_WITH_NOISE), true, "带 utm 参数仍命中");
  assert.equal(
    isUsedEvent(used, "任意标题", "https://www.cnfin.com/hg-lb/detail/20260923/4473809_1.html"),
    true,
    "www 前缀差异仍命中",
  );
  assert.equal(isUsedEvent(used, "任意标题", "https://example.com/other"), false, "无关 URL 不命中");
});

test("isUsedEvent：标题路只认「几乎同题」（阈值刻意保守）", () => {
  const used = { urls: new Set<string>(), titles: ["美联储10月加息概率逼近七成"] };
  // Dice = 20/26 ≈ 0.77 ≥ 阈值 → 视为同一事件的多家报道
  assert.equal(isUsedEvent(used, "美联储10月加息概率升至七成"), true);
  assert.equal(isUsedEvent(used, "广州首单净土贷落地 绿色信贷路径打通"), false, "无关标题不命中");
});

test("阈值保守性：同一事件的两家报道若改写幅度大，标题路**不**命中（由 URL 兜底）", () => {
  // 实测 Dice = 18/32 = 0.5625 < 0.7 —— 记录当前口径：标题路宁可漏，不误杀
  const used = { urls: new Set<string>(), titles: ["中小银行压降网贷规模 助贷行业适配新规重塑合作模式"] };
  assert.ok(USED_EVENT_TITLE_DICE === 0.7, "阈值须与漏斗层 dedup-similar 同口径");
  assert.equal(
    isUsedEvent(used, "助贷新规重塑合作模式"),
    false,
    "改写幅度大时不命中（这类靠 URL 判据拦，避免误杀独立候选）",
  );
});

// ---------------------------------------------------------------------------
// ② 补位避让
// ---------------------------------------------------------------------------

test("补位避让：定调判重命中后，跳过当天其他板块已用的事件，改选独立事件", () => {
  const g = applyMemoryGuard({
    exec: mkExec(),
    store: storeWithHeroHistory(),
    today: TODAY,
    // 池内同事件条目按关联度排在前（分数高于 fresh），旧行为会选中它
    pool: [POOL_USED, POOL_FRESH],
    now: NOW,
  });

  assert.ok(
    g.exec.hero_line?.startsWith("今日分行焦点："),
    `定调判重命中后应由池内补位（实际：${g.exec.hero_line}）`,
  );
  assert.ok(
    g.exec.hero_line?.includes("净土贷"),
    `应改选独立事件（实际：${g.exec.hero_line}）`,
  );
  assert.ok(
    !g.exec.hero_line?.includes("中小银行"),
    "不得再选「当天风险预警/商机已讲过」的同一事件",
  );
  const line = g.log.find((l) => l.includes("改写") || l.includes("补位")) ?? "";
  assert.ok(line.includes("改用池内新事件补位"), `补位日志缺失：${g.log.join(" | ")}`);
  assert.ok(
    !line.includes("放宽排除条件"),
    "池内还有独立候选时不该触发放宽",
  );
});

// ---------------------------------------------------------------------------
// ③ 红线：宁可重复，不让定调留空
// ---------------------------------------------------------------------------

test("红线：池内已无「未被当日使用」的候选 → 放宽排除照常补位，并留痕", () => {
  const g = applyMemoryGuard({
    exec: mkExec(),
    store: storeWithHeroHistory(),
    today: TODAY,
    pool: [POOL_USED], // 唯一候选与当天板块同事件
    now: NOW,
  });

  assert.ok(
    g.exec.hero_line?.startsWith("今日分行焦点："),
    "定调永不空：即便只能选到与别处重复的事件，也必须补位",
  );
  const line = g.log.find((l) => l.includes("补位")) ?? "";
  assert.ok(
    line.includes("放宽排除条件"),
    `放宽时必须留痕（实际日志：${g.log.join(" | ")}）`,
  );
});

test("回归：池内无候选时仍保留原定调（既有行为不变）", () => {
  const g = applyMemoryGuard({
    exec: mkExec(),
    store: storeWithHeroHistory(),
    today: TODAY,
    pool: [],
    now: NOW,
  });
  assert.equal(g.exec.hero_line, HERO, "无池可补 → 保留原定调（宁可重复，不留空）");
  assert.ok(
    g.log.some((l) => l.includes("但池内无新事件可补")),
    `应留下「无新事件可补」日志：${g.log.join(" | ")}`,
  );
});

test("回归：beginDay 只结算跨天暂存，历史事件用于判重", () => {
  const store = beginDay(storeWithHeroHistory(), TODAY);
  assert.ok(Object.keys(store.events ?? {}).length > 0, "昨日暂存应已结算进 events");
  assert.equal(store.today?.entries.length, 0, "新的一天暂存区应清空");
});
