/**
 * 口播跨段收敛（A+C，2026-09-25 用户反馈「听起来重复较多」）。
 *
 * 锁四件事：
 *  1. 收敛规则本身（R1 定调↔必读点题 / R2 必读↔商机去事实复述）与两条**反例**
 *     （同机构不同事件不得收敛 —— 09-23 实证的误伤风险）；
 *  2. **不删条**：收敛只压缩单条内部文本，条数 1:1 不变（否则破坏卡面↔口播对齐）；
 *  3. 幂等 / 不 mutate / 缺省 spoken_* 不凭空生成；
 *  4. `syncNarration` 的逐条拼接口径在下沉到 `voice/speech-lines.ts` 后**逐字未变**（重构回归锁）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { condenseSpeech, echoesHero, formatOverlapLog } from "../lib/services/voice/condense";
import {
  INSIGHT_CONNECTORS,
  MR_CONNECTORS,
  endSentence,
  insightSpeechLine,
  mustReadSpeechLine,
} from "../lib/services/voice/speech-lines";
import { assembleBriefingScript, truncateAtSentence } from "../lib/services/voice";
import { syncNarration } from "../lib/pipeline/side-outputs/side-exec-summary";
import type { ExecutiveSummary } from "../lib/services/enrich/executive-summary";
import type { DailyReport } from "../lib/contracts/report";

const U = (n: string) => `https://example.com/${n}`;

/** 镜像 2026-09-25 真实形态：定调与必读#2/#3 同源（共享数字锚点）、必读#2/#3 与商机#1 同源（同 URL）。 */
function exec(): ExecutiveSummary {
  return {
    hero_line: "美联储10月加息概率已逼近七成，部分美元存款利率超过4%，美元理财业绩基准跟着抬升。",
    spoken_hero: "美联储10月加息概率已逼近七成，建议梳理美元产品货架。",
    must_read: [
      { title: "上海推银行业AI应用措施", why: "科技条线可关注同业落地路径", url: U("ai") },
      { title: "美元存款利率超4%", why: "外币产品定价空间打开", url: U("usd") },
      { title: "美联储10月加息概率近七成", why: "美元资产波动加大", url: U("fed") },
    ],
    insights: [
      {
        topic: "美元货架与结汇窗口",
        impact: "美元存款利率超4%、理财基准抬升",
        action: "本周梳理美元存款与理财货架",
        segments: ["零售AUM"],
        sources: [{ title: "t", url: U("usd") }],
      },
      {
        topic: "私募高净值配置动向",
        impact: "存续规模达25.75万亿元",
        action: "梳理存量私行客户持仓",
        sources: [{ title: "t", url: U("pe") }],
      },
      {
        topic: "含权理财控回撤配置",
        impact: "9月理财规模高增、含权类为扩容主力",
        action: "主推控回撤型含权产品",
        segments: ["零售AUM"],
        sources: [{ title: "t", url: U("fund") }],
      },
    ],
  };
}

function report(): DailyReport {
  return {
    date: "2026-09-25",
    hero_line: "",
    must_read: [],
    insights: [],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  } as unknown as DailyReport;
}

test("① R1 定调↔必读：共享数字锚点的必读条目，口播压成点题（why 让位给定调）", () => {
  const synced = syncNarration(exec());
  assert.ok(synced.spoken_must_read?.includes("外币产品定价空间打开"), "收敛前 why 在稿中");
  const { exec: out, stats } = condenseSpeech(synced);
  assert.equal(stats.heroEchoes, 2, "必读#2（4%）与 #3（10月）均与定调同源");
  assert.ok(out.spoken_must_read?.includes("美元存款利率超4%。"), "title 必须保留（点题）");
  assert.ok(!out.spoken_must_read?.includes("外币产品定价空间打开"), "why 已被剥离");
  assert.ok(!out.spoken_must_read?.includes("美元资产波动加大"), "第二条 why 同样被剥离");
  // 与定调无关的那条**不得**被顺手压缩
  assert.ok(out.spoken_must_read?.includes("上海推银行业AI应用措施。科技条线可关注同业落地路径。"), "非同源条目保持完整");
});

test("② R1 反例：只共享机构（@央行）的不同事件不得收敛 —— 09-23 实证的误伤", () => {
  // 09-23 真实形态：定调讲「央行重申适度宽松」，必读另有「央行在港发行 600 亿央票」。
  // 两者共享 @央行 却是不同事件；若用 @ 判定会误删解读。
  assert.equal(
    echoesHero("央行重申适度宽松与双向开放，7天逆回购操作加量", { title: "央行在港发行600亿央票", why: "离岸人民币流动性管理" }),
    false,
    "只共享机构名 → 不是同一事件",
  );
  assert.equal(
    echoesHero("美联储10月加息概率已逼近七成，部分美元存款利率超过4%", { title: "美元存款利率超4%", why: "定价空间打开" }),
    true,
    "共享数字锚点 #4% → 同一事件（同日真实形态）",
  );
});

test("③ R2 必读↔商机：同源 URL 的商机口播只留动作（impact 的事实复述让位）", () => {
  const synced = syncNarration(exec());
  const { exec: out, stats } = condenseSpeech(synced);
  assert.equal(stats.insightEchoes, 1, "仅商机#1 与必读同源（same URL）");
  assert.ok(out.spoken_insights?.includes("美元货架与结汇窗口"), "topic 保留（读者要知道讲的是哪件事）");
  assert.ok(out.spoken_insights?.includes("本周梳理美元存款与理财货架"), "action 保留（商机的独有价值）");
  assert.ok(!out.spoken_insights?.includes("美元存款利率超4%、理财基准抬升"), "impact（与必读重复的事实）已剥离");
  // 不同源的两条不得被压缩
  assert.ok(out.spoken_insights?.includes("存续规模达25.75万亿元"), "非同源商机的 impact 保持完整");
  assert.ok(out.spoken_insights?.includes("9月理财规模高增、含权类为扩容主力"), "同上");
});

test("④ 读完后不能把某条念成空句：标题为空则放弃收敛（宁可漏收敛，不可误删）", () => {
  const synced = syncNarration({ ...exec(), must_read: [{ title: "", why: "只有解读没有标题", url: U("x") }] });
  const { exec: out, stats } = condenseSpeech({ ...synced, hero_line: "美联储10月加息概率逼近七成，4%利率" });
  // title 为空 → 剥掉 why 会念出空句 → 本层跳过，原样保留
  assert.equal(stats.savedChars, 0, "无标题的条目不得被压成空句");
  assert.ok(out.spoken_must_read?.length, "稿子仍在");
});

test("⑤ 不删条：收敛只压缩单条内部文本，条数与顺序均不变（卡面↔口播 1:1 依赖它）", () => {
  const ex = exec();
  const synced = syncNarration(ex);
  const { exec: out } = condenseSpeech(synced);
  // 每条 title / topic 都必须在稿中出现，且出现顺序与数组顺序一致
  let cursor = -1;
  for (const m of ex.must_read) {
    const at = out.spoken_must_read!.indexOf(m.title);
    assert.ok(at > cursor, `必读「${m.title}」须保留且顺序不变`);
    cursor = at;
  }
  cursor = -1;
  for (const it of ex.insights) {
    const at = out.spoken_insights!.indexOf(it.topic);
    assert.ok(at > cursor, `商机「${it.topic}」须保留且顺序不变`);
    cursor = at;
  }
  assert.equal((out.spoken_insights!.match(/美元货架与结汇窗口/g) ?? []).length, 1, "不得产生重复条目");
});

test("⑥ 幂等 + 不 mutate 入参（纯函数约定）", () => {
  const synced = syncNarration(exec());
  const snapshot = JSON.stringify(synced);
  const once = condenseSpeech(synced);
  assert.equal(JSON.stringify(synced), snapshot, "入参不得被改写");
  const twice = condenseSpeech(once.exec);
  assert.equal(twice.stats.savedChars, 0, "再收敛一次无可省（幂等）");
  assert.equal(twice.exec.spoken_insights, once.exec.spoken_insights);
});

test("⑦ 边界：spoken_* 缺省时不得凭空生成（生成口径只归 syncNarration）", () => {
  const bare: ExecutiveSummary = { hero_line: "美联储10月加息概率逼近七成", must_read: exec().must_read, insights: exec().insights };
  const { exec: out, stats } = condenseSpeech(bare);
  assert.equal(out.spoken_must_read, undefined, "缺省不生成");
  assert.equal(out.spoken_insights, undefined);
  assert.equal(stats.savedChars, 0);
  assert.ok(formatOverlapLog(stats).includes("未发现同源重复"), "日志口径可读");
});

test("⑧ 重构回归锁：syncNarration 的逐条拼装逐字未变（connector 轮换 / 客群前缀 / 句末唯一句号）", () => {
  const ex = exec();
  const out = syncNarration(ex);
  const expectedMr =
    mustReadSpeechLine(ex.must_read[0], "") +
    mustReadSpeechLine(ex.must_read[1], MR_CONNECTORS[0]) +
    mustReadSpeechLine(ex.must_read[2], MR_CONNECTORS[1]);
  assert.equal(out.spoken_must_read, expectedMr);
  const expectedIns =
    insightSpeechLine(ex.insights[0], "") +
    insightSpeechLine(ex.insights[1], INSIGHT_CONNECTORS[0]) +
    insightSpeechLine(ex.insights[2], "最后，");
  assert.equal(out.spoken_insights, expectedIns);
  // 口径细节：客群段读作「零售 A U M」（逐字母，TTS 需要）；句末恰好一个句号
  assert.ok(expectedIns.startsWith("具备零售 A U M商机的，"));
  assert.ok(!out.spoken_insights!.includes("。。"), "不得出现双句号");
  assert.equal(endSentence("已有句号。"), "已有句号。");
  assert.equal(endSentence("  "), "", "空串不产出孤立句号");
});

test("⑨ 端到端：成稿变短、带 speechOverlap 统计，且剥离后的文本不再出现在稿里", async () => {
  // 生产链路里 exec 进 assembleBriefingScript 前**已过 syncNarration**（buildExecutiveSummary 收口），
  // 故此处同样先派生，才与线上形态一致。
  const ex = syncNarration(exec());
  const b = await assembleBriefingScript(report(), { exec: ex });
  assert.ok(b);
  assert.ok(b.speechOverlap, "必须回报收敛统计（此前口播重复完全不可观测）");
  assert.equal(b.speechOverlap!.savedChars > 0, true);
  assert.ok(!b.script.includes("外币产品定价空间打开"), "R1 剥离项不出现在成稿");
  assert.ok(!b.script.includes("美元存款利率超4%、理财基准抬升"), "R2 剥离项不出现在成稿");
  assert.ok(b.script.includes("本周梳理美元存款与理财货架"), "动作仍在");
});

test("⑪ 游标前向匹配：两条 impact 文本相同时，删中的必须是「同源那一条」", () => {
  // 隐患：若用 indexOf 从头找，两条 impact 文案相同（LLM 偶发）时会误删**前一条**的解读。
  const same = "同样的影响描述";
  const ex: ExecutiveSummary = {
    hero_line: "",
    must_read: [{ title: "某事件", why: "解读", url: U("dup") }],
    insights: [
      { topic: "第一条", impact: same, action: "动作一", sources: [{ title: "t", url: U("other") }] },
      { topic: "第二条", impact: same, action: "动作二", sources: [{ title: "t", url: U("dup") }] },
    ],
  };
  const synced = syncNarration(ex);
  const { exec: out, stats } = condenseSpeech(synced);
  assert.equal(stats.insightEchoes, 1, "只有第二条同源");
  const text = out.spoken_insights!;
  assert.equal((text.match(new RegExp(same, "g")) ?? []).length, 1, "只该剩一条 impact");
  assert.ok(text.indexOf(same) < text.indexOf("第二条"), "留下来的必须是**前一条**（非同源那条）的 impact");
  assert.ok(text.includes("动作一") && text.includes("动作二"), "两条 action 均保留");
});

test("⑩ C 项：先收敛再截断 —— 原本被 520 软上限砍掉的末条商机得以保留", async () => {
  const long = (n: number) => "文".repeat(n);
  const must = [1, 2, 3, 4].map((i) => ({ title: long(8) + i, why: long(10), url: U(`m${i}`) }));
  const insights = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({
    topic: `主题${i}号内容`,
    impact: long(40),
    action: long(34),
    segments: [] as string[],
    // 前 4 条与必读同源 → 收敛会把它们的 impact（与必读重复的事实）剥掉
    sources: [{ title: "t", url: U(`m${i}`) }],
  }));
  const synced = syncNarration({ hero_line: "关注零售条线机会", spoken_hero: "关注零售条线机会。", must_read: must, insights });

  // 收敛前：超软上限（520 × 1.05 = 546），末条被截掉 —— 这正是 09-25 「粤芯半导体」被砍的机制
  const naive = truncateAtSentence(synced.spoken_insights!, 520);
  assert.ok(!naive.includes("主题8号内容"), "收敛前末条被截断（复现原缺陷）");

  const b = await assembleBriefingScript(report(), { exec: synced });
  assert.ok(b);
  assert.ok(b.parts.insights!.includes("主题8号内容"), "收敛腾出预算后，末条新信息不再被砍");
  assert.equal(b.speechOverlap!.insightEchoes, 4);
});
