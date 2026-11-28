/**
 * 研报台账的**唯一写入点**（装配层，2026-11-28 sc 要求从旁路挪出）。
 *
 * 为什么从 `side-outputs/side-research.ts` 挪到这里：
 *  - 旁路跑在 `runPipeline` 内部，而 `runPipeline` 也被 e2e / replay / 单测直接调用
 *    —— 写盘写在管线里，等于让「用 2026-09-11 跑一遍」的测试往真实台账灌假日期
 *    （实测 `data/research-ledger.json` 的 firstSeen 被成批写成 09-11、updatedAt 被推成测试日期）。
 *  - 与经营重点台账同构（`pipeline/focus-context.ts#recordFocusRun`）：管线只算、装配层才落盘，
 *    判据是「谁会真的把这期报告发出去」—— 只有 `scripts/daily.ts`。
 *
 * 降级（一律只告警、绝不抛错 —— 台账坏了不能拖垮当天日报）：
 *  - 没抓到条目 / 没有报告日期 → 什么都不写（不留空壳天，避免 updatedAt 被推成今天却零内容）；
 *  - 条目发布日期晚于报告日 → 判定「报告日不是真实抓取日」（多半是用历史 REPORT_DATE 回跑），
 *    这批不入台账（见函数内注释；面板不受影响）；
 *  - 台账 corrupt → **拒绝写回**（原文件原样保留等人工处理；空台账覆盖 = 历史被静默清空）；
 *  - 写盘失败 → 告警，当天报告与面板照常。
 *
 * @param captured 本次抓到的**全量**条目（`ctx.researchCaptured`，未截断的面板源数据）
 * @param today 报告日期键（北京时间 YYYY-MM-DD）—— 台账的 updatedAt 与首见日口径统一用它
 * @param file 仅测试注入用；生产走 adapter 默认路径 `data/research-ledger.json`
 *   （路径必须参数化：`path.resolve` 在 import 时求值，测试改 cwd 来不及）
 */
import type { Logger } from "../contracts/pipeline";
import type { ResearchPanelItem } from "../contracts/research";
import { readResearchLedger, writeResearchLedger } from "../adapters/research/ledger-store";
import { mergeResearchLedger } from "../services/research/ledger";

/** 条目主键（与 `services/research/ledger.ts` 的 keyOf 同口径：url 为主，标题兜底）。 */
function keyOf(it: ResearchPanelItem): string {
  return it.url || it.title;
}

export function recordResearchRun(
  captured: readonly ResearchPanelItem[] | undefined,
  today: string,
  log?: Logger,
  file?: string,
): void {
  if (!captured?.length || !today) return;
  try {
    // 🔴 防「用历史 REPORT_DATE 回跑」把假首见日灌进台账：
    // 研报不可能在未来发布，条目里的 publishedAt 是源站原文时间（R6，不做兜底），
    // 故 publishedAt > today 只有一种解释 —— today 不是真实抓取日。
    // 实测 2026-11-28：用 REPORT_DATE=2026-09-11 跑了一次，新浪首页 22 条全被记成
    // firstSeen=09-11（发布日期是 11 月下旬）。这类条目只跳过，不整批放弃：
    // 源站偶发错标单条日期时，其余正常条目照常入账。
    const usable = captured.filter((it) => it.publishedAt <= today);
    if (usable.length < captured.length) {
      const sample = captured.find((it) => it.publishedAt > today);
      log?.warn(
        "research",
        `研报 ${captured.length - usable.length} 条发布日期晚于报告日 ${today}` +
          `（如 ${sample?.publishedAt}）→ 判定报告日不是真实抓取日，这批不入台账` +
          `（面板不受影响；请核对 REPORT_DATE）`,
      );
    }
    if (!usable.length) return;

    const read = readResearchLedger(file);
    if (read.state === "corrupt") {
      // 🔴 拒写回：拿「空台账 + 当天几条」覆盖 = 几百条历史被静默清空（10-19 实测过）。
      log?.warn(
        "research",
        `研报台账解析失败，本次拒绝写回（历史保留，本期只出面板）: ${read.error}`,
      );
      return;
    }

    const merged = mergeResearchLedger(read.ledger, usable, { today });
    writeResearchLedger(merged, file);

    // 统计口径：以「合并前后是否出现该主键」判定新增 / 收敛裁掉，不用长度相减
    //（窗口滚动时「新增 N 条」会被裁旧条数抵掉，甚至算出负数，误导排障）。
    const before = new Set((read.ledger.items ?? []).map(keyOf));
    const after = new Set(merged.items.map(keyOf));
    const added = merged.items.filter((it) => !before.has(keyOf(it))).length;
    const dropped = [...before].filter((k) => !after.has(k)).length;

    log?.info(
      "research",
      `研报台账：本次抓 ${usable.length} 条 · 新增 ${added} 条` +
        `${dropped ? ` · 超 90 天裁掉 ${dropped} 条` : ""} · 累计 ${merged.items.length} 条`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log?.warn("research", `研报台账写入失败（本期面板仍可用）: ${msg}`);
  }
}
