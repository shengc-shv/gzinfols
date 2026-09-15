/**
 * 红筹口播加锁测试（plan-redchip-crawl-push §5.2 / Trigger T3·T4）。
 * 覆盖：提权排序（不占名额）、红筹句置前、模板文案、截断优先级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildGdIpoSpoken,
  gdIpoCandidates,
  pickGdIpoCompanies,
  pickSpokenItems,
} from "../lib/services/classify/gd-ipo-spoken";
import type { ReportItem } from "../lib/contracts/report";
import type { RedchipBadge } from "../lib/contracts/redchip";
import { AUDIO_SPEAK_LIMITS } from "../lib/services/voice";
import { REDCHIP_VOICE_BOOST } from "../lib/ipo-config";

function badge(over: Partial<RedchipBadge> = {}): RedchipBadge {
  return {
    leadId: "108870",
    label: "红筹线索",
    verdict: "redchip",
    isNew: false,
    domicile: "开曼群岛",
    gdCityHits: 5,
    ...over,
  };
}

function hkItem(title: string, appId: string, over: Partial<ReportItem> = {}): ReportItem {
  const url = `https://www1.hkexnews.hk/app/sehk/2026/${appId}/2026091300120_c.htm`;
  return {
    url,
    title_cn: title,
    source: "港交所",
    source_type: "official",
    date: "09/14",
    summary: "",
    importance: 2,
    rank: 1,
    tags: ["粤"],
    locale: "national",
    officialUrl: url,
    ipoStage: "stage-reviewing",
    ...over,
  };
}

function gdItem(title: string, stage: string): ReportItem {
  return {
    url: "https://www.szse.cn/x#prj1",
    title_cn: title,
    source: "深交所",
    source_type: "official",
    date: "09/14",
    summary: "注册地：广东",
    importance: 2,
    rank: 1,
    tags: ["粤"],
    locale: "national",
    ipoStage: stage,
  };
}

test("① T4 提权：红筹「在审」越过非红筹「注册生效」（+boost 后 4 > 3）", () => {
  const rc = hkItem("某红筹企业（主板递表）", "108870", { redchip: badge(), ipoStage: "stage-reviewing" });
  const normal = gdItem("某常规企业：IPO注册生效（拟创业板）", "stage-registered");
  const order = gdIpoCandidates([normal, rc]).map((it) => it.title_cn);
  assert.equal(order[0], rc.title_cn, `红筹应前移（boost=${REDCHIP_VOICE_BOOST}）`);
});

test("② 不占额外名额：红筹 + 常规共 5 家时，口播仍只取 3 席", () => {
  const items = [
    hkItem("红筹甲（主板递表）", "100001", { redchip: badge({ leadId: "100001" }) }),
    hkItem("红筹乙（主板递表）", "100002", { redchip: badge({ leadId: "100002" }) }),
    gdItem("常规甲：IPO问询中", "stage-reviewing"),
    gdItem("常规乙：IPO辅导备案", "stage-tutoring"),
    gdItem("常规丙：IPO注册生效", "stage-registered"),
  ];
  const { selected, totalCandidates } = pickSpokenItems(items, { today: "2026-09-15" });
  assert.equal(selected.length, 3, "名额上限仍为 3，不因红筹抬高");
  assert.equal(totalCandidates, 5);
  assert.equal(selected.filter((it) => it.redchip).length, 2, "红筹先占席");
});

test("③ T3 红筹句置段首 + 模板文案（含离岸地/广东运营实体/交易所/进展）", () => {
  const rc = hkItem("某红筹企业：已受理（主板递表）", "108870", { redchip: badge() });
  const normal = gdItem("某常规企业：IPO问询中（拟创业板）", "stage-reviewing");
  const s = buildGdIpoSpoken([normal, rc], { today: "2026-09-15" });
  assert.ok(s.startsWith("某红筹企业为红筹线索"), `红筹句应置段首，实际：${s}`);
  assert.ok(s.includes("（开曼群岛注册、含广东运营实体）"));
  assert.ok(s.includes("拟在港交所IPO"), "港交所条目应兜底推导交易所（标题无「拟XX」字样）");
  assert.ok(s.includes("目前已受理"));
  assert.ok(s.includes("；某常规企业"), "常规句应在其后");
});

test("④ added → 前缀「新增红筹线索：」；changed → 播「红筹线索有更新：<字段> <from>→<to>」", () => {
  const isNew = hkItem("某红筹企业（主板递表）", "108870", {
    redchip: badge({ isNew: true }),
  });
  assert.ok(buildGdIpoSpoken([isNew], { today: "2026-09-15" }).startsWith("新增红筹线索：某红筹企业为红筹线索"));

  const changed = hkItem("某红筹企业（主板递表）", "108870", {
    redchip: badge({ changeSummary: "状态 处理中→已受理" }),
  });
  assert.equal(
    buildGdIpoSpoken([changed], { today: "2026-09-15" }),
    "某红筹企业红筹线索有更新：状态 处理中→已受理",
  );
});

test("⑤ 截断优先级：150 字上限截断时，红筹句因在前而优先保留", () => {
  const rc = hkItem("某红筹企业（主板递表）", "108870", { redchip: badge() });
  const normal = gdItem("某常规企业：IPO问询中（拟创业板）", "stage-reviewing");
  const s = buildGdIpoSpoken([normal, rc], { today: "2026-09-15" });
  const cut = s.slice(0, AUDIO_SPEAK_LIMITS.ipo);
  assert.ok(cut.includes("红筹线索"), "前 150 字内必须含红筹句");
});

test("⑥ 无红筹时行为不变：仍是「商机价值优先 + 等N家」原口径", () => {
  const items = [
    gdItem("甲：IPO辅导备案", "stage-tutoring"),
    gdItem("乙：IPO注册生效", "stage-registered"),
    gdItem("丙：IPO问询中", "stage-reviewing"),
    gdItem("丁：IPO已上市", "stage-listed"),
  ];
  const s = buildGdIpoSpoken(items, { today: "2026-09-15" });
  assert.ok(s.startsWith("甲，注册地广东，拟在深交所IPO") || s.includes("甲"), `实际：${s}`);
  assert.ok(s.includes("等4家"), "候选多于 3 家应收尾「等N家」");
});

test("⑦ 跨天去重：skipCompanies 命中的红筹企业既不播、也不写回记忆", () => {
  const rc = hkItem("某红筹企业（主板递表）", "108870", { redchip: badge() });
  const normal = gdItem("某常规企业：IPO问询中", "stage-reviewing");
  const opts = { today: "2026-09-15", skipCompanies: new Set(["某红筹企业"]) };
  assert.equal(buildGdIpoSpoken([rc, normal], opts).includes("红筹线索"), false);
  assert.deepEqual(pickGdIpoCompanies([rc, normal], opts), ["某常规企业"]);
});

test("⑧ 口播与写回记忆同源：pickGdIpoCompanies 与口播句顺序一致", () => {
  const rc = hkItem("某红筹企业（主板递表）", "108870", { redchip: badge() });
  const normal = gdItem("某常规企业：IPO问询中", "stage-reviewing");
  const opts = { today: "2026-09-15" };
  assert.deepEqual(pickGdIpoCompanies([normal, rc], opts), ["某红筹企业", "某常规企业"]);
  assert.ok(buildGdIpoSpoken([normal, rc], opts).indexOf("某红筹企业") < buildGdIpoSpoken([normal, rc], opts).indexOf("某常规企业"));
});
