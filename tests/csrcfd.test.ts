import { test, describe } from "node:test";
import assert from "node:assert/strict";
// 2026-09-11 移植自 gzinfo tests/csrcfd.test.ts（仅改 import 路径到 2.0 适配器层）。
// 新增覆盖「辅导状态（列4）→ 上市阶段」映射 + 「撤回辅导备案」过滤（stage-coach-done）。
import {
  parseCoachRows,
  extractDisclosureDate,
  extractCompanyFromPdfPath,
  isGuangdong,
  decidePage,
  coachStageOf,
  isWithdrawn,
  isProgressReport,
  CsrcCoachCrawler,
  type CoachRow,
} from "../lib/adapters/crawlers/sources/csrcfd";

/** 构造一行辅导库 HTML（8 个 td + 行内 downloadPdf1 调用）。 */
function coachTr(opts: {
  company: string;
  dispatchOrg?: string;
  /** 披露日期 YYYY-MM-DD，用于拼 PDF 路径；空 = 无 PDF 路径（stale 场景） */
  disclosure?: string;
  recordDate?: string;
  status?: string;
  tutorOrg?: string;
  /** 列6 报告类型（默认辅导备案报告；阶段性报告剔除测试用） */
  reportType?: string;
  /** PDF 文件名中的公司名（模拟源站历史期次行：辅导对象列空、文件名含公司名）；默认空 → x.pdf */
  pdfCompany?: string;
}): string {
  const { company, dispatchOrg = "广东证监局", disclosure, recordDate = disclosure || "", status = "辅导备案", tutorOrg = "兴业证券", reportType = "辅导备案报告", pdfCompany = "" } = opts;
  const pdf = disclosure
    ? `<script>downloadPdf1('/mnt/storage/stock/pre_ipo/${disclosure.replace(/-/g, "/")}/${pdfCompany ? `关于${pdfCompany}首次公开发行股票并上市辅导工作进展报告（第N期）.pdf` : "x.pdf"}')</script>`
    : "";
  return `<tr><td>1</td><td>${company}</td><td>${tutorOrg}</td><td>${recordDate}</td><td>${status}</td><td>${dispatchOrg}</td><td>${reportType}</td><td>title${pdf}</td></tr>`;
}

function pageHtml(rows: string[]): string {
  return `<table class="m-table2"><tbody>${rows.join("")}</tbody></table>`;
}

// 相对今日的日期串
function dayOffset(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const TODAY = dayOffset(0);
const YESTERDAY = dayOffset(-1);
const BEFORE_YESTERDAY = dayOffset(-2);

describe("parseCoachRows", () => {
  test("解析 8 列表格", () => {
    const html = pageHtml([
      coachTr({ company: "广东东岛新能源股份有限公司", disclosure: TODAY }),
    ]);
    const rows = parseCoachRows(html);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].company, "广东东岛新能源股份有限公司");
    assert.equal(rows[0].tutorOrg, "兴业证券");
    assert.equal(rows[0].dispatchOrg, "广东证监局");
    assert.equal(rows[0].status, "辅导备案");
  });

  test("无表格返回空", () => {
    assert.equal(parseCoachRows("<div>no table</div>").length, 0);
  });
});

describe("extractDisclosureDate", () => {
  test("从 PDF 路径提取 YYYY-MM-DD", () => {
    const r: CoachRow = { company: "", tutorOrg: "", recordDate: "", status: "", dispatchOrg: "", reportType: "", reportTitle: "", pdfPath: "/mnt/storage/stock/pre_ipo/2026/8/28/x.pdf" };
    assert.equal(extractDisclosureDate(r), "2026-08-28");
  });
  test("无 PDF 路径返回 null", () => {
    const r: CoachRow = { company: "", tutorOrg: "", recordDate: "", status: "", dispatchOrg: "", reportType: "", reportTitle: "", pdfPath: "" };
    assert.equal(extractDisclosureDate(r), null);
  });
});

describe("isGuangdong", () => {
  test("派出机构=广东证监局", () => {
    assert.equal(isGuangdong({ dispatchOrg: "广东证监局" } as CoachRow), true);
  });
  test("派出机构=深圳证监局（单列归广东）", () => {
    assert.equal(isGuangdong({ dispatchOrg: "深圳证监局" } as CoachRow), true);
  });
  test("企业名含广东城市（广州）", () => {
    assert.equal(isGuangdong({ company: "广州某科技股份有限公司" } as CoachRow), true);
  });
  test("非广东（派出机构+无城市）", () => {
    assert.equal(isGuangdong({ dispatchOrg: "北京证监局", company: "北京某某" } as CoachRow), false);
  });
});

describe("decidePage", () => {
  const mk = (disclosure?: string): CoachRow => ({
    company: "x", tutorOrg: "", recordDate: "", status: "", dispatchOrg: "", reportType: "", reportTitle: "",
    pdfPath: disclosure ? `/pre_ipo/${disclosure.replace(/-/g, "/")}/x.pdf` : "",
  });

  // 2026-10-22 起判据改为「整页最大更新日期 < 下界才停」（源站按报告更新排序，非备案时间）：
  // 页内仍有 ≥ 下界的记录 → 后续页可能还有窗内数据，必须继续翻（旧逻辑用页内末条，被老报告行带偏）。

  test("页内含今天记录（末条是前天老行）→ 继续（修复：不再被页尾老行带停）", () => {
    // 复现实测 bug 场景：页首新、页尾穿插老报告行。旧逻辑取末条有效日期（前天）→ 误停
    const rows = [mk(TODAY), mk(BEFORE_YESTERDAY)];
    assert.deepEqual(decidePage(rows, YESTERDAY), { stop: false, staleHit: false });
  });

  test("页内最早 = 昨天 → 继续（不停止）", () => {
    const rows = [mk(TODAY), mk(YESTERDAY)];
    assert.deepEqual(decidePage(rows, YESTERDAY), { stop: false, staleHit: false });
  });

  test("页内最早 = 今天 → 继续", () => {
    const rows = [mk(TODAY), mk(TODAY)];
    assert.deepEqual(decidePage(rows, YESTERDAY), { stop: false, staleHit: false });
  });

  test("整页都早于窗口下界 → 停止", () => {
    const rows = [mk(BEFORE_YESTERDAY), mk(BEFORE_YESTERDAY)];
    assert.deepEqual(decidePage(rows, YESTERDAY), { stop: true, staleHit: false });
  });

  test("末几行无日期但前面有窗内记录 → 继续（历史期次行不参与判定）", () => {
    const rows = [mk(TODAY), mk(), mk(BEFORE_YESTERDAY)];
    assert.deepEqual(decidePage(rows, YESTERDAY), { stop: false, staleHit: false });
  });

  test("全页无有效披露日期 → staleHit", () => {
    const rows = [mk(), mk()];
    assert.deepEqual(decidePage(rows, YESTERDAY), { stop: false, staleHit: true });
  });
});

// —— run 集成测试：用 mock fetchPage 验证更新日期早停 + 广东过滤 + stale 兜底 ——
// （2026-10-22：「倒序早停」改为「更新日期早停」：源站按报告更新排序，页尾老报告行不再触发误停）
class MockCrawler extends CsrcCoachCrawler {
  private pages: string[];
  private idx = 0;
  constructor(pages: string[]) {
    super();
    this.pages = pages;
  }
  protected async fetchPage(_p: number): Promise<string> {
    if (this.idx >= this.pages.length) throw new Error("no more pages");
    return this.pages[this.idx++];
  }
}

describe("run (更新日期早停 + 广东过滤)", () => {
  test("页1 含今天记录、页2 整页早于窗口 → 抓 2 页后停", async () => {
    const crawler = new MockCrawler([
      pageHtml([
        coachTr({ company: "广州A", disclosure: TODAY }),
        coachTr({ company: "深圳B", disclosure: YESTERDAY }),
        coachTr({ company: "东莞C", disclosure: BEFORE_YESTERDAY }), // 页1末条老行，不触发停（2026-10-22 修复）
      ]),
      pageHtml([
        coachTr({ company: "佛山D", disclosure: BEFORE_YESTERDAY }), // 页2 整页早于窗口 → 停
        coachTr({ company: "珠海E", disclosure: BEFORE_YESTERDAY }),
      ]),
    ]);
    const res = await crawler.run();
    // 两页全为广东企业，共 5 条（修复前只抓页1 的 3 条）
    assert.equal(res.length, 5);
    assert.ok(res.every((r) => r.region === "gd"));
  });

  test("乱序混合页：页尾老报告行（2026-04-08 更新）不导致早停，续抓第 2 页的广东新备案", async () => {
    // 复现实测 bug（2026-10-22）：第 1 页按更新排序含老报告行，旧逻辑在此误停，
    // 漏掉第 2 页的广东奔达（10-20）/ 深圳微见（10-19）
    const crawler = new MockCrawler([
      pageHtml([
        coachTr({ company: "安徽创瑞技术股份有限公司", dispatchOrg: "安徽证监局", disclosure: TODAY }),
        coachTr({ company: "某2022年备案老企业", dispatchOrg: "北京证监局", disclosure: TODAY }),
        coachTr({ company: "某4月更新的老企业", dispatchOrg: "江苏证监局", disclosure: BEFORE_YESTERDAY }), // 页尾老行
      ]),
      pageHtml([
        coachTr({ company: "广东奔达精密工业股份有限公司", disclosure: YESTERDAY }),
        coachTr({ company: "深圳微见先进封装技术股份有限公司", disclosure: BEFORE_YESTERDAY }),
      ]),
      pageHtml([
        coachTr({ company: "某全老页企业", dispatchOrg: "北京证监局", disclosure: BEFORE_YESTERDAY }),
      ]),
    ]);
    const res = await crawler.run();
    // 广东 2 条必须被抓到（修复前第 1 页即停，res=0）
    assert.equal(res.length, 2);
    assert.match(res[0].title || "", /广东奔达精密工业/);
    assert.match(res[1].title || "", /深圳微见先进封装/);
  });

  test("sourceId=gd-csrc-tutoring（IPO 体系重设计，弃用 em-ipo 防 render 白名单静默丢弃）", async () => {
    const crawler = new MockCrawler([
      pageHtml([coachTr({ company: "广州A", disclosure: TODAY })]),
    ]);
    const res = await crawler.run();
    assert.equal(res.length, 1);
    assert.equal(res[0].sourceId, "gd-csrc-tutoring");
    assert.notEqual(res[0].sourceId, "em-ipo");
  });

  test("页1 最早=昨天 → 续抓第 2 页，第 3 页整页早于窗口 → 停", async () => {
    const crawler = new MockCrawler([
      pageHtml([
        coachTr({ company: "广州A", disclosure: TODAY }),
        coachTr({ company: "佛山B", disclosure: YESTERDAY }), // 页1 有窗内记录 → 续抓
      ]),
      pageHtml([
        coachTr({ company: "珠海C", disclosure: YESTERDAY }),
        coachTr({ company: "中山D", disclosure: BEFORE_YESTERDAY }), // 页2 仍有窗内记录 → 续抓
      ]),
      pageHtml([
        coachTr({ company: "惠州F", disclosure: BEFORE_YESTERDAY }), // 页3 整页早于窗口 → 停
      ]),
    ]);
    const res = await crawler.run();
    assert.equal(res.length, 5, "三页全收（页3 虽整页早于窗口仍整页收集，下游才裁窗）");
  });

  test("混合全国+广东 → 仅保留广东", async () => {
    const crawler = new MockCrawler([
      pageHtml([
        coachTr({ company: "北京X", dispatchOrg: "北京证监局", disclosure: TODAY }),
        coachTr({ company: "广州Y", disclosure: TODAY }),
        coachTr({ company: "上海Z", dispatchOrg: "上海证监局", disclosure: YESTERDAY }),
      ]),
    ]);
    const res = await crawler.run();
    assert.equal(res.length, 1);
    assert.match(res[0].title || "", /广州Y/);
  });

  test("连续 2 页无有效披露日期 → 兜底停止", async () => {
    const crawler = new MockCrawler([
      pageHtml([coachTr({ company: "广州A", recordDate: TODAY }), coachTr({ company: "深圳B", recordDate: TODAY })]), // 无 disclosure（staleHit）
      pageHtml([coachTr({ company: "东莞C", recordDate: TODAY }), coachTr({ company: "佛山D", recordDate: TODAY })]), // 无 disclosure → 第2页触发停
      pageHtml([coachTr({ company: "珠海E", disclosure: TODAY })]), // 不应被抓
    ]);
    const res = await crawler.run();
    // 仅前 2 页（4 条，全广东，recordDate 兜底 publishedAt），第 3 页未被抓
    assert.equal(res.length, 4);
  });

  test("时间真实性红线：无披露且无备案时间 → 废弃（不产出）", async () => {
    const crawler = new MockCrawler([
      pageHtml([coachTr({ company: "广州A", disclosure: "", recordDate: "" })]),
    ]);
    const res = await crawler.run();
    assert.equal(res.length, 0);
  });
});

// 2026-09-11：列4「辅导状态」是**企业当前状态**（同一企业所有报告行同值），
// 此前 ipoStage 无条件写死 stage-tutoring，把「刚起步」与「已完成辅导」抹成同一栏。
describe("辅导状态 → 上市阶段", () => {
  const mk = (status: string): CoachRow => ({
    company: "某广东企业",
    tutorOrg: "兴业证券股份有限公司",
    recordDate: "2026-09-11",
    status,
    dispatchOrg: "广东证监局",
    reportType: "辅导备案报告",
    reportTitle: "t",
    pdfPath: "",
  });

  test("coachStageOf：备案/验收/完成/未知 四类映射", () => {
    assert.equal(coachStageOf(mk("辅导备案")), "stage-tutoring");
    assert.equal(coachStageOf(mk("辅导验收")), "stage-coach-done", "辅导验收 ≠ 辅导备案");
    assert.equal(coachStageOf(mk("辅导工作完成")), "stage-coach-done", "「辅导工作完成」与验收同义");
    assert.equal(
      coachStageOf(mk("某种未收录状态")),
      "stage-tutoring",
      "未知状态保守回退，不丢条目",
    );
  });

  test("isWithdrawn：仅「撤回辅导备案」判为终止", () => {
    assert.equal(isWithdrawn(mk("撤回辅导备案")), true);
    assert.equal(isWithdrawn(mk("辅导备案")), false);
    assert.equal(isWithdrawn(mk("辅导验收")), false);
  });

  test("isProgressReport：阶段性报告剔除、节点事件保留（2026-10-22 用户拍板）", () => {
    const row = (reportType: string): CoachRow => ({ ...mk("辅导备案"), reportType });
    assert.equal(isProgressReport(row("辅导进展情况报告")), true, "第N期进展=阶段性噪音，剔除");
    assert.equal(isProgressReport(row("辅导备案报告")), false, "新进入辅导=商机，保留");
    assert.equal(isProgressReport(row("辅导工作完成报告")), false, "完成辅导=即将申报，重大节点保留");
    assert.equal(isProgressReport(row("辅导情况报告")), false, "非进展类，保守保留");
  });

  test("run：撤回辅导备案不产出（非商机）", async () => {
    const crawler = new MockCrawler([
      pageHtml([
        coachTr({ company: "广州A", disclosure: TODAY, status: "辅导备案" }),
        coachTr({ company: "深圳B", disclosure: TODAY, status: "撤回辅导备案" }),
      ]),
    ]);
    const res = await crawler.run();
    assert.equal(res.length, 1, "撤回条目应被丢弃，只留正常辅导中的");
    assert.match(res[0].title || "", /广州A/);
  });

  test("run：阶段性报告不产出，备案/完成报告保留（2026-10-22 用户拍板）", async () => {
    const crawler = new MockCrawler([
      pageHtml([
        coachTr({ company: "广州A", disclosure: TODAY, reportType: "辅导备案报告" }),
        coachTr({ company: "深圳B", disclosure: TODAY, reportType: "辅导进展情况报告" }),
        coachTr({ company: "东莞C", disclosure: TODAY, reportType: "辅导工作完成报告" }),
      ]),
    ]);
    const res = await crawler.run();
    assert.equal(res.length, 2, "进展报告剔除，备案+完成保留");
    assert.match(res[0].title || "", /广州A/);
    assert.match(res[1].title || "", /东莞C/);
  });

  test("run：辅导验收 → ipoStage=stage-coach-done（此前被硬编码成 tutoring）", async () => {
    const crawler = new MockCrawler([
      pageHtml([coachTr({ company: "广州C", disclosure: TODAY, status: "辅导验收" })]),
    ]);
    const res = await crawler.run();
    assert.equal(res.length, 1);
    assert.equal(res[0].ipoStage, "stage-coach-done");
  });
});

// —— 2026-10-11 方案B：同日同公司仅保留最新一期 ——
// 成因：csrcfd 源站对同一企业历史期次行做「合并单元格」——辅导对象列置空，只有最新一期显示企业名
// （实测东阳光同日披露第十二/十三期：第十三期行有名字，第十二期起辅导对象列为空，导致空标题 + 同日重复）。
describe("extractCompanyFromPdfPath", () => {
  test("从 PDF 文件名提取公司名（东阳光第十二期）", () => {
    assert.equal(
      extractCompanyFromPdfPath(
        "/mnt/storage/stock/pre_ipo/2026/10/11/PREIPO_F0101_V01_20261011_36530_Q/423366B976D44341B093B5B4CFDD484E/关于广东东阳光药业股份有限公司首次公开发行股票并上市辅导工作进展报告（第十二期）.pdf",
      ),
      "广东东阳光药业股份有限公司",
    );
  });
  test("无公司名（UUID 文件名）返回空", () => {
    assert.equal(
      extractCompanyFromPdfPath("/mnt/storage/stock/pre_ipo/2024/1/16/x/A32FF0A3C1E742D888AE0C50ABF7409E.pdf"),
      "",
    );
  });
});

describe("run (方案B：同日同公司去重，保留最新一期)", () => {
  test("同日同公司两条（历史期次行辅导对象列空）→ 仅保留最新一期（先到的有名字行）", async () => {
    const crawler = new MockCrawler([
      pageHtml([
        // 最新一期（第十三期）：辅导对象列有名字
        coachTr({ company: "广东东阳光药业股份有限公司", disclosure: TODAY, pdfCompany: "广东东阳光药业股份有限公司" }),
        // 历史期次（第十二期）：辅导对象列为空（源站合并单元格），PDF 文件名含公司名
        coachTr({ company: "", disclosure: TODAY, pdfCompany: "广东东阳光药业股份有限公司" }),
        // 另一家公司同日（不受影响）
        coachTr({ company: "中星微技术股份有限公司", disclosure: TODAY, pdfCompany: "中星微技术股份有限公司" }),
      ]),
    ]);
    const res = await crawler.run();
    assert.equal(res.length, 2, "同日同公司只保留最新一期，另一家公司保留");
    assert.match(res[0].title || "", /广东东阳光药业股份有限公司/);
    assert.ok(!res.some((r) => !r.title || /^\s*\(辅导备案\)/.test(r.title)), "不得再出现空标题条目");
    assert.match(res[1].title || "", /中星微技术股份有限公司/);
  });

  test("同公司不同日 → 都保留（窗口内不误删）", async () => {
    const crawler = new MockCrawler([
      pageHtml([
        coachTr({ company: "广州A", disclosure: TODAY }),
        coachTr({ company: "广州A", disclosure: YESTERDAY }),
      ]),
    ]);
    const res = await crawler.run();
    assert.equal(res.length, 2, "不同披露日不算同日重复，均应保留");
  });

  test("不同公司同日 → 都保留", async () => {
    const crawler = new MockCrawler([
      pageHtml([
        coachTr({ company: "广州A", disclosure: TODAY }),
        coachTr({ company: "深圳B", disclosure: TODAY }),
        coachTr({ company: "东莞C", disclosure: TODAY }),
      ]),
    ]);
    const res = await crawler.run();
    assert.equal(res.length, 3);
  });

  test("company 为空且 PDF 无公司名 → 保守保留（提取不到键不误删）", async () => {
    const crawler = new MockCrawler([
      pageHtml([
        coachTr({ company: "", disclosure: TODAY }),
        coachTr({ company: "广州A", disclosure: TODAY }),
      ]),
    ]);
    const res = await crawler.run();
    assert.equal(res.length, 2, "提取不到公司名的行不去重（保守不误删），但标题可能为空");
  });
});
