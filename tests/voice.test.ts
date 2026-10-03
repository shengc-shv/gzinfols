import { test } from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assembleBriefingScript,
  sanitize,
  stripSpeechGreeting,
  detectVisualRefs,
  truncateAtSentence,
  detectGdIpo,
  AUDIO_SPEAK_LIMITS,
  SCRIPT_MAX_CHARS,
} from "../lib/services/voice";
import { writeMp3Both } from "../lib/adapters/tts";
import { syncNarration } from "../lib/pipeline/side-outputs/side-exec-summary";
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
  assert.ok(
    b.script.startsWith("早上好，这是9月11日的早报。"),
    "开场白声明报告日（让「今天/昨天」有锚点，2026-09-28 sc 口径）",
  );
  assert.ok(b.script.includes("先看今天的整体定调。"));
  assert.ok(b.script.includes("接着看今日必读，共1条。"), "必读过渡语报出条数（「纲」之后进「目」）");
  assert.ok(b.script.includes("下面是商机洞察，按客群看。"));
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
  assert.ok(b.script.includes("最后是风险预警。"));
  assert.ok(b.parts.risk);
});

test("口径锁定：章节预算为 2026-09-28 sc 口径重分配（定调缩、必读/商机按新分工）", async () => {
  assert.equal(AUDIO_SPEAK_LIMITS.hero, 70);
  assert.equal(AUDIO_SPEAK_LIMITS.must_read, 320);
  assert.equal(AUDIO_SPEAK_LIMITS.insights, 280);
  assert.equal(AUDIO_SPEAK_LIMITS.ipo, 150);
  assert.equal(AUDIO_SPEAK_LIMITS.risk, 140);
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

test("TTS 归档：返回的路径必须是持久路径且文件存在（回归 2026-09-15「页面无播放器」事故）", () => {
  // 事故根因：synthesizeAudio 返回合成用的**临时路径**，而临时目录在返回前已由 finally 清理，
  // 下游 TtsAdapter 对它 statSync → ENOENT → 被管线 catch → audio 元数据为空 → 整页无播放器。
  const base = fsSync.mkdtempSync(path.join(os.tmpdir(), "tts-arch-"));
  try {
    const src = path.join(base, "briefing-2026-09-15.mp3");
    fsSync.writeFileSync(src, Buffer.alloc(20_000, 1));

    const archived = writeMp3Both(src, "2026-09-15", base);

    assert.ok(fsSync.existsSync(archived), "返回路径必须真实存在（下游要 stat 它）");
    assert.equal(
      archived,
      path.join(base, "daily_reports", "2026-09-15", "audio", "briefing-2026-09-15.mp3"),
      "必须是归档持久路径，不是临时路径",
    );
    // 播放器引用相对路径 audio/briefing-<date>.mp3 → 站点副本必须落在 site/<date>/audio/
    assert.ok(
      fsSync.existsSync(path.join(base, "site", "2026-09-15", "audio", "briefing-2026-09-15.mp3")),
      "site/<date>/audio/ 副本必须存在（播放器相对路径解析依赖它）",
    );
    // 合成临时文件被清理后，归档路径仍必须可用
    fsSync.rmSync(src, { force: true });
    assert.ok(fsSync.existsSync(archived), "源临时文件删除后归档仍应存在");
  } finally {
    fsSync.rmSync(base, { recursive: true, force: true });
  }
});

test("听觉友好：车里听的稿子不得出现视觉指代词（该政策/上述/如下/见表）", async () => {
  // 听众是早上在车里听的行领导：看不见屏幕、不能回看，「上述」「该政策」读出来等于没说。
  // 提示词已明令 LLM 不用这类词；此处是确定性兜底 + 成稿守门。
  assert.deepEqual(detectVisualRefs("该政策影响分行，上述判断如下"), ["该政策", "上述", "如下"]);
  // 2026-10-03 口播审查 P0-1：「请参见报告」同样是视觉指代 —— 听众在**车上打不开报告**，
  // 说出来等于没说（它曾是股市段末句的硬编码模板，与提示词「严禁…详见报告」自相矛盾）。
  assert.deepEqual(detectVisualRefs("其余市场行情详情请参见报告。"), ["参见报告"]);
  assert.deepEqual(detectVisualRefs("详见报告第3页"), ["详见报告"]);
  assert.deepEqual(
    detectVisualRefs("今天主要看两个方面：汇率预期管理，结售汇窗口；消费场景获客，补贴叠加节庆。"),
    [],
    "正常的维度提纲不触发",
  );
  const b = await assembleBriefingScript(report(), { exec: exec() });
  assert.ok(b);
  assert.deepEqual(detectVisualRefs(b!.script), [], "成稿不得含视觉指代词");
  assert.ok(
    !b!.script.includes("参见报告") && !b!.script.includes("详见报告"),
    "末句不得把听众引向报告（页面照常展示，口播必须自足）",
  );
});

test("定调补位：口播仍含「先看今天的整体定调」（2026-09-26 实证缺陷回归）", async () => {
  // 复现 exec-guard 补位后的 exec：卡面换成补位标题、spoken_hero 被清空
  const patched = syncNarration(
    exec({ hero_line: "今日分行焦点：券商重罚落地暂停新开户3个月", spoken_hero: undefined }),
  );
  assert.ok(patched.spoken_hero, "syncNarration 应兜底派生定调口播");
  const b = await assembleBriefingScript(report(), { exec: patched });
  assert.ok(b);
  assert.ok(b!.script.includes("先看今天的整体定调。"), "补位后不得丢定调口播");
  assert.ok(!b!.script.includes("今日分行焦点"), "口播不重复念卡面的补位前缀");
});

test("问候语安全网：LLM 稿自带问候 → 只念一次（2026-09-28 实测「早上好。各位早上好。」）", async () => {
  const withGreeting = exec({
    spoken_hero: "各位早上好。今天主要看两个方面：汇率预期管理、消费场景获客。",
  });
  const b = await assembleBriefingScript(report(), { exec: withGreeting });
  assert.ok(b);
  const greets = b!.script.match(/早上好/g) ?? [];
  assert.equal(greets.length, 1, `全稿只应有一个问候（实际 ${greets.length} 个）`);
  assert.ok(b!.parts.hero!.startsWith("今天主要看两个方面"), "问候语已从定调段剥离");
  assert.equal(stripSpeechGreeting("各位早上好。今天看汇率。"), "今天看汇率。");
  assert.equal(stripSpeechGreeting("大家好，今天看汇率。"), "今天看汇率。");
  assert.equal(stripSpeechGreeting("今天看汇率。"), "今天看汇率。", "无问候原样返回");
});
