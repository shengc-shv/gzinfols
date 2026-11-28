/**
 * 增量三态校准守护（2026-11-28 · sc 定向修订任务书 · 任务四）。
 *
 * 修前实测：近 30 期 must_read 三态合计 **新增 0 / 有进展 0 / 续报 36**。
 * 根因不是阈值，是「当天被当成历史」：
 *   ① 上线 run 里本次播报先写进 today 暂存区并落盘，delta 标注随后再读 → 命中自己；
 *   ② 当天播报经 settleTodayIntoEvents / 跨日 beginDay 已并入 events。
 * 修法：调用方传 `excludeDate=当天`（pipeline 用运行前快照 + 排除当天），
 * 并给 changed 加「必须有可核验新事实」的硬约束。
 *
 * 本文件覆盖任务书 4.7 的 9 个回放场景 + 上述两个根因 + changed 证据约束。
 * 🔴 判定阈值与匹配规则**一个都没改**（测试里可以看到阈值常量仍被锁）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deltaOf, DELTA_PROGRESS_THRESHOLD } from "../lib/services/assemble/delta";
import { buildHistoricalEventView } from "../lib/services/memory/event-decide";
import type { EventMemoryStore, EventRecord } from "../lib/services/memory/event-types";

const DAY = "2026-11-28";
const PREV = "2026-11-27";

function record(over: Partial<EventRecord> = {}): EventRecord {
  return {
    id: "房贷|贴息",
    topicTags: ["住房金融"],
    anchors: ["房贷", "贴息", "政策"],
    kind: "generic",
    firstBroadcastAt: PREV,
    lastBroadcastAt: PREV,
    broadcastCount: 1,
    sections: ["must_read"],
    anglesUsed: ["政策变化"],
    samples: [
      {
        date: PREV,
        section: "must_read",
        title: "广州房贷贴息政策落地",
        url: "https://e.com/a",
        text: "广州房贷贴息政策落地",
      },
    ],
    broadcastedTexts: ["广州房贷贴息政策落地"],
    broadcastedFacts: ["!落地"],
    peakScore: 70,
    ...over,
  };
}

function store(events: Record<string, EventRecord> = {}, today?: EventMemoryStore["today"]): EventMemoryStore {
  return { version: 1, events, ...(today ? { today } : {}) };
}

const opts = { excludeDate: DAY };

// —— 任务书 4.7 的九个场景 ——————————————————————————————

test("① 历史没有相同事件 → 新增", () => {
  const mark = deltaOf(
    { title: "南沙推出跨境理财通便利化试点", text: "南沙推出跨境理财通便利化试点", url: "https://e.com/x" },
    store({ E1: record() }),
    opts,
  );
  assert.equal(mark.state, "new");
  assert.equal(mark.issueNo, undefined, "新增不给期号");
  assert.equal(mark.confidence, "high", "确实有历史基线、确实没匹配上 → 高置信的新增");
});

test("② 相同事件被不同媒体重复报道 → 续报", () => {
  const mark = deltaOf(
    { title: "广州房贷贴息政策落地", text: "广州房贷贴息政策落地", url: "https://other.com/b" },
    store({ E1: record() }),
    opts,
  );
  assert.equal(mark.state, "followup", "同一事件换了一家媒体，不是新增");
  assert.equal(mark.issueNo, 2, "历史播报 1 次 → 本期第 2 期");
  assert.ok(!mark.highlights?.length, "续报不带新进展说明");
});

test("③ 同一政策从征求意见到正式印发 → 有进展", () => {
  const s = store({
    E1: record({
      anchors: ["房贷", "贴息", "政策", "征求"],
      samples: [
        {
          date: PREV,
          section: "must_read",
          title: "广州房贷贴息政策征求意见稿发布",
          url: "https://e.com/a",
          text: "广州房贷贴息政策征求意见稿发布",
        },
      ],
      broadcastedTexts: ["广州房贷贴息政策征求意见稿发布"],
      broadcastedFacts: ["!发布"],
    }),
  });
  const mark = deltaOf(
    { title: "广州房贷贴息政策正式印发", text: "广州房贷贴息政策正式印发", url: "https://e.com/c" },
    s,
    opts,
  );
  assert.equal(mark.state, "changed", "从征求意见到正式印发 = 事件本身出现了新变化");
  assert.ok((mark.highlights ?? []).length > 0, "必须说得出新在哪");
  assert.ok(
    (mark.highlights ?? []).some((h) => h.includes("印发")),
    "新进展要指向具体事实（阶段推进到印发）",
  );
});

test("④ 同一政策新增实施细则与规模数据 → 有进展", () => {
  const mark = deltaOf(
    {
      title: "广州房贷贴息政策印发实施细则",
      text: "广州房贷贴息政策印发实施细则，覆盖 120 万套住房",
      url: "https://e.com/d",
    },
    store({ E1: record() }),
    opts,
  );
  assert.equal(mark.state, "changed", "新增细则+新数据 = 实质进展");
  assert.ok((mark.highlights ?? []).length > 0);
});

test("⑤ 同一主题但不同地区的独立政策 → 新增（政策工具不同）", () => {
  const mark = deltaOf(
    {
      title: "珠海将首套房公积金贷款额度上调至 80 万",
      text: "珠海将首套房公积金贷款额度上调至 80 万",
      url: "https://e.com/zh",
    },
    store({ E1: record() }),
    opts,
  );
  assert.equal(mark.state, "new", "不同城市、不同政策工具 → 不能因主题相近就并成一条");
});

test("⑤-b 同一政策工具、仅地区不同 → 仍判新增（地域互斥，不得并成一条）", () => {
  // 修前：GEO_ANCHORS 只覆盖 广州/广东/大湾区/南沙/粤，珠海不进锚点也不参与互斥判断，
  // 「广州房贷贴息政策」与「珠海房贷贴息政策」共享锚点 → 判同一事件（且因「出台」这个
  // 阶段词被判成「有进展」，把两个城市的独立政策谎报成同一件事的进展）。
  // 修法：三态标注开 requireGeoCompatible（只收紧、不动阈值）→ 明确指向不同城市即非同一事件。
  const mark = deltaOf(
    { title: "珠海房贷贴息政策出台", text: "珠海房贷贴息政策出台", url: "https://e.com/zh2" },
    store({ E1: record() }),
    opts,
  );
  assert.equal(mark.state, "new", "不同城市的同主题政策是独立事件");
  assert.equal(mark.issueNo, undefined, "新增不给期号");
});

test("⑤-c 地域互斥不得误伤：省级表述（广东/大湾区）与省内城市不冲突", () => {
  const mark = deltaOf(
    { title: "广东房贷贴息政策出台", text: "广东房贷贴息政策出台", url: "https://e.com/gd" },
    store({ E1: record() }),
    opts,
  );
  assert.equal(mark.state, "changed", "省级政策覆盖广州，不能因「广东≠广州」判成两件事");
});

test("⑥ 同一企业不同项目事件 → 新增", () => {
  const s = store({
    E1: record({
      anchors: ["集团", "数据中心", "开工"],
      samples: [
        {
          date: PREV,
          section: "must_read",
          title: "某集团广州数据中心项目开工",
          url: "https://e.com/p1",
          text: "某集团广州数据中心项目开工",
        },
      ],
      broadcastedTexts: ["某集团广州数据中心项目开工"],
      broadcastedFacts: ["!开工"],
    }),
  });
  const mark = deltaOf(
    {
      title: "某集团佛山产业园项目竣工",
      text: "某集团佛山产业园项目竣工",
      url: "https://e.com/p2",
    },
    s,
    opts,
  );
  assert.equal(mark.state, "new", "同一企业的不同项目是独立事件");
});

test("⑦ 同一事件仅更换报道标题 → 续报", () => {
  const mark = deltaOf(
    { title: "穗房贷贴息新政实施", text: "穗房贷贴息新政实施", url: "https://e.com/a" },
    store({ E1: record() }),
    opts,
  );
  assert.equal(mark.state, "followup", "换了标题但仍是同一件事（同源 url）");
  assert.equal(mark.issueNo, 2);
});

test("⑧ 同一事件新增关键数据 → 有进展", () => {
  const mark = deltaOf(
    {
      title: "广州房贷贴息政策落地",
      text: "广州房贷贴息政策落地，首套房贷利率下调 20 个基点，覆盖 36000 户",
      url: "https://e.com/e",
    },
    store({ E1: record() }),
    opts,
  );
  assert.equal(mark.state, "changed", "出现新的关键数据 = 有实质进展");
  assert.ok(
    (mark.highlights ?? []).some((h) => /\d/.test(h)),
    "新进展要能看到新数据本身，而不是空泛表述",
  );
});

test("⑨ 历史记忆缺失 → 一律新增（绝不无依据标续报），且置信度降为 low", () => {
  const empty = store({});
  for (const title of ["广州房贷贴息政策落地", "南沙跨境理财通试点", "佛山制造业贷款贴息"]) {
    const mark = deltaOf({ title, text: title, url: `https://e.com/${encodeURIComponent(title)}` }, empty, opts);
    assert.equal(mark.state, "new", `记忆库为空时不得标续报：${title}`);
    assert.equal(mark.confidence, "low", "没有基线可比 → 不能给高置信");
  }
});

// —— 本次修复的两个根因 ————————————————————————————————

test("⑩ 当天暂存区不算历史：同一次运行的播报不得把「自己」标成续报", () => {
  const title = "广州房贷贴息政策落地";
  const s = store({}, {
    date: DAY,
    entries: [{ date: DAY, section: "must_read", title, url: "https://e.com/a", text: title }],
  });
  // 不排除当天（旧行为）：命中自己 → 续报（这正是线上恒为续报的成因）
  assert.equal(deltaOf({ title, text: title, url: "https://e.com/a" }, s).state, "followup");
  // 排除当天（修后）：当天播报不算历史 → 新增
  assert.equal(deltaOf({ title, text: title, url: "https://e.com/a" }, s, opts).state, "new");
});

test("⑪ 当天已结算进长期记忆的记录不算历史（否则当天这一期永远判不出新增）", () => {
  const s = store({
    E1: record({
      firstBroadcastAt: DAY,
      lastBroadcastAt: DAY,
      samples: [
        { date: DAY, section: "must_read", title: "广州房贷贴息政策落地", url: "https://e.com/a", text: "广州房贷贴息政策落地" },
      ],
    }),
  });
  assert.equal(
    deltaOf({ title: "广州房贷贴息政策落地", text: "广州房贷贴息政策落地", url: "https://e.com/a" }, s).state,
    "followup",
    "旧行为：当天结算的记录被当成历史",
  );
  assert.equal(
    deltaOf({ title: "广州房贷贴息政策落地", text: "广州房贷贴息政策落地", url: "https://e.com/a" }, s, opts).state,
    "new",
    "修后：整条只在当天播过的记录不算历史",
  );
});

test("⑫ 历史与当天样本混合：只用昨天证据判定，今天的新事实仍能被识别", () => {
  // 修前：整条记录不排除，URL/锚点/事实全量参与 → 今天的「3.6万户」已在聚合字段里，
  //       要么 sameArticle 直接续报，要么 novelty 算不出新事实 → 真实进展被吞。
  const s = store({
    E1: record({
      broadcastCount: 2,
      firstBroadcastAt: PREV,
      lastBroadcastAt: DAY,
      samples: [
        {
          date: PREV,
          section: "must_read",
          title: "广州房贷贴息政策征求意见稿发布",
          url: "https://e.com/a",
          text: "广州房贷贴息政策征求意见稿发布",
          facts: ["!发布"],
        },
        {
          date: DAY,
          section: "must_read",
          title: "广州房贷贴息政策正式印发，覆盖 36000 户",
          url: "https://e.com/b",
          text: "广州房贷贴息政策正式印发，覆盖 36000 户",
          facts: ["!印发", "#36000户"],
        },
      ],
      broadcastedTexts: [
        "广州房贷贴息政策征求意见稿发布",
        "广州房贷贴息政策正式印发，覆盖 36000 户",
      ],
      broadcastedFacts: ["!发布", "!印发", "#36000户"],
    }),
  });
  const mark = deltaOf(
    {
      title: "广州房贷贴息政策正式印发，覆盖 36000 户",
      text: "广州房贷贴息政策正式印发，覆盖 36000 户",
      url: "https://e.com/b",
    },
    s,
    opts,
  );
  assert.equal(mark.state, "changed", "相对昨天的征求意见，今天是实质进展");
  assert.equal(mark.issueNo, 2, "历史只有昨天 1 次 → 本期第 2 期；当天已结算不再单独计一期");
  assert.ok(mark.highlights?.some((h) => /印发|36000户/.test(h)), "changed 要说出今天新在哪");
  assert.ok(!mark.highlights?.some((h) => /发布/.test(h)), "昨天已播的事实不得当成新事实");
});

test("⑬ changed 必须带可核验新事实（凡 changed 必有 highlights）", () => {
  const samples = [
    { title: "广州房贷贴息政策落地", text: "广州房贷贴息政策落地，首套利率下调 20 个基点" },
    { title: "广州房贷贴息政策正式印发", text: "广州房贷贴息政策正式印发" },
    { title: "广州房贷贴息政策施行", text: "广州房贷贴息政策施行，覆盖 36000 户" },
  ];
  for (const s of samples) {
    const mark = deltaOf({ title: s.title, text: s.text, url: "https://e.com/z" }, store({ E1: record() }), opts);
    if (mark.state === "changed") {
      assert.ok((mark.highlights ?? []).length > 0, `changed 必须说得出新在哪：${s.title}`);
      assert.ok(
        (mark.highlights ?? []).every((h) => !/^[#!@]/.test(h)),
        "展示用的新事实不得带内部前缀符（# ! @）",
      );
    }
  }
  // 阈值本身没动（锁住，防被悄悄调松换准确率）
  assert.equal(DELTA_PROGRESS_THRESHOLD, 0.35);
});

// —— 2026-11-28 第二轮修订：当天样本不得进入历史基线的回归 ——————————

function mixedRecord(): EventRecord {
  return record({
    broadcastCount: 2,
    firstBroadcastAt: PREV,
    lastBroadcastAt: DAY,
    samples: [
      {
        date: PREV,
        section: "must_read",
        title: "广州房贷贴息政策征求意见稿发布",
        url: "https://e.com/a",
        text: "广州房贷贴息政策征求意见稿发布",
        facts: ["!发布"],
      },
      {
        date: DAY,
        section: "must_read",
        title: "广州房贷贴息政策正式印发",
        url: "https://e.com/b",
        text: "广州房贷贴息政策正式印发",
        facts: ["!印发"],
      },
    ],
    broadcastedTexts: [
      "广州房贷贴息政策征求意见稿发布",
      "广州房贷贴息政策正式印发",
    ],
    broadcastedFacts: ["!发布", "!印发"],
  });
}

test("⑭ 候选 URL = 当天已写入的 URL：不得命中 sameArticle 吞掉新增数据", () => {
  const mark = deltaOf(
    {
      title: "广州房贷贴息政策正式印发，覆盖 36000 户",
      text: "广州房贷贴息政策正式印发，覆盖 36000 户",
      url: "https://e.com/b", // 当天样本的 URL，历史样本是 /a
    },
    store({ E1: mixedRecord() }),
    opts,
  );
  assert.equal(mark.state, "changed", "sameArticle 只能查历史样本，不能查当天写入的那条");
  assert.ok(mark.highlights?.some((h) => /36000户/.test(h)));
});

test("⑮ 样本窗口被当天占满但仍有历史：保守降级 followup + low（sc 拍板口径）", () => {
  const todaySamples = Array.from({ length: 6 }, (_, i) => ({
    date: DAY,
    section: "must_read" as const,
    title: "广州房贷贴息政策正式印发",
    url: `https://e.com/t${i}`,
    text: "广州房贷贴息政策正式印发",
    facts: ["!印发"],
  }));
  const s = store({
    E1: record({
      broadcastCount: 8,
      firstBroadcastAt: PREV,
      lastBroadcastAt: DAY,
      samples: todaySamples,
      broadcastedTexts: todaySamples.map((x) => x.text),
      broadcastedFacts: ["!发布", "!印发"],
    }),
  });
  const mark = deltaOf(
    {
      title: "广州房贷贴息政策正式印发",
      text: "广州房贷贴息政策覆盖 36000 户",
      url: "https://e.com/new",
    },
    s,
    opts,
  );
  assert.equal(mark.state, "followup", "历史存在但证据不足 → 不误报新增，更不强行判有进展");
  assert.equal(mark.confidence, "low");
  assert.equal(mark.issueNo, undefined, "核对不了历史次数 → 不给期号");
  assert.ok(!mark.highlights?.length, "证据不足不得输出新事实");
});

test("⑯ buildHistoricalEventView 是纯函数，且只保留 excludeDate 之前的证据", () => {
  const original = mixedRecord();
  const before = JSON.stringify(original);
  const view = buildHistoricalEventView(original, DAY);
  assert.ok(view, "混合记录有昨天样本 → 应能重建历史视图");
  assert.equal(view.samples.length, 1);
  assert.equal(view.samples[0].date, PREV);
  assert.equal(view.broadcastCount, 1, "broadcastCount 扣掉当天计入的那一播报日");
  assert.equal(view.lastBroadcastAt, PREV);
  assert.ok(!view.broadcastedFacts.includes("!印发"), "当天才出现的事实不得进入历史事实集合");
  assert.ok(!view.broadcastedTexts.some((t) => t.includes("正式印发")));
  assert.equal(JSON.stringify(original), before, "不得 mutate 入参");
  const onlyToday = record({
    firstBroadcastAt: DAY,
    lastBroadcastAt: DAY,
    broadcastCount: 1,
    samples: [
      { date: DAY, section: "must_read", title: "广州房贷贴息政策落地", url: "https://e.com/t", text: "广州房贷贴息政策落地" },
    ],
  });
  assert.equal(buildHistoricalEventView(onlyToday, DAY), null, "全是当天样本 → 没有历史视图");
});

test("⑰ 同一事件当天重复运行：当天暂存 + 当天结算都不算历史 → 新增", () => {
  const title = "广州房贷贴息政策正式印发";
  const s = store(
    {
      E1: record({
        firstBroadcastAt: DAY,
        lastBroadcastAt: DAY,
        broadcastCount: 1,
        samples: [
          { date: DAY, section: "must_read", title, url: "https://e.com/x", text: title, facts: ["!印发"] },
        ],
        broadcastedTexts: [title],
        broadcastedFacts: ["!印发"],
      }),
    },
    { date: DAY, entries: [{ date: DAY, section: "must_read", title, url: "https://e.com/x", text: title }] },
  );
  const mark = deltaOf({ title, text: title, url: "https://e.com/x" }, s, opts);
  assert.equal(mark.state, "new", "不能因自己刚写进记忆就标续报");
});
