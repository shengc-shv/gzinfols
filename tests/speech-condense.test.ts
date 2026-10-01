/**
 * 口播跨段收敛（2026-09-25 立项 A+C；**2026-09-28 起只保留 R2**）。
 *
 * 锁四件事：
 *  1. R2 必读↔商机去事实复述 —— **安全网角色**：只在「商机口播照抄了卡面 impact」时才动手；
 *     2026-10-01 起口播句式含「一句影响」，同源商机的 impact 与必读重复时即由本层剥离，
 *     剥完只留「{客群}方面，{主题}」，**不删条**；
 *  2. ⛔ **R1（定调↔必读点题）已删除** —— 回归锁：定调含必读标题时，必读 why 不得被剥；
 *  3. **不删条**：收敛只压缩单条内部文本，每条 topic/title 仍必须出现在稿中；
 *  4. 幂等 / 不 mutate / 缺省 spoken_* 不凭空生成 / 分端口径（必读 1:1、商机归并）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { condenseSpeech, formatOverlapLog } from "../lib/services/voice/condense";
import {
  MR_CONNECTORS,
  endSentence,
  groupedInsightsSpeech,
  mustReadSpeechLine,
} from "../lib/services/voice/speech-lines";
import { assembleBriefingScript } from "../lib/services/voice";
import { syncNarration } from "../lib/pipeline/side-outputs/side-exec-summary";
import type { ExecutiveSummary } from "../lib/services/enrich/executive-summary";
import type { DailyReport } from "../lib/contracts/report";

const U = (n: string) => `https://example.com/${n}`;

/** 镜像 2026-09-25 真实形态：必读#2 与商机#1 同源（同 URL）。 */
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

test("① R2 必读↔商机：同源条目的 impact 复述被剥离（只剩「客群 + 主题」）", () => {
  const synced = syncNarration(exec());
  const withImpact: ExecutiveSummary = {
    ...synced,
    spoken_insights:
      "第一，零售 A U M方面，美元货架与结汇窗口，美元存款利率超4%、理财基准抬升。" +
      "第二，其他机会方面，私募高净值配置动向，存续规模达25.75万亿元。",
  };
  const { exec: out, stats } = condenseSpeech(withImpact);
  assert.equal(stats.insightEchoes, 1, "仅商机#1 与必读同源（same URL）");
  assert.ok(out.spoken_insights?.includes("美元货架与结汇窗口"), "topic 保留（读者要知道讲的是哪件事）");
  assert.ok(!out.spoken_insights?.includes("美元存款利率超4%、理财基准抬升"), "impact（与必读重复的事实）已剥离");
  assert.ok(out.spoken_insights?.includes("存续规模达25.75万亿元"), "非同源商机的 impact 保持完整");
  assert.ok(!/窗口，。|窗口，$/.test(out.spoken_insights ?? ""), "剥离时不留下悬空逗号");
  assert.ok(out.spoken_insights?.includes("第二，其他机会方面，私募高净值配置动向"), "条数不减");
});

test("② ⛔ R1 回归锁（2026-09-28 实证）：定调含必读标题时，必读 why 不得被剥", () => {
  // 09-28 实测：定调维度含「公募基金规模达39.63万亿」→ 与必读共享硬事实 `#39.63万亿`
  // → 旧 R1 命中 → why 被剥，必读只剩光秃秃标题（车里听的行领导就此丢掉「为什么重要」）。
  // R1 已删除，本测试守住「不得复活」。
  const ex = syncNarration({
    hero_line: "今天主要看三个方面：公募基金规模达39.63万亿，节前配置；基金代销与客户陪伴；楼市带看回温。",
    spoken_hero: "今天主要看三个方面：公募基金规模达39.63万亿，节前配置；基金代销与客户陪伴；楼市带看回温。",
    must_read: [
      {
        title: "公募基金规模达39.63万亿",
        why: "居民资金持续向净值型产品迁移，基金代销与客户陪伴是零售AUM增长的主要抓手。",
        url: U("fund"),
      },
    ],
    insights: [],
  });
  const { exec: out, stats } = condenseSpeech(ex);
  assert.ok(
    out.spoken_must_read?.includes("居民资金持续向净值型产品迁移"),
    "why 必须完整保留（定调含同名维度不构成「重复」）",
  );
  assert.equal(stats.savedChars, 0, "不应有任何剥离");
  assert.ok(formatOverlapLog(stats).includes("未发现同源重复"));
});

test("③ 游标前向匹配：两条 impact 文本相同时，删中的必须是「同源那一条」", () => {
  // 隐患：若用 indexOf 从头找，两条 impact 文案相同（LLM 偶发）时会误删**前一条**的解读。
  const same = "同样的影响描述";
  const ex: ExecutiveSummary = {
    hero_line: "",
    spoken_insights: `第一条，${same}。第二条，${same}。`,
    must_read: [{ title: "某事件", why: "解读", url: U("dup") }],
    insights: [
      { topic: "第一条", impact: same, sources: [{ title: "t", url: U("other") }] },
      { topic: "第二条", impact: same, sources: [{ title: "t", url: U("dup") }] },
    ],
  };
  const { exec: out, stats } = condenseSpeech(ex);
  assert.equal(stats.insightEchoes, 1, "只有第二条同源");
  const text = out.spoken_insights!;
  assert.equal((text.match(new RegExp(same, "g")) ?? []).length, 1, "只该剩一条 impact");
  assert.ok(text.indexOf(same) < text.indexOf("第二条"), "留下来的必须是**前一条**（非同源那条）的 impact");
  assert.ok(text.includes("第一条") && text.includes("第二条"), "两条 topic 均保留（不删条）");
});

test("④ 不删条：收敛只压缩单条内部文本，每条 topic/title 仍必须出现在稿中", () => {
  const ex = exec();
  const synced = syncNarration(ex);
  const { exec: out } = condenseSpeech(synced);
  for (const m of ex.must_read) {
    assert.ok(out.spoken_must_read!.includes(m.title), `必读「${m.title}」须保留`);
  }
  for (const it of ex.insights) {
    assert.ok(out.spoken_insights!.includes(it.topic!), `商机「${it.topic}」须保留`);
  }
  assert.equal((out.spoken_insights!.match(/美元货架与结汇窗口/g) ?? []).length, 1, "不得产生重复条目");
});

test("⑤ 幂等 + 不 mutate 入参（纯函数约定）", () => {
  const synced = syncNarration(exec());
  const snapshot = JSON.stringify(synced);
  const once = condenseSpeech(synced);
  assert.equal(JSON.stringify(synced), snapshot, "入参不得被改写");
  const twice = condenseSpeech(once.exec);
  assert.equal(twice.stats.savedChars, 0, "再收敛一次无可省（幂等）");
  assert.equal(twice.exec.spoken_insights, once.exec.spoken_insights);
});

test("⑥ 边界：spoken_* 缺省时不得凭空生成（生成口径只归 syncNarration）", () => {
  const bare: ExecutiveSummary = { hero_line: "美联储10月加息概率逼近七成", must_read: exec().must_read, insights: exec().insights };
  const { exec: out, stats } = condenseSpeech(bare);
  assert.equal(out.spoken_must_read, undefined, "缺省不生成");
  assert.equal(out.spoken_insights, undefined);
  assert.equal(stats.savedChars, 0);
  assert.ok(formatOverlapLog(stats).includes("未发现同源重复"), "日志口径可读");
});

test("⑦ 分端口径回归锁：必读逐条 1:1、商机按客群归并（各有单一实现）", () => {
  const ex = exec();
  const out = syncNarration(ex);
  const expectedMr =
    mustReadSpeechLine(ex.must_read[0], "") +
    mustReadSpeechLine(ex.must_read[1], MR_CONNECTORS[0]) +
    mustReadSpeechLine(ex.must_read[2], MR_CONNECTORS[1]);
  assert.equal(out.spoken_must_read, expectedMr, "必读：逐条拼接（句子级 1:1）");
  assert.equal(out.spoken_insights, groupedInsightsSpeech(ex.insights), "商机：按客群归并");
  assert.ok(out.spoken_insights!.startsWith("第一，零售 A U M方面，"), "归并稿以客群标签开头");
  assert.ok(!out.spoken_insights!.includes("。。"), "不得出现双句号");
  assert.equal(endSentence("已有句号。"), "已有句号。");
  assert.equal(endSentence("  "), "", "空串不产出孤立句号");
});

test("⑧ 端到端：必读解读完整保留、同源商机只留「客群 + 主题」，统计对象可观测", async () => {
  // 生产链路里 exec 进 assembleBriefingScript 前**已过 syncNarration**，故此处同样先派生。
  const ex = syncNarration(exec());
  const b = await assembleBriefingScript(report(), { exec: ex });
  assert.ok(b);
  assert.ok(b.speechOverlap, "必须回报收敛统计对象（可观测性）");
  assert.equal(b.speechOverlap!.insightEchoes, 1, "商机#1 与必读#2 同源（same URL）");
  assert.ok(b.speechOverlap!.savedChars > 0, "同源 → 其 impact 复述被剥离");
  assert.ok(b.script.includes("外币产品定价空间打开"), "必读 why 完整保留（R1 已删，不再被剥）");
  assert.ok(b.script.includes("美元资产波动加大"), "第二条 why 同样保留");
  assert.ok(b.script.includes("美元货架与结汇窗口"), "商机主题在（不删条）");
  assert.ok(!b.script.includes("本周梳理美元存款与理财货架"), "2026-10-01：action 不再进口播");
  assert.ok(!b.script.includes("。。"), "不得出现双句号");
});

test("⑨ 商机口播归并后不再触发 280 字截断（原逐条 520 上限会砍掉末条）", async () => {
  const long = (n: number) => "文".repeat(n);
  const must = [1, 2, 3, 4].map((i) => ({ title: long(8) + i, why: long(10), url: U(`m${i}`) }));
  const insights = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({
    topic: `主题${i}号内容`,
    impact: long(40),
    action: long(34),
    segments: [] as string[],
    sources: [{ title: "t", url: U(`m${i}`) }],
  }));
  const synced = syncNarration({
    hero_line: "关注零售条线机会",
    spoken_hero: "今天主要看两个方面：零售条线机会、财富货架调整。",
    must_read: must,
    insights,
  });
  const b = await assembleBriefingScript(report(), { exec: synced });
  assert.ok(b);
  assert.ok(b.parts.insights!.includes("主题1号内容"), "首条主题在（8 条同属一组 → 概括为「主题1号内容等8条线索」）");
  assert.ok(b.parts.insights!.length < 200, `归并后远低于 280 上限（实际 ${b.parts.insights!.length} 字）`);
});
