# 红筹商机集成方案（red → gzinfols）

> 目标：在本项目内对 IPO 企业打「红筹」商机标，点击可查看对应分析报告，用于高效跟进商机。
> 前置：本方案基于对 `red` 仓库**真实产物**的核对（`data/listing_full.csv` 474 行、
> `data/listing_full_state.json`、`output/` 全量扫描），不采信 README 的自我描述。
> 状态：**待用户拍板后实施**（文末列 4 个决策点）。

---

## 一、先校准事实：red 侧到底有什么

实施前必须先纠正三处认知偏差，否则方案会建在错误前提上。

### 1.1 「港股 + 美股」实际是「港股批量 + 美股单公司」

| 能力 | 实际状态 | 证据 |
|---|---|---|
| 港股清单 | ✅ 完整批量 | `data/listing_full.csv` 474 条，全部来自港交所披露易（`board` 只有主板/GEM，`status` 只有 处理中/处理中(含PHIP)/已上市） |
| 美股批量清单 | ❌ **不存在** | `data/` 下无任何美股清单文件；`config/targets.yaml` 里 `market: us` 只有 **BABA 一条**（且是杭州企业） |
| 美股单公司穿透 | ✅ 代码可用 | `src/redchip/overseas/sec.py` 被 `pipeline/run.py:55` 引用；`output/BABA/` 有完整产物（result.json / report.md / mermaid） |
| 境内工商（持股比例） | ❌ 当前不可用 | `CNBizAPI` 2026-09 实测不可用，降级走 `fixtures/cnbiz/sample.json` |

**结论**：本次集成**以港股红筹为主体**；美股只能做"指定几家（如已上市的广东系美股中概）按需穿透"，
不具备批量打标的数据基础。若要做美股批量，需先在 red 侧补齐美股清单采集（属独立工作量）。

### 1.2 「广东红筹」不能用 `gd_flag` 关联 —— 必须用「离岸正文通道」

这是**最容易踩的坑**。实测交叉表：

| `gd_flag` | `redchip_l2` | 条数 |
|---|---|---|
| 空 | 否-H股 | 311 |
| **是** | **否-H股** | **85** |
| 空 | **是(线索待核)** | **38** |
| 空 | 疑似 | 21 |
| 空 | 待核验(仅listedco可补) | 6 |
| 空 | 否-其他 | 2 |
| 空 | 待核验(官方未刊发文档) | 1 |
| 是 | 待核验(仅listedco可补) | 1 |

**`gd_flag=是` ∧ 红筹线索 = 0 条。** 原因在 red 的 `output/筛选条件_广东红筹.md` 里写得很明确：

> "⚠️ 明确不作为条件的：企业名称是否含广东地名（`gd_flag`）。
> 名称预筛会漏掉全部「开曼壳名 + 广东运营实体」的正典红筹——
> 实测 59 家离岸申请人中**没有一家**名称含粤字。"

所以**正确的红筹商机池**是「离岸注册 + 广东运营线索」这条通道：

```
条件：domicile ∈ {开曼群岛, 百慕大}（封面页权威口径）
  AND gd_opco_count ≥ 3（广东城市词频）
  AND status ∈ {处理中, 处理中(含PHIP), 已上市}
  AND submit_date ≥ 2026-01-01
```

分层结果（red 官方文档口径）：

| 层 | 判据 | 家数 | 可用性 |
|---|---|---|---|
| **核心** | 命中 `SUMMARY`/`CORPORATE INFORMATION`（公司自述总部/运营实体） | **23** | 高，噪音低 |
| **核心(沿革章·实体内述)** | 仅命中 `HISTORY`，但 `gd_opco_entity_count ≥ 3` | **2** | 高 |
| **补充** | 仅命中 `HISTORY` 且实体语境不足 | **13** | **低——且 ≠ 非广东**（Huge Dental 实为深圳企业却落此层） |
| 未命中 | — | 21 | — |

→ **可用的高置信商机池 = 25 家（核心 23 + 沿革章实体内述 2）。** 补充层 13 家须逐家人工复核后才可展示。

### 1.3 「点击查看分析报告」——36/38 家目前没有报告

`output/` 实际内容：

| 产物 | 覆盖 |
|---|---|
| `output/<id>/`（`result.json` / `report.md` / `mermaid` / `graph.json`） | **仅 `00700`（腾讯）、`BABA`（阿里）2 个目录** |
| `output/红筹架构分析_*.md`（人工/重点深度报告） | **仅 2 篇**：錢大媽（108804）、Exegenesis Bio（108832） |
| `output/<id>/report.manual.md` | `BABA` 有，其余未见 |

而红筹线索有 38 家。**即 36 家点开是空的。**

但好消息是：**L0 卡片速览所需字段在 CSV 里全都有**——`domicile` / `cover_evidence` /
`gd_opco_source`（如 `corporate info | guangzhou×84, shenzhen×43`）/ `gd_tier` / `is_vie` /
`vie_source` / `vie_evidence` / `app_proof_url`，**可以零 LLM 成本为 38 家全覆盖**。

### 1.4 关键红线冲突：red 的原文摘录里含银行名

`gd_opco` / `vie_evidence` 是招股书**原文片段**，其中包含「主要往来银行」披露，实测样例：

```
108395 XREAL Ltd.    → "Principal Banks China Merchants Bank Tower No. 7088 Shennan Boulevard Shenzhen"
108804 錢大媽          → "主要往来银行｜中国银行广州番禺支行"
```

**BD 价值极高**（可判断哪家同业已锁定该客户、是否可切入），但它触碰本项目
「不得出现可定位到具体银行主体的信息」红线，且输出物是**公开静态站**。

→ 适配层必须做**脱敏分档**，见 §3.4。

---

## 二、设计原则（贴合本项目既有架构红线）

| 原则 | 落地要求 |
|---|---|
| **无状态源架构红线** | 红筹标**不得**因为"这条来自红筹数据源"就打上。必须做**实体匹配**（企业名/股票代码/港交所申请编号），匹配不上就不打标 |
| **宁缺毋滥** | 只标核心层 25 家；补充层 13 家默认不标（或标灰 + 明确不确定性）；`疑似`/`待核验` 一律不标 |
| **线索 ≠ 结论** | UI 文案统一为「红筹线索·待核」，禁止渲染成确定的「红筹」判定 |
| **行外信息免责** | red 产物含「本报告为行外公开信息初筛，须经行内渠道复核」，转 HTML 后**必须原样保留** |
| **不新增采集通道** | 红筹是「给已有 IPO 条目加一个维度」，不新建漏斗、不进关键词表、不改 `sources.config.json` |
| **跨仓库不硬依赖** | 不在运行时直读 `red/` 路径（red 是独立 git、路径会变）。走**冻结快照**，与既有 `data/local-ipo.json` 模式完全一致 |
| **AI 分析由 WorkBuddy 撰写** | L0 卡片的"商机解读"由我在会话内逐家撰写，**不调用项目 LLM**（遵循既定规则） |
| **不用 category 定归属** | 直接复用 P0-1 的修法：`isGdIpoCandidate` 内容判定为唯一范式 |

---

## 三、模块划分（严格四层）

### 3.1 契约层 `lib/contracts/redchip.ts`（新建，零逻辑）

```ts
/** 红筹线索层级：只保留可用档位，疑似/待核验不入枚举（宁缺毋滥）。 */
export type RedchipLevel = "confirmed-lead" | "suspected";
/** 广东连接分层（red 口径平移）。 */
export type GdtTier = "core" | "core-history" | "supplement";

export interface RedchipLead {
  leadId: string;              // 港交所申请编号（跨年度唯一，作主键）
  nameCn: string;
  nameEn: string;
  board: "主板" | "GEM";
  status: string;
  stockCode?: string;
  submitDate: string;          // YYYY-MM-DD（官方 d 字段）
  domicile: string;            // 开曼群岛 / 百慕大 / 中国(境内) / 香港
  isOffshore: boolean;         // 红筹形态必要条件
  gdTier: GdtTier;
  gdOpcoSource?: string;       // "corporate info | guangzhou×84, shenzhen×43"
  gdOpcoEntityCount: number;
  vie: "current" | "historical" | "none" | "unverified";
  level: RedchipLevel;
  appProofUrl?: string;        // 港交所申请版本 PDF 直链（原文核对入口）
  reports: RedchipReportRef[]; // 由适配器解析出的报告引用
  /** 主要往来银行（脱敏后，见 §3.4） */
  banks?: { count: number; sameCity: boolean };
}

export interface RedchipReportRef {
  level: "card" | "deep" | "manual";
  url: string;                 // 站内相对路径，如 redchip/108804.html
  label: string;
}

/** 索引端口：按任意键查线索（服务层只依赖此接口）。 */
export interface RedchipIndexPort {
  lookup(keys: { name?: string; code?: string; appId?: string }): RedchipLead | undefined;
  all(): RedchipLead[];
}

export const REDCHIP_LEVEL_LABEL: Record<RedchipLevel, string> = {
  "confirmed-lead": "红筹线索·待核",
  suspected: "红筹疑似",
};
```

### 3.2 适配器层 `lib/adapters/redchip/`（新建，唯一 IO 出口）

| 文件 | 职责 |
|---|---|
| `snapshot.ts` | 读 `data/redchip/leads.json` → `RedchipLead[]`（**运行时唯一数据入口**） |
| `report-resolver.ts` | 按 `leadId` 探测 `site/redchip/<id>.html`、`site/redchip/deep/<id>.html`、`site/redchip/manual/*.html` 是否存在，产出 `RedchipReportRef[]` |
| `bank-mask.ts` | 从 `gd_opco`/`vie_evidence` 原文中抽取「主要往来银行」并**脱敏**（只留 `count` 与 `sameCity`） |

**产出端口实现** `createRedchipIndex(deps)`：包成 `RedchipIndexPort`，供服务层消费。

### 3.3 服务层 `lib/services/classify/redchip.ts`（新建，纯函数）

```ts
/** 企业名归一化：去 股份/集团/有限公司/控股/國際/科技/-W/-B/-S 等后缀 + 繁简统一 + 小写。 */
export function normalizeCompanyName(raw: string): string;

/** 实体匹配（内容判定，不看 sourceId/category）—— 三条路径，任一命中即返回。 */
export function matchRedchipLead(
  item: { title: string; excerpt?: string; url?: string; stockCode?: string },
  index: RedchipIndexPort,
): RedchipLead | undefined;
```

匹配优先级：
1. **港交所申请编号**：从标题/URL 抽 `\b(1\d{5})\b`（如「（主板递表）」条目带编号）→ 精确命中
2. **股票代码**：`stockCode` 或标题内 5 位代码 → 精确命中
3. **企业名归一化后精确 / 双向包含匹配**（去后缀再比，避免「深圳市海柔創新智能科技集團股份有限公司 - W」vs「海柔創新」漏配）

**匹配不上 → 不打标**（这是"宁缺毋滥"的技术落地）。

### 3.4 脱敏策略（`bank-mask.ts`，必须由用户拍板后定档）

| 档位 | 输出 | 适用 |
|---|---|---|
| **A（默认·建议）** | 只输出 `banks.count` + `banks.sameCity`，不出现任何行名 | 公开静态站 |
| B | 只对**同业**脱敏，保留本行出现与否 | 需明确"本行未被列为主要往来银行"才有 BD 意义，但仍有主体识别风险 |
| C | 完整行名 | ❌ 不建议进入公开站；如需，走行内系统而非本产物 |

**建议 A**：卡片上显示「已披露主要往来银行 1 家（属地广州）」——足以触发"待核"动作，
具体行名由行内渠道核实，避免公开站出现可反查主体的信息。

### 3.5 编排层 `lib/pipeline/side-outputs/side-redchip.ts`（新建）

在 `buildSideOutputs` 中**追加一步**（不改变既有顺序语义）：

```
输入：report.sections.ipo（已被 side-gd-ipo 构建好）+ RedchipIndexPort
1. 对 sections.ipo 每条 → matchRedchipLead → 命中则写回 item.redchip
2. 汇总命中条目 → redchipPanel 分组数据（按 gdTier + submitDate 排序）
3. 产出 ctx.log 可观测：命中数 / 未命中数 / 线索池总数
输出：report（section 条目带 redchip 字段）+ report.redchipPanel
```

**关键**：只给**已通过内容判定进入 `sections.ipo`** 的条目打标。这样红筹标天然继承
「广东IPO」的内容判定结果，不会绕过无状态源红线。

### 3.6 渲染层 `lib/services/render/redchip-panel.ts`（新建，不堆进 full.ts）

> 这是对 P1-5（god file）的**主动防御**：新面板独立成文件，避免 `full.ts` 再涨。

| 函数 | 用途 |
|---|---|
| `renderRedchipBadge(item)` | 卡片徽章 `<span class="tag t-redchip">红筹</span>`，tooltip 带层级/注册地/VIE |
| `renderRedchipPanel(panel)` | 「红筹商机」专区：核心层 / 补充层两组 + 排序 + 筛选条复用既有 `renderFilterBar` |
| `renderRedchipCard(lead)` | L0 分析报告页（点击后的落地页） |
| `REDCHIP_CSS` | 独立 CSS 常量，拼装进 theme（**不动 `THEME_CSS` 巨型串**） |

徽章配色必须避开既有「粤」标用的品牌红（`t-gd` 已占用 `--accent-cmb`），
否则两个标签视觉不可区分。建议：`t-redchip` 用**靛蓝**（如 `#4f46e5`，与 `--c-tech` 同族但独立变量）。

### 3.7 运维脚本 `scripts/sync-redchip.ts`（新建）

```
用法：tsx scripts/sync-redchip.ts [--source /path/to/red] [--dry-run] [--no-push]

流程：
1. 读 <source>/data/listing_full.csv（或 listing_full_state.json，字段更全）
2. 过滤：domicile ∈ {开曼,百慕大} AND gd_opco_count ≥ 3 AND status ∈ {处理中*,已上市}
3. 补 enrich 字段：gd_tier / vie / banks（脱敏）→ RedchipLead[]
4. 生成 L0 卡片 HTML → site/redchip/<leadId>.html（38 家全覆盖，零 LLM）
5. 拷贝 L1/L2 报告 → site/redchip/deep/<id>.html、site/redchip/manual/*.html
6. 写 data/redchip/leads.json（冻结快照，**入库**）
7. 非 --no-push 则提交推送（与 data/local-ipo.json 同模式）
```

对应 `package.json` 新增 `"redchip:sync": "tsx scripts/sync-redchip.ts"`。
CI 侧可在 `.github/workflows/` 新增每周一（red 跑完之后）的同步 workflow，
或复用现有 `weekly-registry.yml` 的位置增加一步。

### 3.8 契约扩展 `lib/contracts/report.ts`（增量，向后兼容）

```ts
export interface ReportItemRedchip {
  leadId: string;
  level: RedchipLevel;
  gdTier: GdtTier;
  domicile: string;
  vie: "current" | "historical" | "none" | "unverified";
  appProofUrl?: string;
  reportUrl?: string;
  reportLevel?: "card" | "deep" | "manual";
}
// 追加到 ReportItem：
//   redchip?: ReportItemRedchip;
```

---

## 四、数据流转（端到端）

```
┌─ red 仓库（独立 git，Python，每周一 02:00 UTC 由 CI 跑）──────────────┐
│  data/listing_full.csv               474 行 × 27 列（机器可读主契约）   │
│  data/listing_full_state.json        字段最全（含 multi_url / vie_*）  │
│  output/<id>/{result.json,report.md,mermaid}      仅 00700 / BABA     │
│  output/红筹架构分析_*.md                          仅 2 篇             │
└──────────────────────────┬─────────────────────────────────────────────┘
                           │
       ① scripts/sync-redchip.ts（本地或 CI；--source 指向 red 路径）
          · 过滤「离岸 + 广东运营线索」→ 38 家（核心 25 + 补充 13）
          · 银行信息脱敏（§3.4 档位 A）
                           │
                           ▼
   本项目仓内冻结快照（入库，CI 可消费）
   ├─ data/redchip/leads.json                 ← 结构化线索（唯一数据入口）
   └─ site/redchip/
        ├─ <leadId>.html                      ← L0 卡片速览（38 家全覆盖，零 LLM）
        ├─ deep/<id>.html                     ← L1 穿透报告（从 red 产物转 HTML）
        └─ manual/<名称>.html                 ← L2 人工深度报告
                           │
       ② lib/adapters/redchip/snapshot.ts → RedchipLead[] → RedchipIndexPort
                           │
                           ▼
       ③ lib/services/classify/redchip.ts
          matchRedchipLead(ipoItem, index)   ← 实体匹配：申请编号 / 代码 / 归一化企业名
                           │
                           ▼
       ④ lib/pipeline/side-outputs/side-redchip.ts
          写回 ReportItem.redchip + 产出 redchipPanel 分组
                           │
                           ▼
       ⑤ assembleReport → report.sections.ipo[].redchip
                           │
                           ▼
       ⑥ lib/services/render/redchip-panel.ts
          renderRedchipBadge（卡片徽章）
          renderRedchipPanel（红筹商机专区）
          renderRedchipCard （L0 落地页）
                           │
                           ▼
   产物：daily_reports/<date>/<date>.html  ·  site/index.html
        + site/redchip/*.html（报告落地页，随 Pages 一起发布）
```

**复用点（重要，避免重复造轮子）**：
- 冻结快照 + 脚本推送 = 完全复刻 `lib/adapters/local-ipo.ts` + `scripts/ipo-local.ts` 的既有模式
- 分流 + 分组渲染 = 复用 `renderIpoPanelHtml` 的分组/筛选条/进展条机制
- 卡片渲染 = 复用 `renderReportItemHtml`，只加一个徽章分支

---

## 五、前端交互流程

### 触点 1：IPO 卡片上的「红筹」徽章

```
┌─────────────────────────────────────────────────────────┐
│ [港股] [官方] 港交所新股递表(广东企业赴港)  09/11 · 3天前 │
│ 錢大媽國際控股有限公司（主板递表）                  ← 标题 │
│ 注册地开曼群岛｜境内总部广州｜保荐×××…                    │
│ [粤] [广州] [红筹▸]                    ← 新增徽章（靛蓝） │
└─────────────────────────────────────────────────────────┘
   hover 徽章 → tooltip：
   「红筹线索·待核 ｜ 开曼群岛注册 · 广东运营线索(核心层) · 无 VIE」
   点击徽章 → 跳 site/redchip/108804.html（L0/L1/L2 报告）
```

- 徽章文案**必须是「红筹」而非「红筹商机」**，避免暗示确定性（线索 ≠ 结论）
- 与「粤」标并存：`[粤][广州][红筹]` 三个标签语义不重叠（地域 / 城市 / 架构）
- 无匹配 → **不渲染徽章**（不打标，不显示"非红筹"）

### 触点 2：「红筹商机」专区（新增面板）

位置：`广东IPO动态` tab 内，`renderIpoPanelHtml` 之后追加一个 section。

```
── 红筹商机 · 广东运营线索 ─────────────────────────── [来源/层级 筛选条]
  核心层 · 25 家                                      ← 组头带计数
  ┌──────────────────────────────────────────────────┐
  │ 錢大媽國際控股有限公司        开曼群岛  核心层     │
  │ 递表 2026-08-21 · 主板 · 处理中                    │
  │ 广东连接：guangzhou×84, shenzhen×43, guangdong×12 │
  │ 已披露主要往来银行 1 家（属地广州）                │
  │                    [官方申请版本 ↗] [查看分析报告 →]│
  └──────────────────────────────────────────────────┘
  补充层 · 13 家（须人工复核，不等于非广东）           ← 灰色组，明确标注
  ┌──────────────────────────────────────────────────┐
  │ Huge Dental Limited        开曼群岛  补充层 ⚠      │
  │ …（同结构，视觉降权）                              │
  └──────────────────────────────────────────────────┘
```

- 排序：`gdTier 核心 > 核心(沿革章) > 补充`，同层内按 **递表日倒序**（最新商机在前）
- 「查看分析报告」按钮三态：
  - 有 L1/L2 → `查看分析报告 →`（跳 deep/manual）
  - 只有 L0 → `查看线索卡 →`
  - 无（不应发生，L0 全覆盖）→ 不渲染按钮
- 筛选条复用既有 `renderFilterBar` 机制（维度：层级 / 来源），与 IPO 面板同款，零新 JS

### 触点 3：分析报告落地页 `site/redchip/<leadId>.html`

```
┌────────────────────────────────────────────────────────────┐
│ ← 返回简报                                                    │
│ 錢大媽國際控股有限公司（港交所申请编号 108804）              │
│ [红筹线索·待核] [开曼群岛] [主板·处理中] [递表 2026-08-21]   │
│ ⚠️ 本报告为行外公开信息初筛，须经行内渠道复核。只呈现事实信息，│
│    不含行动建议与排期。                          ← 免责声明必留│
├────────────────────────────────────────────────────────────┤
│ 一、架构穿透                                                  │
│   开曼主体 → FJS Holding(BVI) → … → 广州钱大妈（境内 opco）   │
│   （有 mermaid 则内嵌图；无则文本链 + 标注"图形未还原"）      │
│ 二、广东连接证据                                              │
│   命中分册：CORPORATE INFORMATION                            │
│   证据：境内总部及主要营业地 = 广州市海珠区…（原文引用）      │
│ 三、VIE 状态：无（vie_scanned=是）                            │
│ 四、商机解读（≤150 字，由 WorkBuddy 撰写，非项目 LLM）        │
│ 五、原文核对入口                                              │
│   [港交所申请版本 PDF ↗]  ← app_proof_url 直链               │
└────────────────────────────────────────────────────────────┘
```

### 触点 4（可选）：站点级入口

`build-site.mjs` 生成 `archive.html` 时，可加一个「红筹商机台账」入口，
复用 red 的 `gd_hk_ipo_2026_bd_ledger.md` 思路但不引入其文件（在本项目内生成）。

---

## 六、实施批次建议

| 批次 | 内容 | 产出 | 依赖 |
|---|---|---|---|
| **R1** | 契约 + 适配器 + `sync-redchip` 脚本；L0 卡片全覆盖 38 家 | `data/redchip/leads.json` + `site/redchip/*.html` | 无（CSV 已就绪） |
| **R2** | 服务层匹配 + `side-redchip` 接线 + 徽章渲染；加锁测试 | IPO 卡片出现「红筹」徽章，点击可跳 L0 | R1 |
| **R3** | 红筹商机专区面板 + 筛选条 + 补充层灰显 | 「广东IPO动态」tab 内新增红筹专区 | R2 |
| **R4** | L1 深度报告转化（核心层 25 家；先在 red 侧跑 pipeline） | `site/redchip/deep/*.html` | 需在 red 侧跑逐家 pipeline（成本需拍板） |
| **R5**（可选） | 美股红筹通道 | 需 red 侧先补齐美股清单采集 | 独立工作量 |

**先决条件**：R1–R3 依赖 P0-1 修复（`crunchbase-news` 的 `category` 纠错 + 去掉
`category === "gd-ipo"` 直通分支）。否则红筹标会继承当前错误的 IPO 板块归属。

---

## 七、需要用户拍板的 4 个决策点

| # | 决策 | 选项 | 我的建议 |
|---|---|---|---|
| **D1** | 报告粒度与生成范围 | (a) 只做 L0 卡片全覆盖 38 家<br>(b) L0 全覆盖 + L1 深度只做核心层 25 家<br>(c) 再加 L2 人工挑重点 | **(b)** —— L0 零成本先落地拿到即时价值；L1 只投 25 家高置信，成本可控 |
| **D2** | 「主要往来银行」是否展示 | (a) 只显示"已披露 N 家（属地广州）"<br>(b) 显示同业行名<br>(c) 完整行名 | **(a)** —— BD 触发价值保留，同时不触碰银行主体脱敏红线 |
| **D3** | 美股红筹是否纳入本轮 | (a) 本轮只做港股<br>(b) 顺带做几家指定美股中概 | **(a)** —— red 侧美股无批量清单，纳入会让方案范围失控；建议列为独立后续 |
| **D4** | 数据同步方式 | (a) 本项目 `redchip:sync` 脚本 + 手动推快照（同 `ipo:local`）<br>(b) red 的 workflow 产 artifact，本项目 CI 下载 | **(a)** —— 与既有模式一致，零 CI 改造；后续如需再演进到 (b) |

---

## 八、已知限制（须与产物一并告知使用者）

1. **线索 ≠ 结论**：`redchip_l2` 与 `gd_tier` 均为 red 侧推导值，招股书原文片段是唯一权威；
   每家的「广东连接」都需回原文复核（卡片已附原文引用与 PDF 直链，便于复核）。
2. **补充层 13 家不等于非广东**：实测 Huge Dental Limited 为深圳企业却落入补充层
   （自述章未用 `our subsidiary` 句式）。故补充层只能灰显 + 标注，不能据此排除。
3. **未接入境内工商**：境内持股比例、实际控制人无法核（red 侧 CNBizAPI 不可用），
   穿透只能到"境内运营实体"一层。
4. **秘密递表不在清单内**：港交所秘密递交（保密形式）不公开，属官方盲区。
5. **注册地未判定 17 家**：474 家中 17 家 `domicile` 为空（10 家取数超时 + 6 家封面句未命中
   + 1 家官方未刊发），这 17 家可能含遗漏的红筹。
6. **美股缺批量清单**：见 §1.1。
7. **免责声明必须随产物发布**：所有红筹页面保留「行外公开信息初筛，须经行内渠道复核」。
