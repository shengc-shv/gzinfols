/**
 * 经营重点追踪页（WP9 · scripts/lib/focus-page.mjs）守护。
 *
 * 钉住的是**页面口径**，不是 HTML 长相：
 *  ① 空台账 → 空态页（入口不 404 是第一硬要求），且不假装有数据；
 *  ② 时间线只列 M2/M3；M1 只出现在「相关 N 条」计数里（与台账契约同口径）；
 *  ③ 重点定义取**当日那个配置版本**的归档 —— 已下线/改过词的重点也能按当时口径解释；
 *  ④ 孤儿命中（hits 有、当日 focuses 汇总没有）不渲染；
 *  ⑤ 外部标题一律转义。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderFocusPage } from "../scripts/lib/focus-page.mjs";

const TODAY = "2026-11-28";

function def(id: string, name: string, layer: "annual" | "quarterly" | "temporary", extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    description: "",
    layer,
    grade: "S",
    status: "active",
    start_date: "2026-01-01",
    end_date: "2026-12-31",
    domains: ["wealth_aum"],
    core_keywords: [],
    keywords: [],
    concepts: [],
    exclude_keywords: [],
    source: "测试",
    ...extra,
  };
}

function hit(over: Record<string, unknown>) {
  return {
    focusId: "a26_aum",
    level: "M3" as const,
    bonus: 15,
    reason: "标题命中 AUM",
    itemId: "itm-1",
    url: "https://e.com/1",
    title: "AUM 开门红",
    source: "测试源",
    itemDate: "11/19",
    section: "gz_local",
    ...over,
  };
}

test("① 空台账 → 空态页：不崩、说清为什么空，不产出假数据", () => {
  const html = renderFocusPage({
    ledger: { days: [] },
    archive: { versions: [] },
    generatedAt: TODAY,
    latest: TODAY,
    today: TODAY,
  });
  assert.ok(html.includes("还没有实质命中记录"), "空态说明");
  assert.ok(html.includes("命中台账从首期运行起逐日累积"), "说明数据会慢慢累积");
  assert.ok(!html.includes('class="fh"'), "不得有命中条目");
  assert.ok(html.includes(`href="./${TODAY}/${TODAY}.html"`), "返回按钮指向最新一期");
  // 缺文件（null）与空数组等价：不抛错
  assert.ok(renderFocusPage({ ledger: null, archive: null, latest: TODAY, today: TODAY }).includes("还没有实质命中记录"));
});

test("② 有命中：期次覆盖 / 命中条数 / 层级 / 依据 / 卡片标记 / 板块中文名", () => {
  const html = renderFocusPage({
    ledger: {
      days: [
        {
          date: TODAY,
          version: "f-11111111",
          focuses: [
            { id: "a26_aum", name: "AUM 规模与结构优化", layer: "annual", grade: "S", count: 3, high: 2, domains: ["wealth_aum"] },
          ],
          hits: [
            hit({ inMustRead: true }),
            hit({ focusId: "a26_aum", level: "M2", bonus: 10, title: "存款搬家", isRisk: true, section: "policy_market" }),
          ],
        },
      ],
    },
    archive: { versions: [{ version: "f-11111111", focuses: [def("a26_aum", "AUM 规模与结构优化", "annual")] }] },
    generatedAt: TODAY,
    latest: TODAY,
    today: TODAY,
    domainLabels: { wealth_aum: "财富管理与AUM" },
  });
  assert.ok(html.includes("当前覆盖 1 个期次"), "覆盖期次");
  assert.ok(html.includes("累计 2 条实质命中"), "累计命中条数");
  assert.ok(html.includes("AUM 规模与结构优化") && html.includes("年度重点"));
  assert.ok(html.includes("命中依据：标题命中 AUM"), "命中依据可核对");
  assert.ok(html.includes("今日必读") && html.includes("风险条目") && html.includes("进商机") === false);
  assert.ok(html.includes("广州本地") && html.includes("政策与市场"), "板块名渲染中文（不是 key）");
  assert.ok(html.includes("关联领域 财富管理与AUM"), "领域名走调用方传入的真源，不显示英文 id");
});

test("③ M1 只进「相关 N 条」，永不进时间线", () => {
  const html = renderFocusPage({
    ledger: {
      days: [
        {
          date: TODAY,
          version: "f-11111111",
          focuses: [
            { id: "a26_aum", name: "AUM 规模与结构优化", layer: "annual", grade: "S", count: 9, high: 0, domains: ["wealth_aum"] },
          ],
          hits: [],
        },
      ],
    },
    archive: { versions: [] },
    generatedAt: TODAY,
    latest: TODAY,
    today: TODAY,
  });
  assert.ok(html.includes("相关 9 条"), "M1 计入相关条数");
  assert.ok(html.includes("实质命中 <b>0</b> 条"), "实质命中为 0");
  assert.ok(!html.includes('class="fh"'), "弱相关不占时间线");
  assert.ok(html.includes("所选时间窗内没有实质命中"), "给了下一步动作，不是白屏");
});

test("④ 定义按当日版本取（历史保真）：已下线重点仍能用当时的定义解释", () => {
  const html = renderFocusPage({
    ledger: {
      days: [
        {
          date: "2026-11-05",
          version: "f-old00000",
          focuses: [
            { id: "q_legacy", name: "旧季度重点", layer: "quarterly", grade: "A", count: 2, high: 1, domains: ["wealth_aum"] },
          ],
          hits: [hit({ focusId: "q_legacy", title: "旧重点命中稿" })],
        },
      ],
    },
    archive: {
      versions: [
        {
          version: "f-old00000",
          firstSeen: "2026-11-01",
          lastSeen: "2026-11-05",
          focuses: [def("q_legacy", "旧季度重点", "quarterly", { keywords: ["当时的词甲", "当时的词乙"] })],
        },
        // 新版本里这条已经下线 —— 页面不得因此丢掉历史命中的定义
        { version: "f-new00000", firstSeen: "2026-11-06", lastSeen: TODAY, focuses: [] },
      ],
    },
    generatedAt: TODAY,
    latest: TODAY,
    today: TODAY,
  });
  assert.ok(html.includes("旧季度重点") && html.includes("本季主攻"), "季度重点照常展示（专题页全层级）");
  assert.ok(html.includes("当时的词甲"), "用当日版本的词表解释，而不是最新版本");
  assert.ok(html.includes("当时的判定词表（2 个）"), "词表数量与当日定义一致");
});

test("⑤ 孤儿命中不渲染；外部标题转义；无 url 不出链接", () => {
  const html = renderFocusPage({
    ledger: {
      days: [
        {
          date: TODAY,
          version: "f-11111111",
          focuses: [
            { id: "a26_aum", name: "AUM 规模与结构优化", layer: "annual", grade: "S", count: 1, high: 1, domains: [] },
          ],
          hits: [
            hit({ focusId: "ghost_focus", title: "孤儿命中" }),
            hit({ title: '<script>alert("x")</script>', url: "" }),
          ],
        },
      ],
    },
    archive: { versions: [] },
    generatedAt: TODAY,
    latest: TODAY,
    today: TODAY,
  });
  assert.ok(!html.includes("孤儿命中"), "当日汇总里没有的重点，其命中行不渲染");
  assert.ok(!html.includes("<script>alert"), "标题转义");
  assert.ok(html.includes("&lt;script&gt;"), "转义后的可见文本");
  assert.ok(!html.includes('<a class="fh-t" href=""'), "无 url 不造空链接");
});

test("⑥ 时间线渲染全量（时间窗切换是前端显隐，「全部」才看得到更早期次）", () => {
  const html = renderFocusPage({
    ledger: {
      days: [
        {
          date: "2026-09-01",
          version: "f-11111111",
          focuses: [
            { id: "a26_aum", name: "AUM 规模与结构优化", layer: "annual", grade: "S", count: 1, high: 1, domains: [] },
          ],
          hits: [hit({ title: "两个月前的命中稿" })],
        },
      ],
    },
    archive: { versions: [] },
    generatedAt: TODAY,
    latest: TODAY,
    today: TODAY,
  });
  assert.ok(html.includes("两个月前的命中稿"), "超出默认窗口也要在 DOM 里（否则点「全部」是空的）");
  assert.ok(html.includes(`id="f-nowin"`), "默认 30 天窗口内无命中 → 给出提示块");
  assert.ok(/id="f-nowin" hidden/.test(html) === false, "窗口内确实没有命中，提示块默认可见");
});
