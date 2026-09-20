import { test } from "node:test";
import assert from "node:assert/strict";
import { sameEvent } from "../lib/services/select/filters/dedup-similar";
import { dedupeExecAgainstSections } from "../lib/services/enrich/dedupe-sections";
import { computeMarketStatus } from "../lib/services/market/market-status";
import type { DailyReport, ReportItem } from "../lib/contracts/report";

/** 构造一条资讯板块条目 */
function mk(title_cn: string, url = `https://example.com/${encodeURIComponent(title_cn)}`): ReportItem {
  return {
    url,
    title_cn,
    source: "测试源",
    source_type: "media",
    date: "08-30",
    summary: "",
    importance: 2,
    rank: 0,
    tags: [],
    locale: "national",
  };
}

test("sameEvent: 住房贷款 vs 房贷 同义词归一后判为同一事件(房贷40年)", () => {
  // 修复前：两条仅共享 #40年（1 个）→ false → policy_market 板块内 2 条房贷40年未合并
  assert.equal(
    sameEvent(
      "个人房贷最长期限从30年延长到40年，银行会怎样跟进？",
      "两部门：个人住房贷款期限延至最长40年",
    ),
    true,
  );
  // 公积金同义词归一
  assert.equal(
    sameEvent("9月1日起广州住房公积金缴存基数下限将调整", "广州调整住房公积金最低缴存基数"),
    true,
  );
});

test("dedupeExecAgainstSections: 必读头条命中的事件，资讯板块不再重复展开", () => {
  const report: DailyReport = {
    date: "2026-08-30",
    hero_line: "楼市全链条改革叠加房贷40年新政落地",
    must_read: [{ title: "房贷最长40年新政", why: "按揭期限延长直接拉低月供", url: "https://x/40y" }],
    insights: [],
    sections: {
      policy_market: [
        mk("两部门：个人住房贷款期限延至最长40年"), // 与必读同事件 → 应被移除
        mk("密集上新 多城优化调整住房公积金政策"), // 不同事件 → 保留
        mk("三部门完善商品房销售制度 实现“所见即所得”"), // 不同事件 → 保留
      ],
      gz_local: [mk("9月1日起广州住房公积金缴存基数下限将调整")],
      biz_insight: [],
      tech: [],
      ipo: [],
    },
  };
  const out = dedupeExecAgainstSections(report);
  const titles = out.sections.policy_market.map((i) => i.title_cn);
  assert.ok(!titles.includes("两部门：个人住房贷款期限延至最长40年"), "policy_market 应移除与必读同事件的房贷40年条目");
  assert.equal(out.sections.policy_market.length, 2, "其余 2 条应保留");
  // 不动 insights（商机与政策是互补视角）
  assert.equal(out.sections.gz_local.length, 1, "gz_local 不受必读去重影响（此处无同事件）");
  // 纯函数：原对象不被 mutate
  assert.equal(report.sections.policy_market.length, 3, "原 report 不应被修改");
});

test("computeMarketStatus: 周六报告 → 三市场 gap=1 均播（美股美东周五收盘的隔夜行情）", () => {
  // 报告日 08-29（周六）：数据（A股/港股 08-28、美股美东 08-28）→ gap=1 → 全播。
  const r = computeMarketStatus("2026-08-29", { aShare: "2026-08-28", hk: "2026-08-28", us: "2026-08-28" });
  assert.equal(r.markets.us.fresh, true, "美股 gap=1 → 播");
  assert.equal(r.markets.aShare.fresh, true, "A股 gap=1 → 播");
  assert.equal(r.allStale, false);
  assert.equal(r.note, "");
});

test("computeMarketStatus: 周日报告 → 三市场均无隔夜行情（周五行情周六早已播过）", () => {
  // 报告日 08-30（周日）：同一份 08-28 数据 → gap=2 → 全不播，避免重播。
  const r = computeMarketStatus("2026-08-30", { aShare: "2026-08-28", hk: "2026-08-28", us: "2026-08-28" });
  assert.equal(r.allStale, true, "gap=2 > 1 → 全无隔夜行情");
  assert.equal(r.markets.us.fresh, false, "美股同理（周六已播）");
  assert.match(r.note!, /无隔夜行情/);
});

test("computeMarketStatus: 周一报告 → 三市场均无隔夜行情", () => {
  const r = computeMarketStatus("2026-08-31", { aShare: "2026-08-28", hk: "2026-08-28", us: "2026-08-28" });
  assert.equal(r.allStale, true);
  assert.match(r.note!, /无隔夜行情/);
});

test("computeMarketStatus: 周三报告，数据为周二（gap=1）→ 三市场均有隔夜行情、无警示", () => {
  const r = computeMarketStatus("2026-08-26", { aShare: "2026-08-25", hk: "2026-08-25", us: "2026-08-25" });
  assert.equal(r.allStale, false);
  assert.equal(r.markets.aShare.fresh, true);
  assert.equal(r.markets.hk.fresh, true);
  assert.equal(r.note, "");
});

test("computeMarketStatus: 部分开市 —— A股/港股休市（gap 大）而美股新鲜 → 仅美股 fresh", () => {
  // 场景：A股/港股数据停在假期前（gap=4），美股为美东前一日（美东基准 10-05、数据 10-05 → gap=0）
  const r = computeMarketStatus("2026-10-06", {
    aShare: "2026-10-02",
    hk: "2026-10-02",
    us: "2026-10-05",
  });
  assert.equal(r.markets.us.fresh, true, "美股有隔夜行情");
  assert.equal(r.markets.aShare.fresh, false, "A股无隔夜行情");
  assert.equal(r.markets.hk.fresh, false, "港股无隔夜行情");
  assert.equal(r.allStale, false);
  assert.match(r.note!, /A股、港股/);
});
