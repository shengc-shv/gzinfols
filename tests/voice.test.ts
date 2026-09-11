import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assembleBriefingScript,
  sanitize,
  truncateAtSentence,
  detectGdIpo,
  AUDIO_SPEAK_LIMITS,
  SCRIPT_MAX_CHARS,
} from "../lib/services/voice";
import type { DailyReport } from "../lib/contracts/report";
import type { ExecutiveSummary } from "../lib/services/enrich/executive-summary";

/** gzinfo 口径：口播稿只消费 exec 的 spoken_*（syncNarration 由卡面 1:1 确定性派生）。 */
function exec(over: Partial<ExecutiveSummary> = {}): ExecutiveSummary {
  return {
    hero_line: "科技与政策共振，关注银行数字化机会。",
    spoken_hero: "科技与政策共振，关注银行数字化机会，建议评估对客产品影响。",
    spoken_must_read: "某行发布 AI 中台。财富管理效率提升。",
    spoken_insights: "具备零售A U M商机的，AI 中台，提升运营效率。关注相关客户需求。",
    must_read: [{ url: "https://example.com/a", title: "某行发布 AI 中台", why: "财富管理效率提升" }],
    insights: [
      { topic: "AI 中台", tag: [], impact: "提升运营效率", action: "关注相关客户需求", sources: [{ title: "t", url: "https://example.com/a" }] },
    ],
    ...over,
  };
}

function report(over: Partial<DailyReport> = {}): DailyReport {
  return {
    date: "2026-09-11",
    hero_line: "科技与政策共振，关注银行数字化机会。",
    must_read: [{ url: "https://example.com/a", title: "某行发布 AI 中台", why: "财富管理效率提升" }],
    insights: [
      { topic: "AI 中台", tag: [], impact: "提升运营效率", action: "关注相关客户需求", sources: [{ title: "t", url: "https://example.com/a" }] },
    ],
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [] },
    ...over,
  } as DailyReport;
}

test("口播稿：章节引导语 + 收尾语 + 段落时序（gzinfo 口径）", async () => {
  const b = await assembleBriefingScript(report(), { exec: exec() });
  assert.ok(b);
  assert.ok(b.script.startsWith("早上好。"), "开场白");
  assert.ok(b.script.includes("先看今日定调。"));
  assert.ok(b.script.includes("接下去看今日必读。"));
  assert.ok(b.script.includes("接下去是商机洞察。"));
  assert.ok(b.script.endsWith("今天播报结束。"), "收尾语");
  assert.ok(b.script.includes(b.parts.must_read!));
  // 段落起点单调递增
  for (let i = 1; i < b.segments.length; i++) {
    assert.ok(b.segments[i].startSec >= b.segments[i - 1].startSec);
  }
});

test("口播稿：全部章节缺失 → null（降级为无播放器，不阻断发布）", async () => {
  const empty = report({ hero_line: undefined, must_read: [], insights: [] });
  assert.equal(await assembleBriefingScript(empty), null, "无 exec → 不产口播");
  // exec 存在但 spoken_* 全空 → 同样降级 null（gzinfo：口播只认 spoken_*）
  const emptyExec = exec({ spoken_hero: undefined, spoken_must_read: undefined, spoken_insights: undefined, must_read: [], insights: [] });
  assert.equal(await assembleBriefingScript(empty, { exec: emptyExec }), null);
});

test("口播稿：无 TTS 内容但 hero 存在 → 有稿；risk 段接入（exec.spoken_risk）", async () => {
  const withRisk = exec({
    spoken_risk: "今天有 1 个需要警惕：模型风险，合规压力。加强内控。",
    risk: { topic: "模型风险", evidence: "治理不足", impact: "合规压力", action: "加强内控" },
  });
  const b = await assembleBriefingScript(report(), { exec: withRisk });
  assert.ok(b);
  assert.ok(b.script.includes("接下去是风险预警。"));
  assert.ok(b.parts.risk);
});

test("口径锁定：章节预算与总时长上限为 gzinfo 2026-09-11 版（4 分 10 秒）", async () => {
  assert.equal(AUDIO_SPEAK_LIMITS.hero, 90);
  assert.equal(AUDIO_SPEAK_LIMITS.must_read, 250);
  assert.equal(AUDIO_SPEAK_LIMITS.insights, 520);
  assert.equal(AUDIO_SPEAK_LIMITS.ipo, 150);
  assert.equal(AUDIO_SPEAK_LIMITS.risk, 90);
  assert.equal(AUDIO_SPEAK_LIMITS.stock, 520);
  assert.equal(SCRIPT_MAX_CHARS, 1300); // 250s × 5.2
});

test("sanitize：URL / 易碎符号 / 句界粘连清理（gzinfo 原版行为）", async () => {
  assert.equal(sanitize("详见 https://x.com/a 的报道"), "详见  的报道");
  assert.equal(sanitize("# 标题 *重点*"), "标题 重点");
  assert.equal(sanitize("客户。；第二，。第三"), "客户。第二。第三");
});

test("truncateAtSentence：句界截断不念半句", async () => {
  const t = "第一句。第二句。第三句。";
  assert.equal(truncateAtSentence(t, 6), "第一句。");
  assert.equal(truncateAtSentence(t, 60), t, "不超限不截断");
});

test("detectGdIpo：「粤」标优先 + 进度词表 × 注册表双层判定", async () => {
  const items = [
    { title_cn: "粤芯半导体：注册申请材料已受理", summary: "", tags: ["粤"], url: "u1", rank: 1, source: "s", source_type: "official", date: "09/11", summary2: "", importance: 2 as const, tags2: undefined },
  ] as unknown as Parameters<typeof detectGdIpo>[0];
  assert.equal(detectGdIpo(items).length, 1, "粤标直接命中（标题无地域字样也不漏）");
  assert.equal(detectGdIpo([{ title_cn: "外地企业新股上市", summary: "", tags: [], url: "u2" } as never]).length, 0);
});
