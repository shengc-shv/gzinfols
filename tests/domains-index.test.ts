/**
 * 领域专题索引（WP10 · lib/services/vocab/domains-index.ts）守护。
 *
 * 钉住四件事：
 *  ① **判定复用生产口径**（classifyBusinessDomain），无可靠关联的条目不硬凑；
 *  ② 二级主题只做分组，**绝不参与**领域判定（否则历史 primary_domain 会漂）；
 *  ③ 跨期去重：同一条目只出现一次，取最近一次出现的期次；
 *  ④ 窗口与截断：明细可截、计数不可截。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDomainIndex, MAX_ITEMS_PER_DOMAIN } from "../lib/services/vocab/domains-index";
import { BUSINESS_DOMAINS, DOMAIN_IDS, classifyBusinessDomain } from "../lib/services/vocab/business-domains";
import type { SlimItem } from "../lib/services/topics/slim";

function item(i: string, t: string, over: Partial<SlimItem> = {}): SlimItem {
  return { i, t, s: "测试源", d: "11/28", m: 2, k: "gz_local", g: [], x: "", u: `https://e.com/${i}`, ...over };
}

test("① 领域判定复用生产函数：无关联条目不硬凑，只计 classified", () => {
  const idx = buildDomainIndex({
    days: {
      "2026-11-27": { items: [item("a", "广州首套房贷利率下调 按揭需求回暖")] },
      "2026-11-28": {
        items: [
          item("b", "某公司发布新款手机 销量超预期"),
          item("c", "公募基金代销费率下调 银行中收承压"),
        ],
      },
    },
    windowRuns: 30,
  });
  assert.equal(idx.total, 3, "三条都进窗口");
  assert.equal(idx.classified, 2, "手机新品与六大领域无可靠关联，不归入");
  const credit = idx.domains.find((d) => d.id === "retail_credit")!;
  assert.equal(credit.count, 1, "房贷稿归零售信贷");
  const wealth = idx.domains.find((d) => d.id === "wealth_aum")!;
  assert.equal(wealth.count, 1, "代销费率稿归财富管理");
});

test("② 二级主题不参与领域判定：只有 subtopic 词的标题不得产生领域归属", () => {
  // 「揽储」只出现在 subtopics 里（顶层 keywords 无此词）→ 不得因此获得领域归属
  const cls = classifyBusinessDomain({ title: "年终揽储竞争加剧 中小银行承压", summary: "", tags: [] });
  // 若顶层 keywords 不含这些词 → null（证明 subtopics 没被塞进判定面）
  assert.equal(cls, null, "subtopics 词不得让条目获得 primary_domain");

  const idx = buildDomainIndex({
    days: { "2026-11-28": { items: [item("x", "年终揽储竞争加剧 中小银行承压")] } },
    windowRuns: 30,
  });
  assert.equal(idx.classified, 0, "专题索引与生产判定同一结果");
  assert.ok(idx.domains.every((d) => d.count === 0), "六个领域都为空");
});

test("③ 二级主题：标题命中优先，摘要单命中不归类（退回摘要要 ≥2 词）", () => {
  const idx = buildDomainIndex({
    days: {
      "2026-11-28": {
        items: [
          // 标题直接含「代销」→ 归「代销与中收」
          item("t1", "代销基金费率下调 中收承压", { x: "与资本市场无关的摘要" }),
          // 标题无二级主题词，摘要只含一个泛词「基金」→ 归「其他」
          item("t2", "A股缩量震荡 周期资源与银行板块走强", { x: "基金公司仓位小幅上升" }),
          // 摘要含两个词（基金 + 理财）→ 可归类
          item("t3", "居民资产再配置观察", { x: "理财与基金规模同步回升" }),
        ],
      },
    },
    windowRuns: 30,
  });
  const w = idx.domains.find((d) => d.id === "wealth_aum")!;
  const byId = new Map(w.items.map((it) => [it.id, it]));
  assert.equal(byId.get("t1")?.subtopic, "代销与中收");
  assert.equal(byId.get("t2")?.subtopic, null, "摘要单命中不归类（防止宏观稿被拽进代销）");
  assert.equal(byId.get("t3")?.subtopic, "代销与中收", "摘要双命中可归类");
});

test("④ 跨期去重：同一条目只出现一次，日期取最近一期", () => {
  const idx = buildDomainIndex({
    days: {
      "2026-11-20": { items: [item("dup", "广州房贷利率下调")] },
      "2026-11-28": { items: [item("dup", "广州房贷利率下调")] },
    },
    windowRuns: 30,
  });
  const credit = idx.domains.find((d) => d.id === "retail_credit")!;
  assert.equal(credit.count, 1, "去重后只算一次");
  assert.equal(credit.items.length, 1);
  assert.equal(credit.items[0].date, "2026-11-28", "取最近出现的期次");
});

test("⑤ 窗口按最近 N 期取；明细可截断，计数不截断", () => {
  const days: Record<string, { items: SlimItem[] }> = {};
  for (let d = 1; d <= 10; d += 1) {
    const date = `2026-11-${String(d).padStart(2, "0")}`;
    days[date] = { items: [item(`h${d}`, `第${d}期 住房贷款政策观察`)] };
  }
  const idx = buildDomainIndex({ days, windowRuns: 3, maxItemsPerDomain: 2 });
  const credit = idx.domains.find((d) => d.id === "retail_credit")!;
  assert.equal(credit.count, 3, "只统计最近 3 期");
  assert.equal(credit.items.length, 2, "明细按上限截断");
  assert.equal(credit.items[0].date, "2026-11-10", "明细按日期降序，最新在前");
  assert.equal(idx.generatedAt, "2026-11-10", "基准期次取最新一期（不看系统时钟）");
  assert.equal(idx.windowRuns, 3);
});

test("⑥ 空输入不抛错；六个领域顺序与配置一致，明细上限常量可用", () => {
  const idx = buildDomainIndex({ days: {} });
  assert.equal(idx.total, 0);
  assert.equal(idx.classified, 0);
  assert.equal(idx.generatedAt, "");
  assert.deepEqual(idx.domains.map((d) => d.id), [...DOMAIN_IDS], "六领域按配置顺序输出，空也输出");
  assert.equal(idx.domains.length, 6);
  assert.equal(idx.windowRuns, 30);
  assert.ok(MAX_ITEMS_PER_DOMAIN >= 50);
});

test("⑦ 词表结构：六大领域 id 稳定，二级主题字段齐全且不掺进 keywords", () => {
  assert.deepEqual([...DOMAIN_IDS], [
    "wealth_aum",
    "customer_growth",
    "retail_credit",
    "channel_ai",
    "risk_consumer",
    "regional_peer",
  ], "id 是历史报告 primary_domain 的锚，改名会让历史标签漂");
  for (const d of BUSINESS_DOMAINS) {
    assert.ok(d.subtopics.length >= 3, `${d.id} 至少 3 个二级主题`);
    // 二级主题与顶层 keywords 共享词是**正常**的（二级是更细的分组）；
    // 要守的不是「不许重叠」，而是「二级主题词不得单独构成领域归属」—— 见测试 ②。
    for (const s of d.subtopics) {
      assert.ok(s.name && s.keywords.length > 0, `${d.id} 二级主题需有名称与关键词`);
    }
    assert.ok(d.segments.length > 0 && d.products.length > 0 && d.event_types.length > 0);
    assert.ok(d.opportunity_risk.opportunity.length > 0 && d.opportunity_risk.risk.length > 0);
  }
});

test("⑤ IPO 板块兜底与首页同源：判不出领域时归客户经营，不再被索引漏掉", () => {
  const idx = buildDomainIndex({
    days: { "2026-11-28": { items: [item("p", "深鹏科技：IPO问询中（拟北交所）", { k: "ipo" })] } },
    windowRuns: 30,
  });
  assert.equal(idx.classified, 1, "IPO 短标题不应被丢弃（否则首页看得到、专题页看不到）");
  const cg = idx.domains.find((d) => d.id === "customer_growth")!;
  assert.equal(cg.count, 1, "归客户经营与客群增长（与决策首页领域模块同一判定）");
});
