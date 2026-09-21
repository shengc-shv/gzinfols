/**
 * 商机洞察「候选池 + 顺序判重 + 顺延补足」（2026-09-21，与必读同构）。
 *
 * 背景：此前洞察是「LLM 生成 → 判重 → 剩多少算多少」，**没有候补顺延**。
 * 周末连跑两天后，周一候选与已播商机大面积撞冷却 → 实证 09-21 为 8 → 3 条
 * （去重 5 条：exhausted,refresh,refresh,cooldown,cooldown），洞察板块内容腰斩。
 *
 * 本测试锁住两条语义（与 must_read 的规则 3/4 一致）：
 *   ① 命中重复的候选被跳过，**由靠后的候补顺延补足**到播出目标；
 *   ② 候补用尽（全部命中）→ 按实际剩余（可为 0），不强行凑数。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickUntilTarget } from "../lib/services/memory/exec-guard";
import { beginDay, emptyMemory } from "../lib/services/memory/event-memory";
import { INSIGHT_PLAY_TARGET } from "../lib/services/memory/event-types";
import type { EventMemoryStore, MemoryCandidate } from "../lib/services/memory/event-memory";

const TODAY = "2026-09-21";

// 内容彼此差异明显的候选池（避免测试自身的「同模板文本」被互相判重）
const TEXT: Record<string, string> = {
  A1: "广州首单净土贷落地，土壤治理类绿色信贷路径打通，本地环保与城投类客户融资需求显现。",
  A2: "上海首批跨境资金集中运营新政落地，大湾区跨境客群资金管理便利化需求上升。",
  A3: "民生银行同日获批收购两家村镇银行，区域内存量网点与客群迁移机会显现。",
  A4: "住房公积金提取场景扩容，装修与物业费均可提取，住房金融联动空间打开。",
  A5: "被动指数债基规模突破两万亿，稳健型客户配置供给面临调整，财富货架需补充。",
  A6: "国常会部署应对人口老龄化，养老储蓄与保险类产品对接窗口打开。",
  B1: "广交会跨境电商客群结算需求上升，跨境收付与结售汇服务存在切入点。",
  B2: "番禺原拆原建项目推进，拆迁资金承接与安置客群综合金融服务需求显现。",
  B3: "茅台广州仓储供应链金融机会，核心企业上下游小微融资需求可跟进。",
  B4: "水产市场升级改造带来资金监管与商户收单机会，普惠小微客群可切入。",
  B5: "医药企业校招启动，代发工资与员工福利金融存在承接空间。",
  B6: "创业客群跨区域流动加剧，异地开户与结算便利化需求提升。",
  B7: "汽车产业链普惠客群融资需求上行，经销商库存融资方案可评估。",
  B8: "商超场景消费信贷联动机会，联合收单与分期产品可组合配置。",
};

const toCandidate = (title: string): MemoryCandidate => ({
  title,
  text: TEXT[title] ?? title,
});

function play(store: EventMemoryStore, titles: string[]) {
  return pickUntilTarget({
    items: titles,
    toCandidate,
    section: "insights",
    today: TODAY,
    broadcastAt: `${TODAY}T08:00:00+08:00`,
    target: INSIGHT_PLAY_TARGET,
    store,
  });
}

test("顺延补足：前置候选命中重复时，由靠后候补补齐到播出目标", () => {
  let store = beginDay(emptyMemory(), TODAY);

  // 第一轮：先播掉 A1..A6（写入记忆），模拟「此前已播过」
  const first = play(store, ["A1", "A2", "A3", "A4", "A5", "A6"]);
  store = first.store;
  assert.equal(first.chosen.length, INSIGHT_PLAY_TARGET, "第一轮无重复，应选满目标条数");

  // 第二轮：候选池 12 条（= INSIGHT_CANDIDATE_POOL），前 4 条与已播重复
  // —— 旧口径下 12 条只剩 8 条却仍被截到 6，且「8 → 3」那类腰斩正源于无候补顺延
  const second = play(store, [
    "A1", "A2", "A3", "A4",
    "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8",
  ]);
  assert.equal(second.skipped.length, 4, "前置 4 条应被判重跳过");
  assert.equal(second.chosen.length, INSIGHT_PLAY_TARGET, "应由候补顺延补足到目标条数");
  assert.deepEqual(
    second.chosen.map((c) => c.item),
    ["B1", "B2", "B3", "B4", "B5", "B6"],
    "播出的应是候选池里靠后的未重复条目（B7/B8 留作未用候补）",
  );
});

test("候补用尽：候选全部命中重复 → 播出 0 条（按实际剩余，不强行凑数）", () => {
  let store = beginDay(emptyMemory(), TODAY);
  const first = play(store, ["C1", "C2", "C3", "C4", "C5", "C6"].map(() => "A1"));
  assert.equal(first.chosen.length, 1, "同一条重复候选只会选出 1 条");

  const second = play(first.store, ["A1", "A1", "A1"]);
  assert.equal(second.chosen.length, 0, "候补用尽按实际剩余（0 条）");
  assert.equal(second.skipped.length, 3, "3 条应全部记为跳过");
});
