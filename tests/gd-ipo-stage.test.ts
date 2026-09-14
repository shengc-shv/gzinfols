import { test, describe } from "node:test";
import assert from "node:assert/strict";
// 2026-09-11 IPO 辅导阶段细分：枚举「四处同步」一致性测试（比 gzinfo 更强的断言）。
// gzinfo 仅断言 IPO_STAGE_ORDER.length === GD_STAGES.size；本测试额外钉死：
//   ① 顺序与 BIZ_VALUE_RANK 降序同序（gzinfo 明确设计约束）；
//   ② 每个合法阶段都有展示标签（防漏标签）；
//   ③ 每个合法阶段都在 STAGE_RANK / BIZ_VALUE_RANK 有键（防 gzinfo 本次那样的权重表遗漏）。
import {
  GD_STAGES,
  isGdStage,
  IPO_STAGE_ORDER,
  GD_IPO_STAGE_LABEL,
} from "../lib/services/classify/gd-ipo";
import { BIZ_VALUE_RANK } from "../lib/services/classify/gd-ipo-spoken";
import { STAGE_RANK } from "../lib/pipeline/side-outputs/side-gd-ipo";

describe("IPO 阶段枚举一致性（stage-coach-done 细分）", () => {
  test("阶段集合包含新阶段 stage-coach-done", () => {
    assert.ok(GD_STAGES.has("stage-coach-done"), "GD_STAGES 应含 stage-coach-done");
    assert.ok(isGdStage("stage-coach-done"), "isGdStage('stage-coach-done') 应为 true");
  });

  test("IPO_STAGE_ORDER 与 GD_STAGES 集合大小相等（gzinfo 基线断言）", () => {
    assert.equal(IPO_STAGE_ORDER.length, GD_STAGES.size, "展示顺序条数应等于合法阶段数（防漏）");
  });

  test("IPO_STAGE_ORDER 每个元素 ∈ GD_STAGES，且无重复", () => {
    for (const s of IPO_STAGE_ORDER) {
      assert.ok(isGdStage(s), `IPO_STAGE_ORDER 含非法阶段 ${s}`);
      assert.ok(GD_STAGES.has(s), `IPO_STAGE_ORDER 元素 ${s} 不在 GD_STAGES`);
    }
    assert.equal(
      new Set(IPO_STAGE_ORDER).size,
      IPO_STAGE_ORDER.length,
      "IPO_STAGE_ORDER 不得有重复阶段",
    );
  });

  test("IPO_STAGE_ORDER 与 GD_STAGES 全覆盖（集合元素双向不漏）", () => {
    // 每个合法阶段都必须出现在展示顺序里（否则该阶段分栏/筛选条会缺失）
    for (const s of GD_STAGES) {
      assert.ok(
        (IPO_STAGE_ORDER as string[]).includes(s),
        `合法阶段 ${s} 未出现在 IPO_STAGE_ORDER`,
      );
    }
  });

  test("IPO_STAGE_ORDER 顺序 == GD_STAGES 按 BIZ_VALUE_RANK 降序（同序约束）", () => {
    const derived = [...GD_STAGES].sort((a, b) => BIZ_VALUE_RANK[b] - BIZ_VALUE_RANK[a]);
    assert.deepEqual(
      derived,
      IPO_STAGE_ORDER as string[],
      "IPO_STAGE_ORDER 必须与 BIZ_VALUE_RANK 降序同序（gzinfo 设计约束）",
    );
  });

  test("每个合法阶段都有展示标签（防漏标签）", () => {
    for (const s of GD_STAGES) {
      const label = GD_IPO_STAGE_LABEL[s];
      assert.ok(typeof label === "string" && label.length > 0, `阶段 ${s} 缺少展示标签`);
    }
    assert.equal(GD_IPO_STAGE_LABEL["stage-coach-done"], "辅导完成", "新阶段标签应为「辅导完成」");
  });

  test("每个合法阶段都在 STAGE_RANK 与 BIZ_VALUE_RANK 中有键（防权重表遗漏）", () => {
    for (const s of GD_STAGES) {
      assert.ok(s in STAGE_RANK, `STAGE_RANK 缺少键 ${s}（会导致进度排序回退 0）`);
      assert.ok(s in BIZ_VALUE_RANK, `BIZ_VALUE_RANK 缺少键 ${s}（会导致商机排序 NaN）`);
    }
  });

  test("STAGE_RANK 进度序：tutoring < coach-done < reviewing < registered < listed", () => {
    assert.ok(STAGE_RANK["stage-tutoring"] < STAGE_RANK["stage-coach-done"], "辅导完成应晚于辅导备案");
    assert.ok(STAGE_RANK["stage-coach-done"] < STAGE_RANK["stage-reviewing"], "辅导完成应早于在审");
    assert.ok(STAGE_RANK["stage-reviewing"] < STAGE_RANK["stage-registered"], "在审应早于注册");
    assert.ok(STAGE_RANK["stage-registered"] < STAGE_RANK["stage-listed"], "注册应早于已上市");
  });

  test("BIZ_VALUE_RANK 商机序：tutoring > coach-done > registered > reviewing > listed", () => {
    assert.ok(BIZ_VALUE_RANK["stage-tutoring"] > BIZ_VALUE_RANK["stage-coach-done"], "辅导备案商机最高");
    assert.ok(BIZ_VALUE_RANK["stage-coach-done"] > BIZ_VALUE_RANK["stage-registered"], "辅导完成应高于注册");
    assert.ok(BIZ_VALUE_RANK["stage-registered"] > BIZ_VALUE_RANK["stage-reviewing"], "注册应高于在审");
    assert.ok(BIZ_VALUE_RANK["stage-reviewing"] > BIZ_VALUE_RANK["stage-listed"], "在审应高于已上市");
    assert.equal(BIZ_VALUE_RANK[""], 0, "无阶段信号（\"\"）应为最低");
    // 每个合法阶段的商机权重严格为正，避免与「无阶段」并列
    for (const s of GD_STAGES) {
      assert.ok(BIZ_VALUE_RANK[s] > 0, `阶段 ${s} 商机权重应为正`);
    }
  });
});

/**
 * 单一真源断言（2026-09-14 P0-3）。
 *
 * 此前渲染层 `services/render/full.ts` 另有两份**未导入的私有副本**
 * （`IPO_STAGE_ORDER` 与 `GD_IPO_STAGE_LABEL`），且后者注释自称「唯一来源」——
 * 与 classify 侧真源同时存在，新增阶段时两处可同时漂移而只靠「长度相等」的旧断言
 * 无法发现（旧断言 import 的还是渲染侧副本，保护是假的）。
 *
 * 现改为断言**引用同一对象**（strictEqual）：只要有人再复制一份，本测试即红。
 */
describe("IPO 阶段枚举单一真源（渲染层不得另存副本）", () => {
  test("渲染层 re-export 的 IPO_STAGE_ORDER 与 classify 真源是同一对象", async () => {
    const render = await import("../lib/services/render");
    assert.strictEqual(
      render.IPO_STAGE_ORDER,
      IPO_STAGE_ORDER,
      "services/render 的 IPO_STAGE_ORDER 必须与 services/classify/gd-ipo 同一引用（禁止副本）",
    );
    assert.deepEqual(
      [...render.IPO_STAGE_ORDER],
      [...IPO_STAGE_ORDER],
      "顺序与内容需完全一致",
    );
  });

  test("阶段标签真源唯一（classify 导出；渲染层不再声明私有副本）", () => {
    for (const s of GD_STAGES) {
      assert.ok(
        typeof GD_IPO_STAGE_LABEL[s] === "string" && GD_IPO_STAGE_LABEL[s].length > 0,
        `阶段 ${s} 必须有展示标签`,
      );
    }
    assert.equal(Object.keys(GD_IPO_STAGE_LABEL).length, GD_STAGES.size + 1, "含「无阶段」键");
  });
});
