/**
 * 红筹线索匹配与窗口加锁测试（plan-redchip-crawl-push §2.4 / §3.1 / §3.2 / T2·T7）。
 * 全部离线纯函数，不发起网络请求。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hasCompleteEvidence,
  hkexAppIdOf,
  inRedchipListWindow,
  inRedchipVoiceWindow,
  leadDateKey,
  matchRedchipLead,
  redchipLabelOf,
} from "../lib/services/classify/redchip";
import type { RedchipLead } from "../lib/contracts/redchip";
import { REDCHIP_LIST_WINDOW_DAYS, REDCHIP_VOICE_WINDOW_DAYS } from "../lib/ipo-config";

/** 夹具：一条「离岸 ∧ 广东词频达标」的完整线索。 */
function lead(over: Partial<RedchipLead> = {}): RedchipLead {
  return {
    leadId: "108870",
    appId: "108870",
    nameCn: "深圳市海柔創新智能科技集團股份有限公司",
    nameEn: "Hai Robotics Innovation Group Co., Ltd.",
    board: "主板",
    status: "处理中",
    submitDate: "2026-09-13",
    domicile: "开曼群岛",
    isOffshore: true,
    gdCityHits: 5,
    isGdConnected: true,
    vie: "none",
    verdict: "redchip",
    discoveredAt: "2026-09-15T08:00:00+08:00",
    sourceUrl: "https://www1.hkexnews.hk/app/sehk/2026/108870/documents/sehk26091300124.pdf",
    ...over,
  };
}

test("① 申请编号提取：sehk / gem 两种路径，officialUrl 优先，非港交所 URL 返回 undefined", () => {
  assert.equal(
    hkexAppIdOf({ url: "https://www1.hkexnews.hk/app/sehk/2026/108870/2026091300120_c.htm" }),
    "108870",
  );
  assert.equal(
    hkexAppIdOf({ url: "https://www1.hkexnews.hk/app/gem/2026/108866/2026091000823_c.htm" }),
    "108866",
  );
  assert.equal(
    hkexAppIdOf({
      url: "https://example.com/news/1",
      officialUrl: "https://www1.hkexnews.hk/app/sehk/2026/108867/2026091001722_c.htm",
    }),
    "108867",
    "officialUrl 应优先于 url",
  );
  assert.equal(hkexAppIdOf({ url: "https://www.szse.cn/listing/projectdynamic/ipo/index.html#prj1" }), undefined);
});

test("② 实体匹配：港交所编号精确命中（实测真实 URL 形态）", () => {
  const leads = [lead({ leadId: "108870", appId: "108870" }), lead({ leadId: "108867", appId: "108867" })];
  const hit = matchRedchipLead(
    {
      url: "https://www1.hkexnews.hk/app/sehk/2026/108870/2026091300120_c.htm",
      officialUrl: "https://www1.hkexnews.hk/app/sehk/2026/108870/2026091300120_c.htm",
      title_cn: "深圳市海柔創新智能科技集團股份有限公司 - W（主板递表·广东企业）",
    },
    leads,
  );
  assert.equal(hit?.leadId, "108870");
});

test("③ T7 匹配失败不打标：清单一空 / 编号不在线索库 → undefined", () => {
  const url = "https://www1.hkexnews.hk/app/sehk/2026/999999/2026010100001_c.htm";
  assert.equal(matchRedchipLead({ url, title_cn: "某公司（主板递表）" }, []), undefined);
  assert.equal(
    matchRedchipLead({ url, title_cn: "某公司（主板递表）" }, [lead()]),
    undefined,
    "编号对不上且企业名不同 → 必须不打标（无状态源红线）",
  );
});

test("④ 兜底匹配：编号缺失时按股票代码 → 归一化企业名（同语言包含）", () => {
  const byCode = matchRedchipLead(
    { url: "https://example.com/a", title_cn: "某公司", stockCode: "02688" },
    [lead({ stockCode: "2688" })],
  );
  assert.equal(byCode?.leadId, "108870", "股票代码去前导零后应匹配");

  const byName = matchRedchipLead(
    { url: "https://example.com/media-report", title_cn: "深圳市海柔創新智能科技集團股份有限公司（主板递表·广东企业）" },
    [lead()],
  );
  assert.equal(byName?.leadId, "108870", "同语言归一化企业名包含即命中");
});

test("④b 已知限制：线索只有英文名而条目标是中文名 → 不匹配（须靠编号）", () => {
  const enOnly = lead({ nameCn: "Hai Robotics Innovation Group Co., Ltd. - W", nameEn: "" });
  assert.equal(
    matchRedchipLead({ url: "https://example.com/x", title_cn: "深圳市海柔創新智能科技集團股份有限公司" }, [enOnly]),
    undefined,
    "跨语言企业名不匹配 —— 这正是港交所条目必须靠 URL 编号匹配的原因",
  );
});

test("⑤ 窗口口径 = 日差 ≤ N（今天-N ~ 今天），非「含今天共 N 日」", () => {
  const l = lead({ submitDate: "2026-09-13" });
  // 09-13 相对 09-15 → 日差 2
  assert.ok(inRedchipListWindow(l, "2026-09-15"));
  assert.ok(inRedchipVoiceWindow(l, "2026-09-15"), `voice 窗 = ${REDCHIP_VOICE_WINDOW_DAYS}`);
  // 日差 3 → 出口播窗、仍在列表窗
  assert.ok(inRedchipListWindow(l, "2026-09-16"));
  assert.equal(inRedchipVoiceWindow(l, "2026-09-16"), false);
  // 边界：日差恰为 7 在列表窗内（IPO 2026-09-10 实锤口径），8 出窗
  assert.ok(inRedchipListWindow(l, "2026-09-20"), `日差 7 应在列表窗内（LIST=${REDCHIP_LIST_WINDOW_DAYS}）`);
  assert.equal(inRedchipListWindow(l, "2026-09-21"), false, "日差 8 应出窗");
});

test("⑥ 时间红线：submitDate 缺失回退 discoveredAt；两者都缺 → 不进任何窗口", () => {
  const noSubmit = lead({ submitDate: undefined, discoveredAt: "2026-09-15T08:00:00+08:00" });
  assert.equal(leadDateKey(noSubmit), "2026-09-15");
  assert.ok(inRedchipListWindow(noSubmit, "2026-09-15"));

  const none = lead({ submitDate: undefined, discoveredAt: "" });
  assert.equal(leadDateKey(none), undefined);
  assert.equal(inRedchipListWindow(none, "2026-09-15"), false, "无任何日期 → 不进窗口（不拿抓取时刻兜底）");

  const bad = lead({ submitDate: "2026/09/13" });
  assert.equal(leadDateKey(bad), "2026-09-15", "非法格式 submitDate 应忽略并回退 discoveredAt");
});

test("⑦ 徽章文案（§3.1）：redchip 完整证据=红筹线索；证据不全降级待核；non-redchip 不打", () => {
  assert.equal(redchipLabelOf(lead()), "红筹线索");
  assert.equal(redchipLabelOf(lead({ sourceUrl: undefined })), "红筹线索·待核", "缺回原文链接 → 降级待核");
  assert.equal(redchipLabelOf(lead({ domicile: undefined })), "红筹线索·待核");
  assert.equal(redchipLabelOf(lead({ gdCityHits: 2 })), "红筹线索·待核");
  assert.equal(redchipLabelOf(lead({ verdict: "unverified" })), "红筹线索·待核");
  assert.equal(redchipLabelOf(lead({ verdict: "non-redchip" })), "");
});

test("⑧ 证据完整三条件（注册地 ∧ 词频达标 ∧ 源链接）", () => {
  assert.equal(hasCompleteEvidence(lead()), true);
  assert.equal(hasCompleteEvidence(lead({ domicile: "" })), false);
  assert.equal(hasCompleteEvidence(lead({ gdCityHits: 3 })), true);
  assert.equal(hasCompleteEvidence(lead({ gdCityHits: 2 })), false);
  assert.equal(hasCompleteEvidence(lead({ sourceUrl: "" })), false);
});
