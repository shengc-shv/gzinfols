/**
 * C1 客群切分轴 + 角色视图（2026-09-17）。
 *
 * 锁四件事：
 *  ① 卡片带 `data-segs`（客群段位），且与商机洞察的 seg-chip **同源**（mapTagsToSegments）；
 *  ② 客群成为**一等筛选轴**：多段位时才出现（单段位无筛选价值，不添噪声）；
 *  ③ 客群标签**可点**（原来是纯展示 span，打标成果读者用不上）→ 必须是 button + data-seg；
 *  ④ 角色视图条按条线一键筛选，预设与筛选条的 data-tags 匹配口径一致。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderFilterBarForPanel,
  renderRoleBar,
  ROLE_VIEWS,
  SEG_FILTER_LABEL,
} from "../lib/services/render/filter-bar";
import { renderReportItemHtml } from "../lib/services/render/report-item";
import { renderHtml } from "../lib/services/render";
import { mapTagsToSegments } from "../lib/services/classify/customer-segment";
import type { DailyReport, ReportItem } from "../lib/contracts/report";

function item(over: Partial<ReportItem>): ReportItem {
  return {
    url: `https://example.com/${Math.random().toString(36).slice(2)}`,
    title_cn: "条目",
    source: "证券时报",
    source_type: "media",
    date: "09/17",
    summary: "摘要。",
    importance: 2,
    rank: 1,
    tags: [],
    locale: "national",
    ...over,
  } as ReportItem;
}

const WEALTH = item({ title_cn: "理财规模回升", tags: ["财富"] });
const PRIVATE = item({ title_cn: "私行家族信托落地", tags: ["私行"] });
const PUHUI = item({ title_cn: "小微企业普惠贷款贴息", tags: ["信贷"] });

test("① 卡片 data-segs 与客群映射同源", () => {
  const html = renderReportItemHtml(WEALTH);
  const segs = mapTagsToSegments(WEALTH.tags, WEALTH.title_cn ?? "");
  assert.ok(html.includes('data-segs="'), "正文卡片必须带 data-segs（筛选轴的数据基础）");
  for (const s of segs) assert.ok(html.includes(s), `data-segs 应含 ${s}`);
  assert.deepEqual(mapTagsToSegments(["私行"]), ["中高端客群(过亿资产)"]);
  assert.deepEqual(mapTagsToSegments(["信贷"], "小微企业普惠贷款"), ["普惠小微贷款客户"]);
});

test("② 客群成为一等筛选轴：多段位出现，单段位不出现", () => {
  const multi = renderFilterBarForPanel([WEALTH, PRIVATE, PUHUI]);
  assert.ok(multi.includes('data-group="seg"'), "多段位时须渲染客群筛选轴");
  assert.ok(multi.includes("客群"), "须有客群维度标题");
  for (const s of [WEALTH, PRIVATE, PUHUI]) {
    const seg = mapTagsToSegments(s.tags, s.title_cn ?? "")[0];
    assert.ok(multi.includes(`data-filter="${seg}"`), `须有 ${seg} 的筛选 chip`);
  }
  const single = renderFilterBarForPanel([WEALTH]);
  assert.ok(!single.includes('data-group="seg"'), "只有单一客群时不渲染（无筛选价值）");
  // chip 文案走短名表，避免长段位名挤爆窄屏
  assert.equal(SEG_FILTER_LABEL["中高端客群(过亿资产)"], "高端客户");
});

test("③ 客群标签可点（button + data-seg），不再是纯展示 span", () => {
  const report = {
    date: "2026-09-17",
    hero_line: "定调",
    must_read: [],
    insights: [
      {
        topic: "南沙跨境客群对接",
        impact: "影响",
        action: "行动",
        tags: ["客群"],
        segments: ["中高端客群(过亿资产)"],
        sources: [{ title: "x", url: "https://example.com/i" }],
      },
    ],
    sections: { gz_local: [WEALTH], biz_insight: [], policy_market: [], tech: [], ipo: [] },
  } as unknown as DailyReport;
  const html = renderHtml(report);
  assert.ok(/<button type="button" class="seg-chip[^>]*data-seg="中高端客群\(过亿资产\)"/.test(html), "客群标签须是可点的 button");
  assert.ok(html.includes('id="role-views"'), "角色预设须内联给脚本（单一真源）");
  assert.ok(html.includes("applySegFilter"), "脚本须有客群筛选联动");
  assert.ok(html.includes("applyRole"), "脚本须有角色切换联动");
  assert.ok(html.includes('id="role-hint"'), "须有当前视图提示（让读者知道滤镜生效了）");
});

test("④ 角色视图：五类条线预设，tags 与筛选条业务线口径一致", () => {
  assert.deepEqual(
    ROLE_VIEWS.map((r) => r.id),
    ["exec", "biz", "private", "wealth", "credit"],
  );
  const bar = renderRoleBar();
  for (const r of ROLE_VIEWS) {
    assert.ok(bar.includes(`data-role="${r.id}"`), `须有角色 chip：${r.label}`);
    assert.ok(bar.includes(r.label));
  }
  assert.equal(ROLE_VIEWS[0].tags.length, 0, "行长 = 全部（无预设筛选）");
  assert.deepEqual(ROLE_VIEWS.find((r) => r.id === "credit")?.tags, ["信贷"]);
  // 预设的 tags 必须是筛选条认得的业务线值（否则点了没效果）
  const bar2 = renderFilterBarForPanel([WEALTH, PRIVATE, PUHUI, item({ tags: ["信贷", "客群"] })]);
  for (const r of ROLE_VIEWS) {
    for (const t of r.tags) {
      assert.ok(bar2.includes(`data-group="tag" data-filter="${t}"`), `预设值 ${t} 须存在于业务线筛选条`);
    }
  }
  // 角色条内联的 JSON 不得被 HTML 解析（XSS/破坏结构）
  assert.ok(!bar.includes('</script><script>'), "内联 JSON 不得逃逸出 script 标签");
});
