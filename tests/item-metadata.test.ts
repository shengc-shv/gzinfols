/**
 * 条目元数据补齐守护（第一期规格工作包 2）。
 *  - published_at 只取 ArticleInput.publishedAt（真实发布时间），绝不兜底 fetchedAt；
 *  - 六大经营领域由内容词表判定，与五大内容分类正交、不写进 tags；
 *  - 幂等、不 mutate 入参；无可靠领域关联不硬凑。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { annotateItem, annotateItemMetadata, indexArticlesByUrl } from "../lib/services/assemble/item-metadata";
import { classifyBusinessDomain, BUSINESS_DOMAINS, DOMAIN_IDS } from "../lib/services/vocab/business-domains";
import type { ArticleInput } from "../lib/contracts/article";
import type { DailyReport, ReportItem } from "../lib/contracts/report";

function article(over: Partial<ArticleInput> = {}): ArticleInput {
  return {
    sourceId: "test",
    title: "测试标题",
    url: "https://e.com/a",
    category: "gz",
    publishedAt: new Date("2026-11-27T23:10:00+08:00"),
    isIpo: false,
    excerpt: "摘要",
    source: "测试源",
    ...over,
  };
}

function item(over: Partial<ReportItem> = {}): ReportItem {
  return {
    url: "https://e.com/a",
    title_cn: "广州首套房贷利率下调，按揭客户关注",
    source: "测试源",
    source_type: "media",
    date: "11/27",
    summary: "住房贷款利率调整",
    importance: 2,
    rank: 1,
    tags: ["住房金融"],
    locale: "gz",
    ...over,
  };
}

test("① published_at 取真实发布时间 ISO，不用 fetchedAt 兜底", () => {
  const a = article();
  const out = annotateItem(item(), indexArticlesByUrl([a]));
  assert.equal(out.published_at, "2026-11-27T15:10:00.000Z", "取 publishedAt 转 ISO");
  // 只有 fetchedAt、无 publishedAt 的对象（契约虽必填，防未来误用）不得兜底
  const noPub = { ...a, publishedAt: undefined as unknown as Date, fetchedAt: new Date("2026-11-28T01:00:00Z") };
  const out2 = annotateItem(item(), indexArticlesByUrl([noPub]));
  assert.equal(out2.published_at, undefined, "绝不拿抓取时间当发布时间");
});

test("② 领域归属只看内容，不看 sourceId/category/subcategory", () => {
  const content = classifyBusinessDomain({ title: "广州首套房贷利率下调", summary: "按揭政策调整", tags: ["住房金融"] });
  assert.ok(content, "内容命中领域");
  assert.equal(content!.primary_domain, "retail_credit", "主领域=零售信贷与住房金融");
  // 同一内容换任意采集元数据，判定不变
  const a = classifyBusinessDomain({ title: "广州首套房贷利率下调", summary: "按揭政策调整", tags: ["住房金融"] });
  assert.deepEqual(a, content, "判定与采集元数据无关");
});

test("③ 每条一主多辅，无关联不硬凑，exclude 防跨词误配", () => {
  const multi = classifyBusinessDomain({
    title: "证监会处罚银行理财代销违规，消费者保护新规落地",
    summary: "财富管理与消保监管",
  });
  assert.ok(multi);
  assert.equal(DOMAIN_IDS.includes(multi!.primary_domain), true);
  assert.ok(multi!.related_domains.length >= 1, "可有多个相关领域");
  assert.equal(classifyBusinessDomain({ title: "今日天气转凉", summary: "气温下降" }), null, "无关不硬塞领域");
  const excluded = classifyBusinessDomain({ title: "财富世界500强榜单发布", summary: "" });
  assert.equal(excluded, null, "exclude 词命中后不得误判为财富管理");
});

test("④ 六大领域配置：id 唯一、六个、名称非早版简称", () => {
  assert.equal(BUSINESS_DOMAINS.length, 6);
  assert.equal(new Set(DOMAIN_IDS).size, 6, "id 唯一");
  for (const name of ["财富管理与AUM", "客户经营与客群增长", "零售信贷与住房金融", "渠道经营、数字化与AI", "风险管理与消费者保护", "区域经济与同业竞争"]) {
    assert.ok(BUSINESS_DOMAINS.some((d) => d.name === name), `缺领域：${name}`);
  }
});

test("⑤ 幂等 + 不 mutate 入参 + 五大分类键不变", () => {
  const a = article();
  const r: DailyReport = {
    date: "2026-11-28",
    sections: { gz_local: [item()], biz_insight: [], policy_market: [], tech: [], ipo: [] },
    must_read: [],
    insights: [],
  };
  const snapshot = JSON.stringify(r);
  const once = annotateItemMetadata(r, [a]);
  const twice = annotateItemMetadata(once, [a]);
  assert.equal(JSON.stringify(r), snapshot, "不 mutate 入参");
  assert.deepEqual(Object.keys(once.sections!), ["gz_local", "biz_insight", "policy_market", "tech", "ipo"], "五大分类键不变");
  assert.deepEqual(twice, once, "幂等");
  // tags 不被领域值污染
  assert.ok(once.sections!.gz_local![0].tags.every((t) => !DOMAIN_IDS.includes(t)), "领域值不写进 tags");
});

test("⑥ 板块兜底：IPO 条目判不出领域时归客户经营（+关联财富），其他板块不兜底", () => {
  const ipoItem = item({ title_cn: "深鹏科技：IPO问询中（拟北交所）", summary: "", tags: [] });
  const r: DailyReport = {
    date: "2026-11-28",
    sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [ipoItem] },
    must_read: [],
    insights: [],
  };
  const out = annotateItemMetadata(r, [article({ url: ipoItem.url })]);
  const got = out.sections!.ipo![0];
  assert.equal(got.primary_domain, "customer_growth", "兜底主领域=客户经营与客群增长");
  assert.deepEqual(got.related_domains, ["wealth_aum"], "关联领域带财富（企业主/董监高是私行客源）");
  assert.ok(DOMAIN_IDS.includes(got.primary_domain!), "兜底值必须是配置里的合法 id");

  // 同样的内容放到别的板块：不得兜底（兜底只按板块给，不扩大词表判定面）
  const r2: DailyReport = { ...r, sections: { gz_local: [ipoItem], biz_insight: [], policy_market: [], tech: [], ipo: [] } };
  const out2 = annotateItemMetadata(r2, [article({ url: ipoItem.url })]);
  assert.equal(out2.sections!.gz_local![0].primary_domain, undefined, "非 IPO 板块不享受兜底");

  // 词表本来判得出的 IPO 条目仍走词表（兜底不覆盖既有判定）
  const hitItem = item({ title_cn: "广州某企业AUM规模突破，私行客户增长", summary: "财富管理", tags: ["财富"] });
  const r3: DailyReport = { ...r, sections: { gz_local: [], biz_insight: [], policy_market: [], tech: [], ipo: [hitItem] } };
  const out3 = annotateItemMetadata(r3, [article({ url: hitItem.url })]);
  assert.equal(out3.sections!.ipo![0].primary_domain, "wealth_aum", "词表命中优先于兜底");
});
