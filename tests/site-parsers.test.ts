/**
 * 站点专用解析器（gzinfo per-source provider 移植，2026-09-13）。
 *
 * 核心价值：从 URL 路径 / 页面 `<span>` 提取**真实发布时间**——
 * 通用 cheerio 抓取只认 `<time datetime>`，取不到即被红线#1 丢弃，
 * 这正是 4 个 enabled scrape 源此前产出≈0 的根因。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCctvFinance,
  parseGovCnPolicy,
  parseSinaMoney,
  parse21jingji,
  SITE_PLANS,
} from "../lib/services/collect/site-parsers";
import type { SourceDef } from "../lib/contracts/source";

const src = (id: string): SourceDef =>
  ({ id, name: id, type: "scrape", url: `https://${id}`, category: "finance", tier: "T1" }) as SourceDef;

test("cctv-finance：URL 日期提取 + 视频专题/导航排除", () => {
  const html = [
    '<a href="https://finance.cctv.com/2026/09/12/ARTIabc.shtml">央行开展3000亿MLF操作</a>',
    '<a href="https://finance.cctv.com/2026/09/12/VIDE1234.shtml">视频专题</a>', // 视频排除
    '<a href="https://finance.cctv.com/2026/09/12/index.shtml">首页</a>', // 导航排除
    '<a href="https://finance.cctv.com/2026/09/12/ARTIabc.shtml">重复条目</a>', // 去重
  ].join("");
  const out = parseCctvFinance(html, src("cctv-finance"));
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "央行开展3000亿MLF操作");
  assert.ok(out[0].publishedAt, "应从 URL 提取发布时间");
  assert.equal(new Date(out[0].publishedAt!).toISOString().slice(0, 10), "2026-09-12");
});

test("govcn-policy：li+a+span 三段匹配，日期来自页面标注", () => {
  const html = [
    "<li> <a href=\"/zhengce/content/202608/content_7078320.htm\"> 关于金融支持实体经济的若干举措 </a> <span>2026-09-11</span>",
    "<li> <a href=\"/other/page.htm\"> 非政策文件页 </a> <span>2026-09-11</span>", // content_ 不匹配 → 排除
  ].join("");
  const out = parseGovCnPolicy(html, src("govcn-policy"));
  assert.equal(out.length, 1);
  assert.ok(out[0].url.startsWith("https://www.gov.cn/"), "相对链接应补全为绝对地址");
  assert.ok(out[0].excerpt!.includes("国务院政策"));
  assert.equal(new Date(out[0].publishedAt!).toISOString().slice(0, 10), "2026-09-11");
});

test("sina-money：财富关键词过滤 + URL 日期兜底", () => {
  const html = [
    '<a href="/money/2026-09-12/doc-finance.shtml">银行理财收益率企稳回升</a>', // 命中「理财」
    '<a href="/money/2026-09-12/doc-x.shtml">某明星出席活动引关注热议</a>', // 无财富词 → 排除
    '<a href="javascript:void(0)">短标题</a>', // javascript 排除
  ].join("");
  const out = parseSinaMoney(html, src("sina-money"));
  assert.equal(out.length, 1);
  assert.ok(out[0].excerpt!.includes("财富管理"));
  assert.ok(out[0].url.startsWith("https://finance.sina.com.cn/"), "相对链接应补全");
  assert.equal(new Date(out[0].publishedAt!).toISOString().slice(0, 10), "2026-09-12");
});

test("21jingji：title 属性匹配 + 信贷关键词 + 双频道名", () => {
  const financeHtml =
    '<a href="https://www.21jingji.com/article/202609/20260912.html" title="LPR连续三月按兵不动 房贷利率维持低位">占位</a>';
  const ghmHtml =
    '<a href="/article/202609/20260911.html" title="大湾区消费贷贴息扩围 银行加码普惠金融">占位</a>';
  const a = parse21jingji(financeHtml, "金融", src("21jingji-finance"));
  const b = parse21jingji(ghmHtml, "粤港澳", src("21jingji-finance"));
  assert.equal(a.length, 1);
  assert.ok(a[0].excerpt!.includes("21财经·金融"));
  assert.equal(b.length, 1);
  assert.ok(b[0].excerpt!.includes("21财经·粤港澳"));
  assert.ok(b[0].url.startsWith("https://www.21jingji.com/"), "相对链接应补全");
});

test("SITE_PLANS：4 个 enabled scrape 源全部有专用计划", () => {
  for (const id of ["cctv-finance", "govcn-policy", "sina-money", "21jingji-finance"]) {
    assert.ok(SITE_PLANS[id], `${id} 缺少专用抓取计划`);
  }
  assert.equal(SITE_PLANS["21jingji-finance"].urls.length, 2, "21jingji 应含金融+粤港澳双频道");
  // 计划必须带浏览器头（这些源有 UA 校验）
  assert.ok(SITE_PLANS["cctv-finance"].headers["User-Agent"].includes("Mozilla"));
});
