/**
 * 词表命中基线（2026-10-03 架构审查 P1-3/P1-4 的落地）。
 *
 * ## 为什么要有这个文件
 *
 * 业务口径散落在三张表里，而它们**没有单测**：
 *  - `select/filters/relevance-score.ts#BUSINESS_LINES` + `GD_RE/GZ_RE`（值不值得上）
 *  - `memory/event-text.ts#THEME_RULES`（属于哪条主题线）
 *  - `select/filters/dedup-similar.ts#EVENT_ANCHORS` / `ANCHOR_SYNONYMS`（是不是同一件事）
 *
 * 后果实测过：今天往 `THEME_RULES` 补一个「公募」、把「跨境」权重从 0.5 提到 1.0，
 * **没有任何测试会响** —— 只能靠事后看报告才发现内容掉榜或串台。
 * 「补一个词」这类改动看起来只有一行，实际影响面完全不可见。
 *
 * ## 怎么用
 *
 * 改动上述任一词表后，本测试会失败。**这时不要直接改基线了事** ——
 * 先回答三个问题，并把结论写进提交信息：
 *  1. 哪些内容的档位 / 主题 / 事件身份变了？
 *  2. 这会不会让重复内容不再被拦住（或让不同内容被误并）？
 *  3. 定调「按分值取最有价值的几条」的排序会不会变？
 *
 * 基线记录的是**档位 / 业务线 / 主题标签 / 事件锚**，刻意不记具体分值 ——
 * 分值会随权重调参整体平移，而档位与身份才是决定「上不上榜、是不是同一件事」的东西。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { scoreBranchRelevance } from "../lib/services/select/filters/relevance-score";
import { candidateAnchors, extractTopicTags } from "../lib/services/memory/event-text";

/** 命中的业务线（从 signals 里取，形如 `业务线[信贷/财富] 权重1`）。 */
function linesOf(title: string): string {
  const sig = (scoreBranchRelevance({ title }).signals ?? []).find((s) => s.startsWith("业务线"));
  return sig ? sig.replace(/^业务线\[|\].*$/g, "") : "";
}

const BASELINE: Array<{
  title: string;
  tier: string;
  lines: string;
  themes: string[];
  anchors: string[];
}> = [
  {
    // 2026-10-03 sc：美联储移出 `TOP_ISSUER_RE`（权威度 0.95 → 媒体档 0.42），
    // 该标题又不含任何业务线关键词 → 34(context) → **21(drop)**。
    // 三问已答（见文末「2026-10-03 变更说明」）：判重链未动；定调排序按预期下移。
    title: "美联储官员集体警示通胀依旧过高",
    tier: "drop",
    lines: "",
    themes: [],
    anchors: ["美联储"],
  },
  {
    // 2026-10-03 sc：财富线补二级市场词后新增的锁定样例（原为 21/drop，与「港股」66 分两级之差）。
    title: "A股节后上涨胜率超60%机构：持股过节或更合算！外围股市上涨股民盼着开门红",
    tier: "insight",
    lines: "财富",
    themes: [],
    anchors: ["#60%"],
  },
  {
    title: "多家银行明确房贷贴息操作细节",
    tier: "must_read",
    lines: "信贷",
    themes: ["住房金融", "利率流动性"],
    anchors: ["房贷", "贴息"],
  },
  {
    title: "公募基金规模达39.63万亿元",
    tier: "insight",
    lines: "财富",
    themes: ["财富管理"],
    anchors: ["基金", "#39.63万亿元"],
  },
  {
    title: "港股三大指数集体重挫",
    tier: "insight",
    lines: "跨境",
    themes: [],
    anchors: [],
  },
  {
    title: "广州优化住房政策支持刚改需求",
    tier: "context",
    lines: "",
    themes: ["住房金融", "广州本地"],
    anchors: ["广州"],
  },
  {
    title: "外籍高端人才服务措施落地",
    tier: "context",
    lines: "",
    themes: [],
    anchors: [],
  },
];

test("词表命中基线：改动 BUSINESS_LINES / THEME_RULES / EVENT_ANCHORS 需同步本基线并说明影响", () => {
  for (const c of BASELINE) {
    assert.equal(scoreBranchRelevance({ title: c.title }).tier, c.tier, `${c.title}｜档位变了`);
    assert.equal(linesOf(c.title), c.lines, `${c.title}｜命中的业务线变了`);
    assert.deepEqual(extractTopicTags(c.title), c.themes, `${c.title}｜主题标签变了`);
    assert.deepEqual(
      candidateAnchors({ title: c.title } as never),
      c.anchors,
      `${c.title}｜事件锚变了（会影响判重召回/误并）`,
    );
  }
});

/**
 * 已知缺口（2026-10-03 架构审查发现，此处**锁定现状**而非认可它）。
 *
 * 港股在**评分层**已是「跨境」业务线（权重 1.0，与信贷同级），
 * 但**记忆判重层**的 `EVENT_ANCHORS` 里没有「港股 / 港股通 / 恒生」等词 ——
 * 于是港股类内容的事件锚为空，`candidateCoverage` / `anchorJaccard` 都无从下手，
 * 判重层认不出它，明天再报「港股重挫」不会被当成重复。
 *
 * ⚠️ 补锚点会让上面那条测试失败 —— 那是**预期的**：届时请评估
 * 「港股」作为泛主体词是否会把不同事件吸并到一起（同「按揭」大杂烩的教训）。
 */
test("已知缺口：港股在评分层已加权，但在记忆判重层没有事件锚", () => {
  assert.equal(linesOf("港股三大指数集体重挫"), "跨境", "评分层已把港股当跨境业务线");
  assert.deepEqual(
    candidateAnchors({ title: "港股三大指数集体重挫" } as never),
    [],
    "当前无事件锚 —— 补之前请先评估泛主体词吸并风险",
  );
});

/**
 * 已知缺口：广州本地住房政策落在 `context` 档。
 *
 * 「住房 / 刚改需求」这类表述**不在** `BUSINESS_LINES` 的关键词里
 * （表里有「楼市 / 购房 / 房地产」，没有「住房」），于是业务线权重为 0，
 * 即使命中 `GZ_RE`（地域 +0.9）也只能落在 `context`（低档，不进必读/商机）。
 * 是否算「误伤」需业务判断：广州本地政策理应高价值。
 */
test("已知缺口：广州本地住房政策因缺业务线关键词落在 context 档", () => {
  const r = scoreBranchRelevance({ title: "广州优化住房政策支持刚改需求" });
  assert.equal(linesOf("广州优化住房政策支持刚改需求"), "", "未命中任何业务线");
  assert.equal(r.tier, "context", "因业务线权重为 0 而落在低档");
});

/**
 * ============================================================================
 * 2026-10-03 变更说明（sc 两条口径：财富线补 A 股 / 美联储降为媒体级）
 * ============================================================================
 *
 * 本文档开头要求：改动词表后基线失败时，**不要直接改基线上事**，先回答三问。以下为答复。
 *
 * ## 改了什么
 *  1. `BUSINESS_LINES` 财富线补**二级市场**词（原表只有申购侧：新股/IPO/打新/申购/发行价/…）：
 *     新增 `A股 Ａ股 股市 大盘 两市 股指 上证 深证 创业板 科创板 开门红 持股 股民`。
 *     ⚠️ 刻意**不收**「股票」「券商」—— 195 条真实标题实测的假阳性（见下「第 1 问」）。
 *  2. `TOP_ISSUER_RE` 移出 `美联储`（权威度 0.95 → 媒体档 0.42）。
 *     连带：美联储类内容不再触发 `issuerTop` 的两项加成（可行动性上浮至 0.8、硬规则A 必读置顶）。
 *
 * ## 第 1 问：哪些内容的档位 / 主题 / 事件身份变了？
 *   样本 = 10-03 PASS1 池 68 条 + `data/article-history.json` 127 条 = **195 条真实标题**，
 *   **10 条（5%）**发生变化，全部集中在两类：
 *
 *   美联储类（降，8 条）：沃什淡化指引 79→66 · 加息预期退潮黄金 74→61 · 加息预期生变 74→66 ·
 *     多名官员警示通胀 87→78（**仍 must_read**）· 深夜全线大涨 42→33 ·
 *     非农爆冷 34→21(**drop**) · 副主席通胀风险 34→21(**drop**) · 本月加不加息 34→21(**drop**)
 *   A 股类（升，2 条）：A股节后胜率 21→**61(insight)** · A股龙虎榜 21→**61(insight)**
 *
 *   档位分布：must_read 7→7 · insight 40→42 · context 42→39 · drop 106→107。
 *   **主题标签（`THEME_RULES`）与事件锚（`EVENT_ANCHORS`）一条未变** —— 两者本次未改。
 *   剔除「股票/券商」前的对照：若收下这两个词，会多出 2 条假阳性被抬进 insight
 *   （「韩国天价离婚…卖股票」「固态电池迎重大利好！券商力推设备端」），均属 R7 要防的噪声。
 *
 * ## 第 2 问：会不会让重复内容不再被拦住（或让不同内容被误并）？
 *   **不会**。本次只动「值不值得上」这一层（`BUSINESS_LINES` + 权威度），
 *   判重链路的三个输入 —— 事件锚、主题标签、标题 Dice —— 完全未动（见第 1 问末句）。
 *   因此「同事件重复播出」的拦截率与误并率不变。
 *
 * ## 第 3 问：定调「按分值取」的排序会不会变？
 *   **会，且正是本次目的**：美联储类整体下移、A 股类整体上移，
 *   使「按分值取 Top-5」更偏向分行能落地的内容。
 *   ⚠️ 已知副作用：**3 条纯美联储宏观稿落到 `drop`**（不含任何业务线词）。
 *   若认为这类内容不该消失，需给「美联储 / 美元 / 美债 / 汇率」配业务线
 *   （最自然的是并入**跨境线**，与港股一样落在 1.0 档）—— **尚未实施，待 sc 拍板**。
 */
