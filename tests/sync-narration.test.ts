/**
 * 口播派生（`syncNarration`）口径锁（2026-09-28 sc 口径）。
 *
 * 三条分工（不再全线 1:1）：
 *  - 定调  `spoken_hero`：**LLM 优先**（≤70 字维度提纲 + 看点），缺失时由 `heroSpeechLine` 兜底；
 *  - 必读  `spoken_must_read`：卡面 1:1 确定性派生（`{标题。}{why。}`，句子级不变）；
 *  - 商机  `spoken_insights`：**LLM 优先**（按客群归并 3~4 条），缺失时由
 *    `groupedInsightsSpeech` 按客群归并兜底 —— 逐条 1:1 会既超预算（09-28 实测 662 字 >
 *    520 上限）又听不懂重点（六条里四条都是本地消费获客）。
 *    ⚠️ 2026-10-01 sc 口径：**只讲事实与影响，不念 action**（全篇不给操作建议/行动指引）。
 *  - 风险  `spoken_risk`：卡面 1:1（2026-10-01 起同样不念 action）；卡面被去重清空则口播同步清空（消除孤儿口播）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { syncNarration } from "../lib/pipeline/side-outputs/side-exec-summary";
import {
  INSIGHT_GROUP_IMPACT_CHARS,
  INSIGHT_GROUP_TOPIC_MAX,
  groupedInsightsSpeech,
} from "../lib/services/voice/speech-lines";
import type { ExecutiveSummary } from "../lib/services/enrich/executive-summary";

function base(over: Partial<ExecutiveSummary> = {}): ExecutiveSummary {
  return {
    hero_line: "定调",
    must_read: [],
    insights: [],
    ...over,
  };
}

// ---------- 商机：按客群归并 ----------

test("商机口播：按客群归并 —— 条数不随卡面线性增长（5 卡 → 3 条）", () => {
  const exec = base({
    insights: [
      { topic: "基金代销", impact: "影响1", action: "节前接住到期资金。", segments: ["零售AUM"] },
      { topic: "含权理财", impact: "影响2", action: "更新配置话术。", segments: ["零售AUM"] },
      { topic: "私募扩容", impact: "影响3", action: "更新准入清单。", segments: ["中高端客群(过亿资产)"] },
      { topic: "消费补贴", impact: "影响4", action: "对接补贴平台。" },
      { topic: "文旅收单", impact: "影响5", action: "走访文旅商户。" },
    ],
  });
  const text = syncNarration(exec).spoken_insights ?? "";
  assert.match(text, /^第一，零售 A U M方面，基金代销、含权理财，影响1。/, "同客群合并为一条");
  assert.match(text, /第二，高端客户方面，私募扩容，影响3。/, "客群短标签映射");
  assert.match(text, /第三，其他机会方面，消费补贴、文旅收单，影响4。/, "无标签归「其他机会」");
  assert.equal((text.match(/方面，/g) ?? []).length, 3, "5 条卡面 → 3 条口播");
  assert.ok(!/节前接住到期资金|更新配置话术|走访文旅商户/.test(text), "2026-10-01：action 不再进口播");
});

test("商机口播：组内超 2 条 → 以「首条等N条线索」概括，不罗列", () => {
  const exec = base({
    insights: [1, 2, 3, 4].map((i) => ({ topic: `主题${i}`, impact: `影响${i}`, action: `动作${i}。` })),
  });
  const out = syncNarration(exec);
  assert.equal(out.spoken_insights, "第一，其他机会方面，主题1等4条线索，影响1。");
  assert.equal(INSIGHT_GROUP_TOPIC_MAX, 2, "上限常量须与实现一致");
});

test("商机口播：多标签卡取第一段客群（口播只按主客群归并）", () => {
  const exec = base({
    insights: [
      {
        topic: "家族信托升级",
        impact: "利好高净值",
        action: "跟进私行",
        segments: ["零售AUM", "中高端客群(过亿资产)"],
      },
    ],
  });
  assert.match(syncNarration(exec).spoken_insights ?? "", /^第一，零售 A U M方面，家族信托升级，利好高净值。$/);
});

test("零售AUM 口播按字母发音（空格拆 A U M），与展示文案无关", () => {
  const exec = base({
    insights: [{ topic: "财富客户提升", impact: "AUM 规模增长", action: "做大客群", segments: ["零售AUM"] }],
  });
  const out = syncNarration(exec);
  assert.match(out.spoken_insights ?? "", /零售 A U M方面/);
  assert.ok(!/零售AUM方面/.test(out.spoken_insights ?? ""), "口播不得出现连写的『零售AUM』");
});

test("商机口播：组内 impact 只取「一句影响」（不铺陈细节）", () => {
  const exec = base({
    insights: [
      {
        topic: "理财申赎卡点",
        impact: "节前资金搬家集中，客户到期赎回与跨节到账时点若不提前告知，易出现收益空档与投诉。",
      },
    ],
  });
  const text = syncNarration(exec).spoken_insights ?? "";
  assert.equal(text, "第一，其他机会方面，理财申赎卡点，节前资金搬家集中。");
  assert.ok(!text.includes("收益空档"), "首个逗号之后的铺陈细节不再念");
  assert.ok(text.length <= INSIGHT_GROUP_IMPACT_CHARS + 20, `单组应短（实际 ${text.length} 字）`);
});

test("商机口播：impact 首段过短 → 向后补一段（不产出无信息片段）", () => {
  const exec = base({
    insights: [{ topic: "小微贷", impact: "扩客，园区上下游名单需要重新摸排梳理并同步授信政策与额度方案。" }],
  });
  const text = syncNarration(exec).spoken_insights ?? "";
  assert.ok(text.includes("扩客，园区上下游名单需要重新摸排梳理"), `首段过短应补一段（实际：${text}）`);
});

test("商机口播：LLM 产出优先（归并稿不被卡面兜底覆盖）", () => {
  const llm =
    "第一，零售 A U M方面，基金代销等3条线索，节前接住到期资金与存款迁移。第二，本地场景方面，消费补贴与文旅商圈同时放量，信用卡和消费贷提前进商圈布点。";
  const exec = base({
    spoken_insights: llm,
    insights: [{ topic: "基金代销", impact: "i", action: "a", sources: [{ title: "t", url: "https://example.com/a" }] }],
  });
  assert.equal(syncNarration(exec).spoken_insights, llm, "LLM 归并稿比卡面兜底更聚焦，应原样保留");
});

test("无 insights 时口播置空（不残留旧整块文本 / 不产出孤儿口播）", () => {
  const exec = base({ spoken_insights: "这是昨天残留的一大段旧口播文本……" });
  assert.equal(syncNarration(exec).spoken_insights, undefined);
});

test("归并原语：空数组 / 空白主题 → 不产出残句", () => {
  assert.equal(groupedInsightsSpeech([]), "");
  assert.equal(groupedInsightsSpeech([{ topic: "  " }]), "");
});

// ---------- 风险 ----------

test("risk 被去重清空 → 口播同步清空（消除孤儿口播）", () => {
  const exec = base({
    risk: undefined,
    spoken_risk: "今天有 1 个需要警惕：某风险，影响，动作。",
  });
  assert.equal(syncNarration(exec).spoken_risk, undefined, "风险卡不存在时口播不得残留");
});

test("risk 存在 → 派生 1 句风险口播", () => {
  const exec = base({
    risk: { topic: "理财违规", evidence: "通报", impact: "合规风险", action: "关注" },
  });
  assert.match(syncNarration(exec).spoken_risk ?? "", /今天有 1 个需要警惕：理财违规/);
});

// ---------- 今日定调（2026-09-26：补位后不得丢定调口播） ----------
// 背景：定调被判重 → exec-guard 从池内补位并把 spoken_hero 清空（避免沿用旧稿），
// 而 voice/index.ts 只读 spoken_hero（明写不读 hero_line）→ 若无兜底，「今日定调」
// 口播段整段消失。实证：补位期次 09-24 / 09-26 皆缺，非补位期次（09-25 等）正常。

test("定调补位：spoken_hero 被清空 → 由 hero_line 兜底派生（不再整段消失）", () => {
  const exec = base({
    hero_line: "今日分行焦点：被立案两券商重罚落地！暂停新开户3个月多名高管遭罚",
    spoken_hero: undefined,
  });
  const out = syncNarration(exec);
  assert.ok(out.spoken_hero, "补位后必须仍有定调口播");
  assert.ok(!out.spoken_hero!.includes("今日分行焦点"), "口播里不重复念卡面的补位前缀");
  assert.match(out.spoken_hero!, /。$/, "句号收尾");
});

test("定调：LLM 产出优先（维度提纲原样保留，不被卡面覆盖）", () => {
  const llm = "今天主要看四个方面：汇率预期管理、楼市金九银十、财富货架调整、消费场景获客。";
  const exec = base({ hero_line: "旧的卡面定调", spoken_hero: llm });
  assert.equal(syncNarration(exec).spoken_hero, llm, "LLM 版是最终稿，应原样保留");
});

test("定调：标题自带感叹号 → 收尾只有一个句号（不出现「！。」）", () => {
  const out = syncNarration(base({ hero_line: "今日分行焦点：券商重罚落地！", spoken_hero: undefined }));
  assert.equal(out.spoken_hero, "券商重罚落地。");
});

test("定调：卡面与口播皆无 → 不产出孤立句号（保持 undefined）", () => {
  const exec = base({ hero_line: "", spoken_hero: undefined });
  assert.equal(syncNarration(exec).spoken_hero, undefined);
});

// ---------- 必读：保持句子级 1:1 ----------

test("必读口播：仍按卡面 1:1 派生（标题 + why，不归并）", () => {
  const exec = base({
    must_read: [
      { title: "事件一", why: "解读一", url: "https://example.com/1" },
      { title: "事件二", why: "解读二", url: "https://example.com/2" },
      { title: "事件三", why: "解读三", url: "https://example.com/3" },
    ],
  });
  const out = syncNarration(exec);
  assert.match(out.spoken_must_read ?? "", /^事件一。解读一。其次，事件二。解读二。此外，事件三。解读三。$/);
});
