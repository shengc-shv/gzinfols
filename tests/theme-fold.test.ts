/**
 * F1 事件级去重调优（2026-09-17 用户拍板：上限 4 + 合并块保留全部进展节点）。
 *
 * 锁四件事：
 *  ① `capByThemeAndTierWithFold` 的 kept 与 `capByThemeAndTier` **逐条一致**
 *     （委托同一实现，防两套聚类逻辑漂移）；
 *  ② 被裁剪的同主题报道**不再静默丢弃**：降级为「进展节点」；
 *  ③ 收纳上限 THEME_MAX_ITEMS=4 作用于「主卡 + 节点」，超出才真正截断；
 *  ④ 渲染层把节点折叠在卡片内（`<details class="progress-nodes">`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  THEME_MAX_ITEMS,
  capByThemeAndTier,
  capByThemeAndTierWithFold,
} from "../lib/services/assemble/group";
import { renderArticleHtml } from "../lib/services/render/cards";
import type { ArticleInput } from "../lib/contracts/article";

function art(i: number, title: string, tier: "T1" | "T1.5" | "T2", date = "2026-09-17"): ArticleInput {
  return {
    sourceId: `src-${tier}`,
    source: `来源${tier}`,
    title,
    url: `https://example.com/a${i}`,
    excerpt: "",
    category: "finance",
    publishedAt: new Date(`${date}T08:00:00+08:00`),
    tier,
    fetchedToday: true,
    isIpo: false,
  } as unknown as ArticleInput;
}

// 同一主题（命中 gz-credit 主题词「经营贷」）的 5 篇报道，tier 分布 T1 / T2 混杂
const THEME_TITLE = "经营贷利率上行";
const five = [
  art(1, `${THEME_TITLE}：某股份行主动缩规模`, "T2"),
  art(2, `${THEME_TITLE}：监管摸底贸易类准入`, "T2"),
  art(3, `${THEME_TITLE}，多地跟进调整`, "T1"),
  art(4, `${THEME_TITLE}对小微客群的影响`, "T2"),
  art(5, `某行财报披露：${THEME_TITLE}`, "T2"),
];

test("① 与 capByThemeAndTier 的 kept 逐条一致（委托单一实现）", () => {
  for (const items of [five, five.slice(0, 3), five.slice(0, 2), []]) {
    const plain = capByThemeAndTier(items, 2);
    const folded = capByThemeAndTierWithFold(items, 2).kept;
    assert.deepEqual(
      folded.map((a) => a.url),
      plain.map((a) => a.url),
      "带折叠的版本不得改变 kept 集合（否则会悄悄改变主卡版式）",
    );
  }
});

test("② 被裁剪的同主题报道降级为进展节点，不再静默丢弃", () => {
  const { kept, nodesByUrl } = capByThemeAndTierWithFold(five, 2);
  const nodeCount = [...nodesByUrl.values()].reduce((n, l) => n + l.length, 0);
  assert.ok(kept.length >= 1, "至少留一张主卡");
  assert.equal(
    kept.length + nodeCount,
    THEME_MAX_ITEMS,
    `5 篇同主题应收纳 ${THEME_MAX_ITEMS} 条（主卡 + 节点），不丢信息`,
  );
  // 节点确实挂在自己的主卡上，且不含主卡自身
  for (const [url, nodes] of nodesByUrl) {
    const owner = kept.find((k) => k.url === url);
    assert.ok(owner, "节点必须挂在 kept 的主卡上（否则渲染时找不到宿主）");
    assert.ok(!nodes.some((n) => n.url === url), "节点列表不得包含主卡自己");
  }
  const nodeTitles = [...nodesByUrl.values()].flat().map((n) => n.title);
  assert.ok(nodeTitles.some((t) => t.includes("监管摸底")), "原被丢弃的报道应出现在节点里");
  assert.ok(nodeTitles.some((t) => t.includes("小微客群")), "同 tier 的多余报道也应保留为节点");
});

test("③ 收纳上限 4 只对「主卡 + 节点」合计生效，超出才截断", () => {
  const many = [...five, art(6, `${THEME_TITLE}：追加解读`, "T2"), art(7, `${THEME_TITLE}：境外视角`, "T2")];
  const { kept, nodesByUrl } = capByThemeAndTierWithFold(many, 2);
  const total = kept.length + [...nodesByUrl.values()].reduce((n, l) => n + l.length, 0);
  assert.equal(total, THEME_MAX_ITEMS, "上限 4：7 篇同主题只收纳 4 篇，其余才丢弃");
  assert.equal(THEME_MAX_ITEMS, 4, "上限值即用户拍板值（改它需重新拍板）");
});

test("④ 无主题词的条目独立成卡，不产生节点；tier 替换时换下的条目也保留", () => {
  const unrelated = [art(11, "完全无关的一条消息", "T2"), art(12, "另一条无关消息", "T2")];
  const r1 = capByThemeAndTierWithFold(unrelated, 2);
  assert.equal(r1.kept.length, 2, "无主题词条目不参与聚类");
  assert.equal(r1.nodesByUrl.size, 0, "无主题词不产生节点");

  // T1 后到：应顶掉簇内最低 tier（T2）的主卡，被顶下来的 T2 进节点
  const lateT1 = [...five.slice(0, 2), art(3, `${THEME_TITLE}，官方定调`, "T1")];
  const { kept, nodesByUrl } = capByThemeAndTierWithFold(lateT1, 2);
  const allUrls = new Set([...kept, ...[...nodesByUrl.values()].flat()].map((a) => a.url));
  assert.ok(allUrls.has("https://example.com/a3"), "后到的 T1 必须在收纳集合内（tier 优先）");
  assert.equal(
    kept.length + [...nodesByUrl.values()].reduce((n, l) => n + l.length, 0),
    3,
    "3 篇都在 4 条上限内 → 一条不丢",
  );
});

test("⑤ 渲染：节点折叠在卡片内（details），带日期与来源", () => {
  const withNodes: ArticleInput = {
    ...art(1, "经营贷利率上行", "T1"),
    progressNodes: [
      { title: "多地跟进调整", url: "https://example.com/a3", source: "来源T2", date: "09/16" },
    ],
  };
  const html = renderArticleHtml(withNodes);
  assert.ok(html.includes('class="progress-nodes"'), "须渲染折叠容器");
  assert.ok(html.includes("同主题另有 1 条进展"), "折叠标题须说明有几条（否则读者不知道里面有东西）");
  assert.ok(html.includes("多地跟进调整"), "节点标题须可读");
  assert.ok(html.includes("09/16") && html.includes("来源T2"), "节点带日期与来源（可判断新旧与出处）");
  assert.ok(html.includes('class="sum"') || !html.includes("<p"), "不得破坏既有卡片结构");

  const noNodes = renderArticleHtml(art(2, "普通条目", "T2"));
  assert.ok(!noNodes.includes("progress-nodes"), "无节点时不渲染空容器");
});
