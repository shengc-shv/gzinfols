/**
 * 单机构新闻过滤加锁测试（2026-08-25 用户决定永久生效的规则，此前**零测试覆盖**）。
 *
 * 规则（lib/services/select/filters/single-institution.ts 头注释）：
 *   - 只提到 1 家金融机构且不在白名单 → 过滤（对分行无参考意义）
 *   - 提到 0 家（宏观/政策）或 ≥2 家（同业对比）→ 保留
 *   - 白名单 = 六大国有行 + 广州银行/广州农商行
 *   - 泛称（多家银行/银行理财/保险公司/存款保险…）不视为机构
 *
 * 2026-09-16 回归：制度领域词「存款保险 / 农业保险」曾被当成单家机构，
 * 导致《存款保险条例实施情况评估报告》这类核心题材被误杀 —— 已加入泛称掩码。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { shouldKeepSingleInstitution } from "../lib/services/select/filters/single-institution";

const keep = (title: string, excerpt?: string) =>
  shouldKeepSingleInstitution({ title, excerpt });
const drop = (title: string, excerpt?: string) =>
  !shouldKeepSingleInstitution({ title, excerpt });

test("① 提到 0 家机构（宏观/政策/市场）→ 保留", () => {
  assert.equal(keep("8月社融增量23.91万亿 直接融资首超信贷"), true);
  assert.equal(keep("多地出台稳楼市新政 涉及公积金与首付比例"), true);
  assert.equal(keep("LPR连续三个月按兵不动"), true);
});

test("② 提到 1 家非白名单机构 → 过滤（对分行无参考意义）", () => {
  assert.equal(drop("成都银行发布2026年中报"), true);
  assert.equal(drop("转载｜以专业立身，以稳健致远：民生理财入围2026卓越至臻银行理财公司"), true);
  assert.equal(
    drop("信托快报丨载誉前行，西部信托“泽元02号”入选“金贝”资产管理竞争力优秀案例"),
    true,
    "实网原题（含引号）——引号会打断机构探测的误匹配",
  );
  assert.equal(drop("渤海银行被罚 涉贷款资金挪用"), true);
});

test("③ 提到 1 家白名单机构（六大行/广州银行/广州农商）→ 保留", () => {
  assert.equal(keep("工商银行推出养老金融服务方案"), true);
  assert.equal(keep("农行广州分行落地首单数字人民币保费缴纳"), true);
  assert.equal(keep("广州银行发布年度社会责任报告"), true);
});

test("④ 提到 ≥2 家机构（同业对比）→ 保留", () => {
  assert.equal(keep("六大国有行与股份制银行同步下调存款利率"), true);
  assert.equal(keep("工行、建行、中行集体发布公告"), true);
});

test("⑤ 泛称不视为机构：多家银行/银行理财/保险公司等", () => {
  assert.equal(keep("多家银行收紧个人贵金属业务 原因何在？"), true);
  assert.equal(keep("银行理财产品规模突破30万亿元"), true);
  assert.equal(keep("保险公司准入新规征求意见"), true);
});

test("⑥ 回归（2026-09-16）：制度领域词「存款保险 / 农业保险」不得当成单家机构", () => {
  assert.equal(keep("存款保险条例实施情况评估报告发布"), true, "存款保险=央行核心制度");
  assert.equal(keep("存款保险宣传周启动 覆盖全省200个网点"), true);
  assert.equal(keep("农业保险承保理赔管理办法发布"), true, "领域词，非「XX农业保险公司」");
  assert.equal(keep("我国农业保险高质量发展政策迭代落地"), true);
});

test("⑦ 回归不放宽：单家非白名单机构（含公司前缀的机构名）仍应过滤", () => {
  assert.equal(drop("安华农业保险获批增资"), true, "带公司前缀的机构名不在泛称掩码范围");
  assert.equal(drop("平安理财半年考：规模与费率双承压"), true);
});
