/**
 * groupRaw 多归桶测试（多标签）：一条信息命中多个业务线标签 → 进多个子组。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupRaw } from "../lib/services/render";
import { loadSources } from "../lib/orchestrator";
import { NodeFsAdapter } from "../lib/adapters";
import type { ArticleInput } from "../lib/contracts/article";
import type { } from "../lib/contracts/report";

// 2.0：registry 由组合根 loadSources 从 sources.config.json 读（唯一真源）
const registry = await loadSources(new NodeFsAdapter());

test("groupRaw: subcategories 多值 → 同一 URL 进多个业务线子组", () => {
  const url = "https://x/multi";
  const articles: ArticleInput[] = [
    {
      sourceId: "gz-gov",
      source: "广州政府",
      title: "广州多项金融政策落地影响多个业务线",
      url,
      excerpt: "",
      category: "finance",
      subcategories: ["gz-policy", "cn-policy"], // AI 多标签：同时影响广州政策 + 国家级政策
      publishedAt: new Date("2026-08-19T08:00:00Z"),
      fetchedToday: true, isIpo: false,
    },
  ];
  const raw = groupRaw(articles, registry);
  const finance = raw.finance;
  const gzPolicy = finance.find((s) => s.id === "gz-policy");
  const cnPolicy = finance.find((s) => s.id === "cn-policy");
  assert.ok(gzPolicy, "应构建 gz-policy 子组");
  assert.ok(cnPolicy, "应构建 cn-policy 子组");
  const inGz = gzPolicy!.sources.some((src) => src.items.some((a) => a.url === url));
  const inCn = cnPolicy!.sources.some((src) => src.items.some((a) => a.url === url));
  assert.ok(inGz, "条目应出现在 gz-policy 组（多归桶）");
  assert.ok(inCn, "条目应出现在 cn-policy 组（多归桶）");
});

test("groupRaw: 无 AI 标签时回退注册表源级 subcategory（单桶）", () => {
  const url = "https://x/single";
  const articles: ArticleInput[] = [
    {
      sourceId: "gz-gov",
      source: "广州政府",
      title: "广州政策文件",
      url,
      excerpt: "",
      category: "finance",
      publishedAt: new Date("2026-08-19T08:00:00Z"),
      fetchedToday: true, isIpo: false,
    },
  ];
  const raw = groupRaw(articles, registry);
  const gzPolicy = raw.finance.find((s) => s.id === "gz-policy");
  assert.ok(gzPolicy, "gz-gov 源按注册表归 gz-policy 组");
  const inGz = gzPolicy!.sources.some((src) => src.items.some((a) => a.url === url));
  assert.ok(inGz);
});

// —— 上位法传导（「包含关系」）：finance（宏观政策）板块的全国/省政策 → 广州商机板块镜像 ——
function findSub(raw: ReturnType<typeof groupRaw>, cat: "gz" | "finance", subId: string) {
  return raw[cat].find((s) => s.id === subId);
}

test("groupRaw: 全国公积金政策（finance/cn-policy）传导镜像到 广州商机·个人信贷", () => {
  const url = "https://x/gjj";
  const articles: ArticleInput[] = [
    {
      sourceId: "govcn-policy",
      source: "中国政府网",
      title: "国务院关于修改《住房公积金管理条例》的决定",
      url,
      excerpt: "",
      category: "finance",
      subcategory: "cn-policy",
      publishedAt: new Date("2026-08-19T08:00:00Z"),
      fetchedToday: true, isIpo: false,
    },
  ];
  const raw = groupRaw(articles, registry);
  // 宏观政策板块原样保留（国家政策）
  const cnPolicy = findSub(raw, "finance", "cn-policy");
  assert.ok(cnPolicy, "finance 板块应保留 cn-policy 子组");
  assert.ok(
    cnPolicy!.sources.some((src) => src.items.some((a) => a.url === url)),
    "宏观板块应保留原条目",
  );
  // 广州商机板块合并流（gz-all）应含传导条目（2026-08-21：不再分业务线子标签）
  const gzAll = findSub(raw, "gz", "gz-all");
  assert.ok(gzAll, "gz 板块应构建 gz-all 合并子组");
  const mirrored = gzAll!.sources.flatMap((s) => s.items).filter((a) => a.url === url);
  assert.equal(mirrored.length, 1, "广州商机合并流应恰好出现 1 条传导条目");
  assert.equal(mirrored[0]!.category, "gz", "镜像条目 category 应覆盖为 gz");
  assert.deepEqual(mirrored[0]!.subcategories, ["gz-credit"]);
});

test("groupRaw: 上位政策命中多个业务线 → 广州商机合并流传导", () => {
  const url = "https://x/multi-line";
  const articles: ArticleInput[] = [
    {
      sourceId: "govcn-policy",
      source: "中国政府网",
      title: "国务院出台新政：公积金贷款与住房消费促进措施",
      url,
      excerpt: "",
      category: "finance",
      subcategory: "cn-policy",
      publishedAt: new Date("2026-08-19T08:00:00Z"),
      fetchedToday: true, isIpo: false,
    },
  ];
  const raw = groupRaw(articles, registry);
  const gzAll = findSub(raw, "gz", "gz-all");
  assert.ok(gzAll, "应构建 gz-all 合并子组");
  assert.ok(
    gzAll!.sources.some((src) => src.items.some((a) => a.url === url)),
    "命中多个业务线的上位政策应出现在 gz-all 合并流",
  );
});

test("groupRaw: 与广州业务线无关的 finance 条目不传导", () => {
  const url = "https://x/forest";
  const articles: ArticleInput[] = [
    {
      sourceId: "govcn-policy",
      source: "中国政府网",
      title: "国务院批复森林年采伐限额",
      url,
      excerpt: "",
      category: "finance",
      subcategory: "cn-policy",
      publishedAt: new Date("2026-08-19T08:00:00Z"),
      fetchedToday: true, isIpo: false,
    },
  ];
  const raw = groupRaw(articles, registry);
  const gzAny = raw.gz.some((sub) => sub.sources.some((src) => src.items.some((a) => a.url === url)));
  assert.ok(!gzAny, "无关政策不应出现在广州商机板块");
});

test("groupRaw: relevant=false 的 finance 条目不传导也不进宏观面板", () => {
  const url = "https://x/noise";
  const articles: ArticleInput[] = [
    {
      sourceId: "govcn-policy",
      source: "中国政府网",
      title: "国务院关于历史文化名城保护的决定",
      url,
      excerpt: "",
      category: "finance",
      subcategory: "cn-policy",
      relevant: false,
      publishedAt: new Date("2026-08-19T08:00:00Z"),
      fetchedToday: true, isIpo: false,
    },
  ];
  const raw = groupRaw(articles, registry);
  const inFinance = raw.finance.some((sub) => sub.sources.some((src) => src.items.some((a) => a.url === url)));
  const inGz = raw.gz.some((sub) => sub.sources.some((src) => src.items.some((a) => a.url === url)));
  assert.ok(!inFinance, "relevant=false 不进宏观面板");
  assert.ok(!inGz, "relevant=false 不传导到广州商机");
});

// —— 标签内主题去重（同主题 ≤2 条、2 条必须 tier 不同；2026-08-21 起在广州商机 gz-all 合并流内）——
test("groupRaw: gz-all 内 4 条公积金同主题 → 只留 2 条且 tier 不同", () => {
  const mk = (title: string, sourceId: string, source: string, tier: any, url: string): ArticleInput => ({
    sourceId, source, title, url, excerpt: "",
    category: "finance", subcategory: "cn-policy", tier,
    publishedAt: new Date("2026-08-19T08:00:00Z"), fetchedToday: true, isIpo: false,
  });
  const articles: ArticleInput[] = [
    mk("住房公积金提取和使用范围拓宽，9月20日起施行→", "cctv-finance", "央视财经", "T1.5", "https://x/gjj1"),
    mk("国务院关于修改《住房公积金管理条例》的决定", "govcn-policy", "中国政府网", "T1", "https://x/gjj2"),
    mk("重磅新政来了，《住房公积金管理条例》正式公布", "21jingji-finance", "21财经", "T2", "https://x/gjj3"),
    mk("住房公积金政策迎大变化！9月20日起施行", "21jingji-finance", "21财经", "T2", "https://x/gjj4"),
  ];
  const raw = groupRaw(articles, registry);
  const gzAll = findSub(raw, "gz", "gz-all");
  assert.ok(gzAll, "应构建 gz-all 合并子组");
  const items = gzAll!.sources.flatMap((s) => s.items).filter((a) => a.title.includes("公积金"));
  assert.ok(items.length <= 2, `同主题应 ≤2 条，实际 ${items.length} 条`);
  if (items.length === 2) {
    assert.notEqual(items[0]!.tier, items[1]!.tier, "2 条必须来源等级不同");
  }
  assert.ok(items.some((a) => a.tier === "T1"), "应保留 T1 国务院原文");
});

test("groupRaw: gz-all 内同 tier 同主题只留 1 条", () => {
  const mk = (title: string, url: string, tier: any): ArticleInput => ({
    sourceId: "21jingji-finance", source: "21财经", title, url, excerpt: "",
    category: "finance", subcategory: "cn-policy", tier,
    publishedAt: new Date("2026-08-19T08:00:00Z"), fetchedToday: true, isIpo: false,
  });
  const articles: ArticleInput[] = [
    mk("重磅新政来了，《住房公积金管理条例》正式公布", "https://x/a", "T2"),
    mk("住房公积金政策迎大变化！9月20日起施行", "https://x/b", "T2"),
  ];
  const raw = groupRaw(articles, registry);
  const gzAll = findSub(raw, "gz", "gz-all");
  const items = gzAll!.sources.flatMap((s) => s.items).filter((a) => a.title.includes("公积金"));
  assert.equal(items.length, 1, "同 tier 同主题只留 1 条");
});

test("groupRaw: 不同主题（公积金 vs 房贷）各自保留", () => {
  const articles: ArticleInput[] = [
    {
      sourceId: "govcn-policy", source: "中国政府网",
      title: "国务院关于修改《住房公积金管理条例》的决定",
      url: "https://x/gjj", excerpt: "", category: "finance", subcategory: "cn-policy",
      tier: "T1" as const, publishedAt: new Date("2026-08-19T08:00:00Z"), fetchedToday: true, isIpo: false,
    },
    {
      sourceId: "21jingji-finance", source: "21财经",
      title: "多地房贷利率下调 首付比例降低",
      url: "https://x/fangdai", excerpt: "", category: "finance", subcategory: "cn-policy",
      tier: "T2" as const, publishedAt: new Date("2026-08-19T08:00:00Z"), fetchedToday: true, isIpo: false,
    },
  ];
  const raw = groupRaw(articles, registry);
  const gzAll = findSub(raw, "gz", "gz-all");
  const urls = gzAll!.sources.flatMap((s) => s.items).map((a) => a.url);
  assert.ok(urls.includes("https://x/gjj"), "公积金主题保留");
  assert.ok(urls.includes("https://x/fangdai"), "房贷主题保留（不同主题不互删）");
});

test("groupRaw: 无主题词的条目不误删", () => {
  const articles: ArticleInput[] = [
    {
      sourceId: "govcn-policy", source: "中国政府网",
      title: "国务院批复森林年采伐限额",
      url: "https://x/f1", excerpt: "", category: "finance", subcategory: "cn-policy",
      tier: "T1" as const, publishedAt: new Date("2026-08-19T08:00:00Z"), fetchedToday: true, isIpo: false,
    },
    {
      sourceId: "govcn-policy", source: "中国政府网",
      title: "国务院关于法治宣传教育第九个五年规划的批复",
      url: "https://x/f2", excerpt: "", category: "finance", subcategory: "cn-policy",
      tier: "T1" as const, publishedAt: new Date("2026-08-19T08:00:00Z"), fetchedToday: true, isIpo: false,
    },
  ];
  const raw = groupRaw(articles, registry);
  const cnPolicy = findSub(raw, "finance", "cn-policy");
  const urls = cnPolicy!.sources.flatMap((s) => s.items).map((a) => a.url);
  assert.ok(urls.includes("https://x/f1") && urls.includes("https://x/f2"), "无主题词条目全部保留");
});

test("groupRaw: 历史条目无 tier → 按 registry 补齐后主题去重保留 2 条不同等级", () => {
  // 模拟历史库条目：不带 tier（真实历史条目 buildRolling 后 tier=undefined）
  const mk = (title: string, sourceId: string, source: string, url: string): ArticleInput => ({
    sourceId, source, title, url, excerpt: "",
    category: "finance", subcategory: "cn-policy",
    publishedAt: new Date("2026-08-19T08:00:00Z"), fetchedToday: true, isIpo: false,
  });
  const articles: ArticleInput[] = [
    mk("住房公积金提取和使用范围拓宽，9月20日起施行→", "cctv-finance", "央视财经", "https://x/a"),
    mk("重磅新政来了，《住房公积金管理条例》正式公布", "21jingji-finance", "21财经", "https://x/b"),
    mk("国务院关于修改《住房公积金管理条例》的决定", "govcn-policy", "中国政府网", "https://x/c"),
  ];
  const raw = groupRaw(articles, registry);
  const gzAll = findSub(raw, "gz", "gz-all");
  const items = gzAll!.sources.flatMap((s) => s.items).filter((a) => a.title.includes("公积金"));
  assert.ok(items.length === 2, `应保留 2 条不同 tier，实际 ${items.length}`);
  const tiers = items.map((a) => a.tier).sort();
  assert.deepEqual(tiers, ["T1", "T1.5"], "应补 tier 并保留 T1 国务院 + T1.5 央视");
  assert.ok(items.some((a) => a.sourceId === "govcn-policy"), "T1 官方原文应保留");
});

test("groupRaw: 簇满时 tier 高的替换 tier 低的（T1 原文不被 T2 媒体挤掉）", () => {
  // 时间序：T2（最新）→ T1.5 → T1（最旧）——cap 应保留 T1 + T1.5，而非时间优先的 T2 + T1.5
  const mk = (title: string, sourceId: string, source: string, tier: any, pub: string, url: string): ArticleInput => ({
    sourceId, source, title, url, excerpt: "",
    category: "finance", subcategory: "cn-policy", tier,
    publishedAt: new Date(pub), fetchedToday: true, isIpo: false,
  });
  const articles: ArticleInput[] = [
    mk("住房公积金政策迎大变化！9月20日起施行", "21jingji-finance", "21财经", "T2", "2026-08-19T10:00:00Z", "https://x/t2"),
    mk("住房公积金提取和使用范围拓宽，9月20日起施行", "cctv-finance", "央视财经", "T1.5", "2026-08-19T08:00:00Z", "https://x/t15"),
    mk("国务院关于修改《住房公积金管理条例》的决定", "govcn-policy", "中国政府网", "T1", "2026-08-18T00:00:00Z", "https://x/t1"),
  ];
  const raw = groupRaw(articles, registry);
  const gzAll = findSub(raw, "gz", "gz-all");
  const items = gzAll!.sources.flatMap((s) => s.items).filter((a) => a.title.includes("公积金"));
  assert.equal(items.length, 2);
  const hasT1 = items.some((a) => a.tier === "T1" && a.sourceId === "govcn-policy");
  const hasT15 = items.some((a) => a.tier === "T1.5");
  assert.ok(hasT1 && hasT15, "应保留 T1 国务院 + T1.5 央视（tier 优先替换 T2）");
});
