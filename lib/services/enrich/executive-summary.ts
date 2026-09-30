import { extractJson } from "./json-util";
import { mapSubcategoryToSegments, OTHER_SEGMENT } from "../classify/customer-segment";
import { INSIGHT_OTHER_GROUP, segSpeak } from "../voice/speech-lines";
import { titleSimilarityDice } from "../select/filters/dedup-similar";
import {
  rankByRelevance,
  scoreBranchRelevance,
  type BranchRelevance,
  type ScorableArticle,
} from "../select/filters/relevance-score";
// 必读 / 洞察候选池条数（单一真源，禁止就地写死数字）
import { MUST_READ_CANDIDATE_POOL, INSIGHT_CANDIDATE_POOL } from "../memory/event-types";

/**
 * 「执行摘要 / 商机提示」AI 层（用户 2026-08-19 确认实施）
 *
 * 每天一次 LLM 调用，基于当日 宏观政策(finance) + 广州商机(gz) 的高信号条目
 * 与市场点评，产出：
 *  - must_read：今日必读 3-5 条（高影响事件 + 对分行意味着什么）
 *  - insights：商机提示 10-12 条（候选池；对广州分行零售/对公的潜在影响 + 建议动作；每客群段≤2、其他≤1）
 * 把「看新闻」升级为「看结论」。任何失败 → 返回 null，页面不渲染该板块。
 */

export interface ExecInsight {
  /** 主题（一句话，如「LPR 下调预期升温」） */
  topic: string;
  /** 对分行零售/对公业务的潜在影响 */
  impact: string;
  /** 建议动作（获客/产品/风险，可执行） */
  action: string;
  /** 业务线标签（2026-08-21 重构）：从词表选 1-2 个，如 竞对动态/信贷/代发/私行/政银合作/住房金融/财富/客群 */
  tag?: string[];
  /** 客户客群段（2026-09-08 商机洞察三维细分）：零售AUM / 中高端客群(过亿资产) / 普惠小微贷款客户。
   *  可多段归属（一条商机同时影响多类客群时各填一个）；不属任何优先段则省略本字段。 */
  segments?: string[];
  /**
   * 口播与卡面**共用的方向名**（2026-09-30 sc 口径：标签同源）。
   *
   * 由来：口播按客群归并时 LLM 会自拟实质方向名（如「本地消费场景」），若卡面 chip 仍只显示
   * `segments` 原值，行长在车里听到「本地消费场景方面」后、到页面按这四个字找不到入口。
   * 故要求 LLM 把该方向名**同时**写进本字段 → 卡面 chip 与口播组名读同一串字。
   * 缺省时两侧各自回落到 `segments` 既有短名（渲染 `SEG_SHORT` / 口播 `segSpeak`）。
   * 注意：`segments` 仍是筛选/统计口径，`group` 只影响展示名。
   */
  group?: string;
  /** 来源链接（可选，1-3 条）：引用输入中相关源文章（title+url 原样复制），供读者溯源 */
  sources?: Array<{ title: string; url: string }>;
}

export interface ExecutiveSummary {
  /**
   * 今日定调（**2026-09-28 sc 口径：维度提纲 + 看点**）：回答「今天主要看哪几个方面」——
   * 「今天主要看N个方面：X，看点；Y，看点。」，**≤70 字**，不写整句的为什么、不做事件摘要、
   * 不复述必读；每个维度可跟 **3~6 字看点**（量级/紧迫性/影响面）。
   * 它是 must_read / insights 的「目录」，且**决定车里听的行领导愿不愿意继续听下去**。
   * 无则页面不渲染 hero-line。判重命中时由 `deriveHeroLine` 从必读/商机兜底派生。
   */
  hero_line?: string;
  /** 今日必读：高影响事件 + 为何重要 + 源链接（可空：旧归档/AI 未回链时渲染不包 <a>） */
  must_read: Array<{ title: string; why: string; url?: string }>;
  /** 商机提示：对广州分行零售/对公的潜在影响与建议动作 */
  insights: ExecInsight[];
  /** M 层：今日风险（1 条最值得警惕）。evidence 必填具体事件，impact 按部门拆解 */
  risk?: ExecRisk;
  /** 广东/广州 IPO 企业动态口播（≤60字）；当日无相关动态时为 null */
  guangdong_ipo?: { spoken?: string } | null;
  /** 口播稿：今日定调（**LLM 优先**：≤70 字、维度 + 看点、不要问候语；缺失时由 `heroSpeechLine` 兜底派生） */
  spoken_hero?: string;
  /** 口播稿：今日必读（由 `syncNarration` 从去重后的卡面 1:1 确定性派生，不来自 LLM） */
  spoken_must_read?: string;
  /** 口播稿：商机洞察（**LLM 优先**：按客群归并 3~4 条、≤260 字、不念商户名；缺失时由 `syncNarration` 归并兜底） */
  spoken_insights?: string;
  /** M 层：风险口播稿（≤80字，行长听到"今天有 1 个需要警惕：xxx，建议 xxx"形式） */
  spoken_risk?: string;
}

/** M 层：单条今日风险（与 ExecInsight 对称） */
export interface ExecRisk {
  topic: string;
  evidence: string;
  impact: string;
  action: string;
  url?: string;
  source?: "T1" | "T1.5" | "T2";
  sources?: Array<{ title: string; url: string }>;
}

export interface ExecSummaryInput {
  /** 当日宏观政策条目（title + 摘要 + 源链接） */
  finance: Array<{
    title: string;
    summary?: string;
    subcategory?: string;
    url?: string;
    when?: string;
  }>;
  /** 当日广州商机条目（title + 摘要 + 源链接） */
  gz: Array<{
    title: string;
    summary?: string;
    subcategory?: string;
    url?: string;
    when?: string;
  }>;
  /** 市场行情总览（AI 点评，可选） */
  marketOverview?: string;
  /** IPO 板块条目（用于筛广东/广州 IPO 动态口播，可选） */
  ipo?: Array<{ title?: string; summary?: string; url?: string; when?: string }>;
  /** B-1：关键词层已识别的风险候选（来自 risk_tracker），喂给 LLM 的 risk 段 */
  riskCandidates?: Array<{ title: string; url?: string; trackers: string[]; priority: string }>;
  /**
   * 内容记忆提示（2026-09-02 去重机制）：近期已播报事件清单 + 若需重播的
   * 建议切入角度。由 lib/memory/event-memory.ts 的 formatMemoryBrief 生成，
   * 原样追加到提示词中，让 LLM 在**生成阶段**就避开重复表述。
   */
  memoryBrief?: string;
  /** 报告日期 YYYY-MM-DD */
  date: string;
}

const SYSTEM_PROMPT =
  "你是股份行广州分行零售决策简报主编。基于当日信息生成「今日必读」与「商机提示」，面向分行信息技术部领导和分管零售的行领导，严格按用户要求输出 JSON。";

const RULES = `你是股份行广州分行零售决策简报的主编。系统面向分行信息技术部领导和分管零售的行领导（即零售分管行长，关注整个零售条线，而非某个部门总经理），核心诉求：更快掌握宏观经济变化、政府政策变化、市场变化，从而挖掘更多客户、发现更多商机。

业务线全覆盖要求（极重要）：读者是零售分管行长，必读与商机须覆盖零售多条业务线，不得只堆个贷/住房金融。财富管理、私人银行、客群经营与新获客、信用卡、代发、养老、住房金融、消费信贷——这些零售条线地位同等，命中高信号时须与房贷/信贷同优先级置顶；若输入中同时存在房贷政策与财富/私行/获客信号，应分别选取、均衡呈现（例如必读里既有房贷40年新规，也应有财富/私行/获客类高信号）。

时间窗口要求（极重要）：必读与商机须覆盖「今天 + 昨天」两天的信息——既含今日凌晨突发的政策/市场信号，也含昨日白天发布、今天仍在生效的重要条目。不要只基于今天单日挑条目；昨天白天的重要宏观政策、权威机构报告若今天仍具决策价值，应纳入。

时间表述口径（极重要，2026-09-28 sc 口径）：输入里**每条都带 when 字段**（取值如「今天凌晨」「今天一早」「昨天上午」「昨晚」「昨天」「前天」），那是该条新闻**真实的报道/发布相对日**。写 must_read 与 insights 的正文时必须遵守：
- **按 when 表述**：when=昨天 / 昨晚 / 昨天上午 的条目，正文就写「昨天」「昨日下午」，**严禁**写成「今日 / 今天 / 今日凌晨」；
- **when 缺失** = 时间未标明 → 不要给它安任何相对日，直接陈述事实即可（宁可不说时间，也不许猜）；
- **三种时间不得混用**：① **报道时间**（= when，媒体刊发/官方发布时刻）② **事件发生时间**（公告/政策实际发布日，通常与 when 同日；输入另有说明时才以说明为准）③ **报告锚**（本报告出具日 = date 字段，「今天」在报告语境里指报告日）；
- 「今天」**只**用于 when=今天 的条目；**不得**用「今日」笼统统称跨两天的内容；
- 例外：描述**未来动作**的时间词（「本周」「今日起」「节前」「下阶段」）是给团队的行动时限，与新闻时间无关，照常用。

口播听觉场景（极重要，2026-09-28 sc 口径）：口播稿的听众是**早上坐在车里听的行领导** —— 他看不见屏幕、**不能回看**、只有一程车的注意力。**口播的内容质量直接决定他会不会点进来看全文**。因此：
- **开头 15 秒必须给足分量**：让他两三句内就判断出「今天有事值得听」——给量级、给紧迫性、给影响面，不要只报空洞的方向词；
- **结论先行**：每条先讲「发生了什么」（带关键数字/机构/动作），再讲「意味着什么」；不要先铺垫背景再给结论；
- **每条都必须有信息量**：严禁「值得关注」「值得重视」「详见报告」「建议持续跟踪」这类空转句；
- **听觉友好**：不用视觉指代词（该政策 / 上述 / 如下 / 见表），不念编号、括号与层级词；数字以顺口为准（如「39.63万亿」可读作「近四十万亿」）；
- **点出「与我有关」**：凡涉及本周要做的动作或决策，点明关系到哪类客户、哪条业务线 —— 让他觉得「这条我得点进去看」。

基于输入的当日条目（宏观政策 + 广州商机 + 市场总览 + IPO），输出五部分：

0. hero_line（今日定调，**维度提纲 + 看点**，**不超过 70 字**）：回答「今天主要看哪几个方面」，是下面 must_read 与 insights 的「目录」。听众是**早上坐在车里听的行领导** —— 他看不见屏幕，**定调决定他愿不愿意继续往下听**（2026-09-28 sc 口径）。
   - 句式：今天主要看N个方面：X，看点；Y，看点。（N = 2~4）
   - {X} = 3~8 字的领域词组（如「汇率预期管理」「楼市金九银十」「财富货架调整」「消费场景获客」），**不要**写具体企业/机构名或事件细节；
   - {看点} = **3~6 字**的**分量提示**，点出量级、紧迫性或影响面（如「结售汇窗口」「补贴叠加节庆」「近四十万亿」「外资抢跑」）—— 只给看点，**不要**写成完整的「为什么」句；
   - **不做事件摘要、不得换个说法复述某一条必读** —— 定调是纲、必读是目，听众必须能听出分工；
   - 硬约束：整句 **≤70 字**（含标点）；写不下就减少方面数或缩短词组，**不得超**；
   - 若当日确实无突出主题，可输出空字符串；
   - 并为该定调配套口播稿 spoken_hero：把同一批维度说成**一句口语**，**≤70 字**，**不要问候语、不要自我介绍、不要展开成长句**（如「今天主要看四个方面：汇率预期管理，结售汇窗口；楼市金九银十，按揭接单；财富货架调整，节前配置；消费场景获客，补贴叠加节庆。」）；纯口语、无链接/无Markdown/无emoji，可直接朗读。

1. must_read（今日必读，8-10 条）— **偏宏观、市场级大信号**：央行/金融监管总局等全国性政策转向、市场重大变化、行业性新趋势、新产品新玩法。答"今天/本周市场可能怎么走"。**只放宏观，不放具体获客动作**（具体动作归 insights）。
   - title：事件标题（15 字内，中文，可精简）—— **必须自带结论或量级**（如「公募规模近40万亿」优于「公募基金规模变化」）：车里听时这一句就是唯一钩子，务必让人一听就知道「这事有多大」
   - why：为什么重要——对广州分行经营规划/战略意味着什么（**30~45 字，45 字是硬上限**）
     ⚠️ 硬上限的理由：口播按「5 条 ×（标题 ≤15 字 + why）」排预算，总预算 320 字。
     why 写到 60~75 字时，第 5 条的 why 会被截断（2026-09-30 实测：5 条 why 合计 354 字 → 第 5 条只剩标题），
     等于听众少拿到一条「值不值得点进去」的依据。宁可短而准。
   - id：源条目标识，从下方输入对应条目的 id 字段原样回填（若对不上可省略，留空；禁止编造）

  **客户客群聚焦（极重要）**：分行当前最关注的三类客群商机须优先覆盖——① 零售AUM（财富管理/理财/基金/存款/资产配置等零售管理资产）；② 中高端客群(过亿资产)（私行/家族信托/企业主/超高净值）；③ 普惠小微贷款客户（普惠金融/小微企业/个体工商户/经营贷）。生成 insights 时，若输入中存在这三类客群的高信号，应优先选取并分别打上对应 segments 标签，确保三条客群线索在「商机洞察」中都有呈现；不要只堆房贷/宏观而漏掉普惠小微与私行客群。
2. insights（商机提示，10-12 条）— **偏落地、可执行**：具体可落地的获客/产品/客户线索（"哪个客户/产品/动作该做"）。**不放宏观大信号**（宏观归 must_read）；**不放监管威胁**（威胁归 risk）。**多给候选**：下游会按记忆判重剔除近期已播过的，命中重复时顺延取用靠后候选，故请尽量凑满 10-12 条（宁多勿少）。每条：
   - topic：主题（15 字内）
   - impact：对广州分行零售/对公业务的潜在影响（40-60 字）
   - action：建议动作——具体可执行、带时限感（获客方向/产品配置/风险提示，40-60 字），如"本周走访医疗企业客群、今日起推荐放开限购绩优基金"
   - tag：业务线标签数组，从词表选 1-2 个（词表：竞对动态/信贷/代发/私行/政银合作/住房金融/财富/客群/监管/科技金融）
   - segments：客户客群段数组，从固定集合选（可多段）："零售AUM" / "中高端客群(过亿资产)" / "普惠小微贷款客户"。**配额（极重要）**：零售AUM、中高端客群(过亿资产)、普惠小微贷款客户 三类**各最多出现 2 条**，其余（未命中优先段的"其他业务线"）最多 1 条；请在生成 insights 时主动控制数量，同类商机不要堆超过 2 条（必要时合并）。一条商机同时利好多类客群时各填其一（多标签按其优先级归口、各标签配额独立计数，互不挤占）；若都沾不上则省略本字段（渲染时作为"其他业务线"处理）。可参考输入条目的 subcategory 作先验：gz-wealth/cn-wealth 偏零售AUM，gz-private/cn-private 偏中高端客群(过亿资产)，gz-credit 中普惠/小微/经营贷类偏普惠小微贷款客户。
   - **group（口播与卡面共用的方向名，极重要）**：该条商机所属的**口语方向名**（≤8 字），
     会**同时**出现在卡片 chip 与口播组名上 —— **必须是同一串字**。这正是你后面写 spoken_insights 时的分组名。
     优先沿用上面 segments 对应的方向名（零售AUM / 高端客户 / 普惠小微）；
     若该条不属于这三类（如本地消费类、跨境类），**自己归纳一个实质方向名**（如「本地消费场景」「跨境客群」）——
     它会被写进卡片，读者能照着找到，所以**不要用「其他业务线」「其他机会」这类占位词**。
     同方向的多条商机请填写**完全相同**的 group 字符串（这样才能并成一组）。
     例：group 填「本地消费场景」，或沿用客群名「零售AUM」。
   - sources：来源数组（1-3 条，必填优先）。每条为输入中直接支撑该洞察的源文章，原样复制其 {title,id}（id 从输入对应条目回填，不得编造）。若洞察由多条输入综合得出，列最权威的 1-3 条；若确实无任何输入支撑则该字段省略。

3. risk（M 层：今日风险，1 条或 null）— **偏监管/合规威胁**：今天最值得警惕的 1 件事。**与 must_read/insights 严格错开**：
   - must_read 是宏观机会/趋势，insights 是落地动作，**risk 是"威胁/红线"**（监管处罚/合规风险/系统性风险事件/窗口指导等）
   - **不能同一条事件又当 must_read 又当 risk**（同一事件只在一边出现，避免重复说"同样的事情"）
   - 优先从「关键词层风险候选」（即输入中的 risk_candidates 数组，由 B-1 risk_tracker 预识别）里选 —— 这是关键词 + AI 双轨
   - 若 risk_candidates 都不合适，LLM 可自己从 finance/gz 中识别
   - 无突出风险时，risk 设为 null（不要硬编）
   - topic：风险主题（15 字内，如"央行重申防止资金空转"）
   - evidence：依据（1 句，事件本身，**禁止"市场波动/不确定性增加"这类虚词**，必须可溯源到输入条目）
   - impact：对广州分行零售/对公业务的影响（40-60 字，**按部门拆解**：个贷/财富/私行/公司/风控 受影响的方式）
   - action：建议动作（40-60 字，具体可执行，**带部门**："公司部应…/风控部应…"）
   - source：来源权威等级（T1=央妈/金融监管总局/国务院 / T1.5=交易所/行业协会 / T2=媒体智库）
   - sources：来源数组（1-3 条，evidence 依据的输入条目，原样复制 {title,id}）
   ；当日无突出风险时，risk 设为 null（不要硬编）。

4. guangdong_ipo（广东/广州企业 IPO 动态，1 条或 null）：若输入 ipo 条目中存在"广东/广州企业"的 IPO 相关进展，则产出 guangdong_ipo.spoken（≤90字，说清企业名称、注册地、所属行业、上市地（深交/北交/上交/境外）、最新进展，一两句话）；若无广东/广州 IPO 动态，则 guangdong_ipo 设为 null（不要编造）。
   - 算作"IPO 进展"的阶段（2026-08-31 补全，覆盖在审企业全生命周期）：**受理 / 问询** / 过会 / 提交注册 / 注册生效 / 辅导备案 / 招股 / 申购 / 上市敲钟
   - 特别注意：输入里的东财在审表条目常是"IPO已受理""IPO问询中"这类**早期在审状态**——同样算 IPO 进展，不要因为没到"过会/注册"就判为无动态返回 null。

要求：
- 只基于输入信息，不要编造
- 广州本地信息（南沙/广州企业/广州政策）优先于泛全国信息
- 语言精炼，站在分行行长视角，不写空话套话
- 措辞语气：凡涉及"建议分行开展动作"的表达，**措辞灵活、多样化**，避免每条都用"建议分行"开头（可换用「可考虑…」「值得关注…」「下一步观察…」「提示…」「可能影响…」「需注意…」，或直接陈述事实+隐含行动）；**严禁**「分行应该/分行应/须尽快/需尽快/务必」等强硬祈使语气。适用于 hero_line、spoken_hero、insights.action、risk.action。
- **口播稿只写两段：spoken_hero 与 spoken_insights**。必读/风险两段口播由系统确定性地从去重后的卡面数组派生（1:1 对齐），**不要再输出 spoken_must_read / spoken_risk**（输出也会被覆盖）。两段均为纯文本（无 Markdown/链接/emoji，可直接朗读）。
- **spoken_hero**：见 §0（≤70 字、维度 + 3~6 字看点、不要问候语）。
- **spoken_insights（商机口播）口径（极重要，2026-09-28 sc 口径）**：把上面 insights **按客群归并**成 **3~4 条**口语线索，整段 **≤260 字**。每条 =「{客群}方面，{一条或两条主题}，{这类客群本周最该做的一件事}」。
   - **{客群}必须是听众直接听得懂的客群或方向名**（如「零售AUM」「高端客户」「普惠小微」「本地消费场景」「跨境客群」）；**禁止**用「其他业务线」「其他机会」这类无信息占位词 —— 归不进三类优先客群时，请**自己归纳一个实质方向名**（如把消费补贴、文旅商圈、金融城、社区零售归为「本地消费场景」）；
   - 🔴 **组名必须取自 insights 的 group 字段，逐字照抄、不得另起叫法**（2026-09-30 sc 口径：标签同源）。
     读者是**先听后找**：他听到「本地消费场景方面」，就会在页面上找这四个字；卡片 chip 显示的是同一条的
     group 字段，所以只有**逐字一致**才找得到。**本段的分组 = 按 group 归并**，同 group 的卡片合成一条。
   - **同类场景必须合并**：例如「消费补贴」「文旅商圈」「金融城地标」「社区零售」都属本地消费获客，应归成一条；**不得**随 insights 条数线性增长（10-12 条卡面 → 3-4 条口播）；
   - **严禁**念具体商户名 / 商场名 / 街区名（如「沃尔玛社区店」「扬韬广场」），也不要罗列动作细节 —— 细节留给卡面，口播只讲「哪类客群、什么方向、让团队做什么」；
   - 动作只取**首要一件**（如「本周更新私行产品准入清单」），不要罗列三四个动作；
   - **禁止引入 insights 之外的新事实**（2026-09-30 实测踩坑）：本段只能讲 insights 里那几条的
     topic / impact / action。**不得**从输入池或其它板块另取事实来凑内容 ——
     实测出现过口播讲「理财费率下调」「超七十只新基金定档十月」「黄金ETF方向选择」，而这些在商机卡片里
     **根本不存在**（只在「业务启示」板块），听众点进去一定找不到。宁少讲，不要另取。
- 输出 STRICTLY 一个 JSON 对象（无 markdown 代码块）：
{"hero_line":"...","spoken_hero":"...","spoken_insights":"...","must_read":[{"title":"...","why":"...","id":"..."}],"insights":[{"topic":"...","impact":"...","action":"...","tag":["..."],"segments":["零售AUM"],"group":"本地消费场景","sources":[{"title":"...","id":"..."}]}],"risk":{"topic":"...","evidence":"...","impact":"...","action":"...","source":"T1","sources":[{"title":"...","id":"..."}]} 或 null,"guangdong_ipo":{"spoken":"..."} 或 null}
注意：字符串内引号用单引号或中文引号，禁止裸双引号；id 字段原样回填输入中的标识，不要输出 url。`;

/**
 * 商机洞察回链来源：insights 为 AI 综合而成，未必带 sources 字段。
 * 用生成时看到的 inputs（finance+gz，每条含真实 url）按「主题+影响+建议」与
 * 条目标题/摘要的 Dice 相似度，取前 1-3 条命中文章作为 ①/②/③ 溯源入口。
 * 双门槛防错链：Dice ≥ 0.16 且 与命中文本共享 ≥ 2 个中文 bigram（有意义字符片段）。
 *  - Dice 单看易错链改写表述（如「存款利率期限拉平」↔「存1年=存2年=存3年存款利率罕见持平」Dice≈0.18 其实是同主题）；
 *  - 共享 bigram 门槛挡掉「托育园/券商中考/博览会」这类完全无关却偶发高 Dice 的错源。
 * 无达标匹配返回空（优雅降级，不臆造）。sources 已在生成时落地 store.json 复用。
 */
function sharedBigramCount(a: string, b: string): number {
  const sa = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) sa.add(a.slice(i, i + 2));
  let n = 0;
  for (let i = 0; i < b.length - 1; i++) {
    if (sa.has(b.slice(i, i + 2))) n++;
  }
  return n;
}

export function resolveInsightSources(
  topic: string,
  impact: string,
  action: string,
  inputs: Array<{ title: string; summary?: string; url?: string }>,
): Array<{ title: string; url: string }> {
  const norm = (s: string): string => s.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
  const nh = norm(`${topic} ${impact} ${action}`);
  if (!nh) return [];
  const scored: Array<{ title: string; url: string; score: number }> = [];
  for (const it of inputs) {
    if (!it.url) continue;
    const t = it.title || "";
    const corpus = norm(`${t} ${it.summary || ""}`);
    if (!corpus) continue;
    const dt = titleSimilarityDice(nh, norm(t));
    const dc = titleSimilarityDice(nh, corpus);
    const useCorpus = dc >= dt;
    const score = useCorpus ? dc : dt;
    const shared = useCorpus ? sharedBigramCount(nh, corpus) : sharedBigramCount(nh, norm(t));
    if (score >= 0.16 && shared >= 2) scored.push({ title: t, url: it.url, score });
  }
  const best = new Map<string, { title: string; url: string; score: number }>();
  for (const s of scored) {
    const cur = best.get(s.url);
    if (!cur || s.score > cur.score) best.set(s.url, s);
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ title, url }) => ({ title, url }));
}

/**
 * B7 边界互斥守卫（确定性，不依赖 LLM）：同一事件不得既进 must_read/insights 又进 risk。
 * 用标题 Dice 相似度（阈值）+ 含子串关系判定「同一事件」，命中则丢弃 risk（置 undefined），
 * 杜绝「同样一件事」在必读与风险两个板块重复呈现，违反「精确性>丰富性」。
 * 只删 risk：must_read（宏观）与 insights（落地动作）本就是两块、允许共存。
 */
export function dedupeExecutiveCrossSection(exec: ExecutiveSummary): ExecutiveSummary {
  if (!exec.risk) return exec;
  const norm = (s: string) =>
    s.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
  const sigs = new Set<string>();
  for (const m of exec.must_read) sigs.add(norm(m.title));
  for (const i of exec.insights) sigs.add(norm(i.topic));
  const rt = norm(exec.risk.topic);
  if (!rt) return exec;
  const CROSS_DICE = 0.5;
  for (const s of sigs) {
    if (!s) continue;
    if (titleSimilarityDice(rt, s) >= CROSS_DICE) return { ...exec, risk: undefined };
    if (rt.length >= 4 && s.length >= 4 && (rt.includes(s) || s.includes(rt)))
      return { ...exec, risk: undefined };
  }
  return exec;
}

/** LLM runner 类型（组合根把 LlmPort 适配成此签名；gzinfo 为 runLlm 直连）。 */
export type ExecLlmRunner = (systemPrompt: string, userPrompt: string) => Promise<string>;

/**
 * 按分行相关性取前 N（2026-09-15 Token 优化）。
 * 原实现直接 `slice(0, N)` —— 取的是数组前 N 条（严格池按板块顺序、非全局相关性）。
 * 改为按 `scoreBranchRelevance` 排序后取 Top-K，进入 exec 提示词的条目「更该给分行看」，
 * 也让限流（动态 Top-K）更安全。稳定排序：同分保持原顺序。
 */
function topByRelevance<
  T extends { title?: string; summary?: string; subcategory?: string; url?: string },
>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const order = items
    .map((it, i) => ({
      i,
      score: scoreBranchRelevance({
        title: it.title ?? "",
        summary: it.summary,
        subcategory: it.subcategory,
        url: it.url,
      }).score,
    }))
    .sort((a, b) => b.score - a.score);
  return order.slice(0, n).map((o) => items[o.i]);
}

export async function generateExecutiveSummary(
  input: ExecSummaryInput,
  runner: ExecLlmRunner,
): Promise<ExecutiveSummary | null> {
  // 短 id 替代长 url（2026-09-15 Token 优化）：payload 只带 id（省下每条 ~80 字符的 url），
  // 响应按 id 回填、代码解析回真实 url。url 仍是唯一真源（由 input 提供，模型不得编造）。
  const idToUrl = new Map<string, string>();
  /** id → 该条目的相对日（A3 时间表述自检用；不写回 exec，只是审计线索）。 */
  const whenById = new Map<string, string>();
  const knownUrls = new Set<string>();
  for (const it of [...input.finance, ...input.gz, ...(input.ipo ?? [])]) {
    if (it.url) knownUrls.add(it.url);
  }
  /** id → url（仅接受本次 payload 里真实存在过的 id）。 */
  const urlById = (id: unknown): string | undefined =>
    typeof id === "string" && id ? idToUrl.get(id) : undefined;
  /** 仅接受「输入池中真实存在」的 url（防模型编造链接）。 */
  const knownUrl = (u: unknown): string | undefined =>
    typeof u === "string" && knownUrls.has(u) ? u : undefined;
  const enc = <
    T extends {
      title?: string;
      summary?: string;
      subcategory?: string;
      url?: string;
      when?: string;
    },
  >(
    items: T[],
    prefix: string,
    n: number,
  ) =>
    topByRelevance(items, n).map((it, i) => {
      const id = `${prefix}${i + 1}`;
      if (it.url) idToUrl.set(id, it.url);
      if (it.when) whenById.set(id, it.when);
      return {
        id,
        title: it.title ?? "",
        summary: it.summary ?? "",
        // 每条自带相对日（`昨天上午` / `今天凌晨` / `前天`）—— LLM 写时间表述的**唯一依据**。
        // 缺省（无法换算）表示「时间未标明」，此时**不得**给它安上「今天」。
        ...(it.when ? { when: it.when } : {}),
        ...(it.subcategory ? { subcategory: it.subcategory } : {}),
      };
    });

  const payload = {
    date: input.date,
    market_overview: input.marketOverview ?? "",
    finance: enc(input.finance, "f", 12),
    gz: enc(input.gz, "g", 12),
    ipo: enc(input.ipo ?? [], "i", 20),
    // B-1：关键词层 risk_tracker 已识别的风险候选，LLM 优先从这里选 1 条作为今日风险
    ...(input.riskCandidates && input.riskCandidates.length > 0
      ? { risk_candidates: input.riskCandidates }
      : {}),
  };
  const userPrompt = [
    RULES,
    // 内容记忆约束：近期播过什么、若必须再讲应换什么角度（去重机制的第一道闸）
    ...(input.memoryBrief ? [input.memoryBrief] : []),
    "",
    `当日信息（JSON）：`,
    JSON.stringify(payload),
    "",
    '请输出 {"hero_line":"...","spoken_hero":"...","spoken_insights":"...","must_read":[...],"insights":[...],"risk":{...} 或 null,"guangdong_ipo":{...} 或 null}，hero_line 1 句（≤70 字，维度 + 看点、不写整句理由、不复述事件）、must_read 8-10 条（title 自带结论或量级）、insights 10-12 条；spoken_hero（≤70 字、维度 + 看点）与 spoken_insights（按客群归并 3-4 条、≤260 字、不念商户名）与 guangdong_ipo.spoken 为纯口语文本（不要输出 spoken_must_read / spoken_risk）；must_read / insights.sources / risk.sources 的 id 必须从输入条目原样回填，不得编造，也不要输出 url。',
  ].join("\n");
  try {
    const text = await runner(SYSTEM_PROMPT, userPrompt);
    // 2026-09-05 可观测性：exec 曾「成功但空壳」（must_read/insights 全空）且无任何日志。
    // 打原始响应长度+头部片段，区分「200 空响应」「残缺 JSON」「内容空壳」三类失败。
    console.log(`[exec-llm] 原始响应 ${text.length} 字符 | 头部: ${text.slice(0, 260).replace(/\s+/g, " ")}`);
    const cleaned = extractJson(text);
    let parsed: ExecutiveSummary;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // jsonrepair 仍失败会抛给外层 catch（统一打日志），不再静默 return null
      const jsonrepair = (await import("jsonrepair")).jsonrepair;
      parsed = JSON.parse(jsonrepair(cleaned));
      console.log(`[exec-llm] jsonrepair 修复后解析成功（cleaned ${cleaned.length} 字符）`);
    }
    if (!Array.isArray(parsed.must_read) || !Array.isArray(parsed.insights)) {
      console.warn(
        `[exec-llm] 结构校验失败: must_read=${Array.isArray(parsed.must_read)} insights=${Array.isArray(parsed.insights)} | parsed keys=${Object.keys(parsed as object).join(",")}`,
      );
      return null;
    }
    // 源链接回链：AI 可能漏回 url，用输入 finance/gz 的 url 按标题回匹配注入（更稳，不依赖 LLM 吐 url）
    const normTitle = (t: string) =>
      t.replace(/\s+/g, "").replace(/[，。、：:；;！!？?""'']/g, "").toLowerCase();
    const urlByNorm = new Map<string, string>();
    for (const it of [...input.finance, ...input.gz]) {
      if (it.url) urlByNorm.set(normTitle(it.title), it.url);
    }
    const resolveUrl = (title: string): string | undefined => {
      const k = normTitle(title);
      if (urlByNorm.has(k)) return urlByNorm.get(k);
      for (const [ik, iu] of urlByNorm) {
        if (ik.includes(k) || k.includes(ik)) return iu;
      }
      return undefined;
    };
    // M 层：风险解析（risk 可为 null；source 限定 T1/T1.5/T2；sources 同 insights 相似度回链）
    const rawRisk = parsed.risk;
    const risk: ExecRisk | undefined =
      rawRisk && typeof rawRisk === "object" && typeof rawRisk.topic === "string" && rawRisk.topic.trim()
        ? (() => {
            const r = rawRisk as unknown as Record<string, unknown>;
            const explicit = Array.isArray(r.sources) && (r.sources as unknown[]).length > 0
              ? (r.sources as Array<{ title?: string; url?: string; id?: string }>)
                  .slice(0, 3)
                  .map((s) => {
                    const url = urlById(s?.id) ?? knownUrl(s?.url);
                    return url ? { title: s.title || "", url } : undefined;
                  })
                  .filter((s): s is { title: string; url: string } => Boolean(s))
              : [];
            const sources = explicit.length > 0
              ? explicit
              : resolveInsightSources(
                  String(r.topic),
                  String(r.evidence ?? ""),
                  String(r.impact ?? ""),
                  [...input.finance, ...input.gz],
                );
            return {
              topic: String(r.topic),
              evidence: typeof r.evidence === "string" ? r.evidence : "",
              impact: typeof r.impact === "string" ? r.impact : "",
              action: typeof r.action === "string" ? r.action : "",
              ...(typeof r.url === "string" && r.url ? { url: r.url } : {}),
              ...(r.source === "T1" || r.source === "T1.5" || r.source === "T2" ? { source: r.source } : {}),
              ...(sources.length > 0 ? { sources } : {}),
            };
          })()
        : undefined;
    console.log(
      `[exec-llm] parsed 盘点: must_read=${parsed.must_read.length} insights=${parsed.insights.length} hero=${typeof parsed.hero_line === "string" && parsed.hero_line ? 1 : 0} spoken_hero=${typeof parsed.spoken_hero === "string" && parsed.spoken_hero.trim() ? 1 : 0} spoken_must=${typeof parsed.spoken_must_read === "string" && parsed.spoken_must_read.trim() ? 1 : 0} spoken_ins=${typeof parsed.spoken_insights === "string" && parsed.spoken_insights.trim() ? 1 : 0} risk=${parsed.risk && typeof parsed.risk === "object" && typeof (parsed.risk as { topic?: unknown }).topic === "string" ? 1 : 0} spoken_risk=${typeof parsed.spoken_risk === "string" && parsed.spoken_risk.trim() ? 1 : 0} gd_ipo=${parsed.guangdong_ipo && typeof parsed.guangdong_ipo === "object" ? 1 : 0}`,
    );
    // A3 时间表述自检（2026-09-28 sc 口径）：只告警、不改写 —— 判定错源就会改错事实，
    // 风险高于收益（见 deliverables/time-accuracy-2026-09-28）。让跑偏在 CI 日志可见。
    const timeAudit = auditTimeWording([
      ...parsed.must_read.map((m) => ({
        text: `${m.title ?? ""} ${m.why ?? ""}`,
        when: whenById.get(String((m as { id?: unknown }).id ?? "")),
      })),
      ...parsed.insights.map((it) => {
        const first = Array.isArray(it.sources) ? it.sources[0] : undefined;
        return {
          text: `${it.topic ?? ""} ${it.impact ?? ""} ${it.action ?? ""}`,
          when: first ? whenById.get(String((first as { id?: unknown }).id ?? "")) : undefined,
        };
      }),
    ]);
    if (timeAudit.length) {
      console.warn(
        `::warning:: 时间表述与条目实际时间不符 ${timeAudit.length} 处（条目实际为「${timeAudit
          .map((a) => a.when)
          .join(" / ")}」，正文却写了「今天」）：${timeAudit.map((a) => a.text).join(" || ")}`,
      );
    }
    // 商机口播覆盖自检（2026-09-30 sc 口径）：听众是**先听后找** —— 口播念到的组名/主题
    // 必须能在页面上找到，页面上的每条商机也必须被口播覆盖。只告警、不改写（同时间自检策略）。
    const insAudit = auditSpokenInsightsCoverage({
      insights: parsed.insights,
      spokenInsights: parsed.spoken_insights,
    });
    if (insAudit.unknownGroups.length || insAudit.uncoveredTopics.length) {
      console.warn(
        `::warning:: 商机口播与卡面不同源 —— 口播念了页面没有的组名「${
          insAudit.unknownGroups.join(" / ") || "无"
        }」；卡面有但口播未覆盖「${insAudit.uncoveredTopics.join(" / ") || "无"}」`,
      );
    }
    return {
      hero_line: typeof parsed.hero_line === "string" ? parsed.hero_line : "",
      spoken_hero: typeof parsed.spoken_hero === "string" && parsed.spoken_hero.trim() ? parsed.spoken_hero.trim() : undefined,
      // 候选池（不再截断到 5）：多留出候补，供下游去重命中时顺延取用
      must_read: parsed.must_read.slice(0, MUST_READ_CANDIDATE_POOL).map((m) => ({
        title: m.title,
        why: m.why,
        // id 优先（新格式）→ 旧格式 url（白名单校验）→ 按标题回链
        url: urlById((m as { id?: unknown }).id) ?? knownUrl(m.url) ?? resolveUrl(m.title),
      })),
      spoken_must_read: typeof parsed.spoken_must_read === "string" && parsed.spoken_must_read.trim() ? parsed.spoken_must_read.trim() : undefined,
      insights: parsed.insights.slice(0, INSIGHT_CANDIDATE_POOL).map((it) => {
        // sources：优先用 LLM 显式引源；否则用生成时看到的 inputs（finance+gz，含真实 URL）
        // 按相似度回链 1-3 条来源，保证「商机洞察」卡片有可信溯源入口（不依赖 LLM 吐 url 格式）。
        const explicit = Array.isArray(it.sources) && it.sources.length > 0
          ? it.sources
              .slice(0, 3)
              .map((s: { title?: string; url?: string; id?: string }) => {
                const url = urlById(s?.id) ?? knownUrl(s?.url);
                return url ? { title: s.title || "", url } : undefined;
              })
              .filter((s): s is { title: string; url: string } => Boolean(s))
          : [];
        const sources = explicit.length > 0 ? explicit : resolveInsightSources(it.topic, it.impact, it.action, [...input.finance, ...input.gz]);
        return {
          topic: it.topic,
          impact: it.impact,
          action: it.action,
          ...(Array.isArray(it.tag) && it.tag.length > 0 ? { tag: it.tag.slice(0, 2) } : {}),
          ...(Array.isArray(it.segments) && it.segments.length > 0 ? { segments: it.segments } : {}),
          // 2026-09-30 sc 口径（标签同源）：方向名原样落地 → 卡面 chip 与口播组名读同一串字。
          ...(typeof it.group === "string" && it.group.trim() ? { group: it.group.trim() } : {}),
          ...(sources.length > 0 ? { sources } : {}),
        };
      }),
      spoken_insights: typeof parsed.spoken_insights === "string" && parsed.spoken_insights.trim() ? parsed.spoken_insights.trim() : undefined,
      risk,
      spoken_risk:
        typeof parsed.spoken_risk === "string" && parsed.spoken_risk.trim()
          ? parsed.spoken_risk.trim()
          : undefined,
      guangdong_ipo:
        parsed.guangdong_ipo && typeof parsed.guangdong_ipo === "object" && typeof parsed.guangdong_ipo.spoken === "string" && parsed.guangdong_ipo.spoken.trim()
          ? { spoken: parsed.guangdong_ipo.spoken.trim() }
          : null,
    };
  } catch (e) {
    // 2026-09-05：此前静默 return null，CI 无法区分失败原因。打日志后行为不变（仍返回 null）。
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[exec-llm] 生成失败（返回 null，将触发评分兜底）: ${msg.slice(0, 200)}`);
    return null;
  }
}



/**
 * 解析当日执行摘要来源（2026-08-19 修正 SKIP_AI；2026-08-20 持久化源扩展；
 * 2026-08-20 新增 forceRegen 开关）。
 * - SKIP_AI：仅复用持久化资产（history/<date>/store.json 优先，其次
 *   data/ai-assets 的 daily:<date>.executive），绝不调 LLM，与 README 一致。
 * - forceRegen：忽略已存在归档，强制调 generate（覆盖写），用于手动重新生成。
 *   仅在非 SKIP_AI 模式有意义（SKIP_AI 下忽略，避免无 LLM 却想重算）。
 * - 正常（无 forceRegen）：优先复用持久化，缺失才回退 generate。
 * 纯函数，便于单测；daily.ts 调用。
 */
/**
 * 把一条分行相关性评分「翻译」成必读卡可展示的 why（客户中心视角）。
 * 导出供内容记忆层的兜底补位复用（lib/memory/exec-guard.ts），保持文案口径一致。
 */
export function synthMustReadWhy(rel: BranchRelevance): string {
  const lines = rel.businessLines.join("/");
  const head =
    rel.authority >= 0.95 ? "国家核心监管新政" : rel.authority >= 0.8 ? "监管/地方级信号" : "市场信号";
  const tail = rel.override ? "建议分行评估对客与产品影响" : `直击${lines}业务`;
  return `${head}（${lines}）：${tail}`.slice(0, 60);
}

/** 商机口播覆盖自检结果（2026-09-30 sc 口径）。 */
export interface SpokenInsightsAudit {
  /** 口播念了、但不在「卡面可见标签」集合里的组名 —— 听众照这四个字去页面找，找不到。 */
  unknownGroups: string[];
  /** 卡面有、口播完全没提到的商机 topic —— 听了却不知道页面有这条。 */
  uncoveredTopics: string[];
}

/** 口播分组名抽取：`{方向名}方面，`。 */
const SPOKEN_GROUP_RE = /([^，,。；;：:\s]{2,10})方面/g;
/** topic 覆盖判定的共享 bigram 门槛（与回链溯源同一套 bigram，口径一致）。 */
const COVER_SHARED_BIGRAMS = 3;

/**
 * 商机口播覆盖自检（2026-09-30 sc 口径：「先听后找」闭环）。
 *
 * 为什么需要：听众在车里**先听**，到办公室**再找**。口播按方向名归并时 LLM 会自拟组名
 * （如「本地消费场景」），若卡面 chip 没有这四个字，他就找不到入口；反过来卡面有的条目
 * 口播没念，他也不知道页面有。**2026-09-30 实测两类问题同时出现**：口播多讲了 3 件卡面
 * 没有的事（理财费率下调 / 新基金定档 / 黄金ETF），同时漏讲了卡面 2 条。
 *
 * 判定（零 LLM、纯函数）：
 *  - `unknownGroups`：`{X}方面` 里出现的 X 不在「卡面可见标签」集合
 *    （各条 `group` ∪ `segments` 原值 ∪ 口播短名 `segSpeak` ∪ 两个兜底名）；
 *  - `uncoveredTopics`：卡面每条的 `topic` 与口播各子句的共享 bigram < 3（即没被提到）。
 *
 * ⚠️ 只告警、**绝不自动改写** —— 与 `auditTimeWording` 同策略：判定错源就会改错事实。
 */
export function auditSpokenInsightsCoverage(input: {
  insights?: Array<{ topic?: string; group?: string; segments?: string[] }>;
  spokenInsights?: string;
}): SpokenInsightsAudit {
  const spoken = (input.spokenInsights ?? "").trim();
  const items = (input.insights ?? []).filter((it) => (it.topic ?? "").trim());
  if (!spoken || items.length === 0) return { unknownGroups: [], uncoveredTopics: [] };
  const norm = (s: string): string => s.replace(/[^\p{L}\p{N}]+/gu, "");

  // 「卡面可见标签」：与 exec-block 的 chip 文案、speech-lines 的 label 同一集合。
  const known = new Set<string>([INSIGHT_OTHER_GROUP, OTHER_SEGMENT]);
  for (const it of items) {
    const g = (it.group ?? "").trim();
    if (g) known.add(g);
    const seg = (it.segments ?? [])[0];
    if (seg) {
      known.add(seg);
      known.add(segSpeak(seg));
    }
  }

  const unknownGroups: string[] = [];
  for (const m of spoken.matchAll(SPOKEN_GROUP_RE)) {
    const name = (m[1] ?? "").trim();
    if (name && !known.has(name) && !unknownGroups.includes(name)) unknownGroups.push(name);
  }

  const clauses = spoken
    .split(/[。；;]/)
    .map((c) => norm(c))
    .filter((c) => c.length > 0);
  const uncoveredTopics: string[] = [];
  for (const it of items) {
    const topic = norm((it.topic ?? "").trim());
    if (!topic) continue;
    const covered = clauses.some((c) => sharedBigramCount(c, topic) >= COVER_SHARED_BIGRAMS);
    if (!covered) uncoveredTopics.push((it.topic ?? "").trim());
  }
  return { unknownGroups, uncoveredTopics };
}

/**
 * A3 时间表述自检（2026-09-28 sc 口径）。
 *
 * 判据：正文出现「今天 / 今日」，而该条目自带的相对日 `when` 不是「今天」→ 记一条违规。
 * - `when` 缺省 → **不告警**（时间未标明，无从判定；prompt 已要求此时不得安相对日）；
 * - `when` 以「今天」开头（今天 / 今天凌晨 / 今天一早）→ 合规。
 *
 * ⚠️ 只告警、**绝不自动改写** —— 源判定错一步就会把事实改错，风险远高于「LLM 偶尔写错时间」。
 */
export function auditTimeWording(
  entries: Array<{ text: string; when?: string }>,
): Array<{ when: string; text: string }> {
  const out: Array<{ when: string; text: string }> = [];
  for (const e of entries) {
    if (!e.when || e.when.startsWith("今天")) continue;
    if (!/今天|今日/.test(e.text)) continue;
    out.push({ when: e.when, text: e.text.trim().slice(0, 44) });
  }
  return out;
}

/* ───────── 今日定调：兜底「维度提纲」（2026-09-28 sc 口径） ───────── */

/** 兜底提纲最多归纳几个维度。 */
export const HERO_DERIVE_MAX_LINES = 5;
/** 提纲整体字数上限（含标点）；超长则先砍掉最后一个维度再试。 */
export const HERO_DERIVE_MAX_CHARS = 70;

const HERO_CN_NUM = ["", "一", "两", "三", "四", "五"] as const;

/** 把选出的维度渲染成一句提纲（句式与 LLM 的 §0 口径同构）。 */
function renderHeroDerived(heads: string[]): string {
  if (heads.length === 0) return "";
  return `今天主要看${HERO_CN_NUM[heads.length]}个方面：${heads.join("、")}。`;
}

/**
 * 今日定调兜底：由**本次报告自身**的必读 + 商机确定性归纳一句「维度提纲」。
 *
 * 为什么需要：定调是「今天主要看哪几个方面」的**纲**（2026-09-28 sc 口径）—— 读者看它
 * 就该知道接下来必读/商机要重点看哪几块。所以「LLM 定调判重命中」后的兜底
 * **不能从两天池另挑一条事件顶上**（旧实现实证 09-27 把「河南省首笔取水权质押贷款落地信阳」
 * 顶成定调：既是不相干的外省琐闻，又与当天必读/商机毫无关系），而应回到**本次报告已定稿的
 * 内容**里做归纳。
 *
 * 素材与口径（不新造内容、不写理由）：
 *  - 维度 head 取 `must_read.title` / `insights.topic`（都 ≤15 字，本身即方向词组）；
 *  - **不取 why / impact 作理由**（2026-09-28 口径：定调只列维度 + 看点，完整理由留给必读）；
 *    兜底路径下 title/topic 自带量级（如「公募基金规模达39.63万亿」），信息量不缺；
 *  - 交错取用（必读 1 → 商机 1 → 必读 2 …），去重，最多 5 条，整句 ≤70 字；
 *  - 句式与 LLM 的 §0 口径同构 → 两条路径产出的定调风格一致。
 *
 * ⚠️ 只用于「LLM 定调被判重」的兜底分支；LLM 正常产出的 hero_line 一字不改。
 * @returns 空串 = 无素材可归纳（调用方据此保留原定调，守住「定调永不空」红线）
 */
export function deriveHeroLine(input: {
  must_read?: Array<{ title?: string; why?: string }>;
  insights?: Array<{ topic?: string; impact?: string }>;
}): string {
  const mr = (input.must_read ?? []).filter((m) => (m.title ?? "").trim());
  const ins = (input.insights ?? []).filter((it) => (it.topic ?? "").trim());
  const heads: string[] = [];
  for (let i = 0; i < Math.max(mr.length, ins.length); i++) {
    for (const head of [mr[i]?.title, ins[i]?.topic]) {
      const h = (head ?? "").trim();
      if (!h || heads.length >= HERO_DERIVE_MAX_LINES) continue;
      if (heads.includes(h)) continue;
      heads.push(h);
    }
  }
  while (heads.length > 0) {
    const text = renderHeroDerived(heads);
    if (text.length <= HERO_DERIVE_MAX_CHARS || heads.length === 1) return text;
    heads.pop(); // 超长 → 先砍最后一个维度，再试
  }
  return "";
}

/**
 * 评分层兜底生成器（SKIP_AI 无 store.json 时调用）。
 *
 * 关键价值：让「客户中心」在零 LLM 下也是结构化的——按分行相关性
 * 确定性选出 top 必读/商机/风险，报告永不空、且房贷40年这类硬规则条目
 * 必然置顶。与 LLM 路径产物同形（ExecutiveSummary），下游 mergeStoredExecutive 直接消费。
 */

/** 显著关键词（金融实体/数字/政策动作）——用于兜底去重「同事件不同措辞」的报道 */
const SALIENT_KW = [
  "房贷", "按揭", "住房", "期限", "40年", "30年", "信托", "罚", "处罚", "违规",
  "消费贷", "贴息", "LPR", "降息", "降准", "私行", "理财", "黄金", "外汇", "REITs",
  "IPO", "上市", "科创", "湾区", "广州", "广东",
];

/**
 * 零售核心条线（行长 5 分钟视角）：必读与商机都先按条线均衡各取 1 条。
 * 用户 2026-08-29 拍板：客群 / 财富 / 私行 / 信贷（含住房金融）应各有一条出现在
 * 必读和商机——除非该条线确实没有达标内容（有阈值把关，不硬凑）。
 */
const BALANCED_LINES = ["财富", "私行", "客群", "信贷"];

/**
 * 「均衡优先 + 按重要性补位」选取（2026-08-29 用户拍板）：
 *   轮次一：核心条线各取 1 条**已达标**（调用方按 tier 过滤过）的条目 → 保证条线均衡；
 *   轮次二：剩余名额按相关性分数（重要性）补齐 → 保证重要信号不被埋。
 * 另做「同事件去重」：共享 ≥2 个显著关键词的报道视为同一事件，只留最相关一条
 * （比字面 Dice 更能识别「同事件不同措辞」，如房贷40年的多个变体）。
 */
function balancedPick(
  ranked: Array<{ article: ScorableArticle; relevance: BranchRelevance }>,
  limit: number,
): Array<{ article: ScorableArticle; relevance: BranchRelevance }> {
  // 同事件去重
  const seenSigs: string[][] = [];
  const kept: Array<{ article: ScorableArticle; relevance: BranchRelevance }> = [];
  for (const r of ranked) {
    const sig = SALIENT_KW.filter((k) => r.article.title.includes(k));
    if (seenSigs.some((s) => s.filter((k) => sig.includes(k)).length >= 2)) continue;
    seenSigs.push(sig);
    kept.push(r);
  }
  const picked: Array<{ article: ScorableArticle; relevance: BranchRelevance }> = [];
  // 轮次一：核心条线各取 1 条。该条线有 must_read 档就用它，没有才退到 insight 档
  // （保证「有达标内容就先给一条」，不会因某条线整体分数偏低而轮空）。
  for (const line of BALANCED_LINES) {
    if (picked.length >= limit) break;
    const cand =
      kept.find(
        (r) =>
          !picked.includes(r) &&
          r.relevance.tier === "must_read" &&
          r.relevance.businessLines.includes(line),
      ) ??
      kept.find(
        (r) =>
          !picked.includes(r) &&
          r.relevance.tier === "insight" &&
          r.relevance.businessLines.includes(line),
      );
    if (cand) picked.push(cand);
  }
  // 轮次二：先补齐「尚未覆盖」的核心条线（避免被单一高分条线挤掉），
  // 再按分数（重要性）补满剩余名额——must_read 档优先，再 insight 档。
  const covered = new Set(picked.flatMap((r) => r.relevance.businessLines));
  const rest = kept.filter((r) => !picked.includes(r));
  for (const line of BALANCED_LINES) {
    if (picked.length >= limit) break;
    if (covered.has(line)) continue;
    const cand =
      rest.find(
        (r) =>
          !picked.includes(r) &&
          r.relevance.tier === "must_read" &&
          r.relevance.businessLines.includes(line),
      ) ??
      rest.find((r) => !picked.includes(r) && r.relevance.businessLines.includes(line));
    if (cand) picked.push(cand);
  }
  const restMust = rest.filter(
    (r) => !picked.includes(r) && r.relevance.tier === "must_read",
  );
  const restOther = rest.filter(
    (r) => !picked.includes(r) && r.relevance.tier !== "must_read",
  );
  for (const r of [...restMust, ...restOther]) {
    if (picked.length >= limit) break;
    picked.push(r);
  }
  return picked;
}

export function buildExecutiveFromScores(
  articles: Array<{
    title?: string;
    category?: string;
    subcategory?: string;
    source?: string;
    sourceId?: string;
    summary?: string;
    url?: string;
    locale?: string;
  }>,
  _date: string,
): ExecutiveSummary {
  const pool: ScorableArticle[] = (articles ?? [])
    .filter((a) => a && a.title)
    .map((a) => ({
      title: a.title!,
      category: a.category,
      subcategory: a.subcategory,
      sourceId: a.sourceId ?? a.source,
      summary: a.summary,
      url: a.url,
      locale: a.locale,
    }));
  const ranked = rankByRelevance(pool);
  // 必读：从 must_read / insight 档里选（阈值把关：drop/context 档不进必读）。
  // 均衡优先：核心条线各取 1 条，再按重要性补齐（2026-08-29 用户拍板）。
  const mr = balancedPick(
    ranked.filter(
      (r) =>
        (r.relevance.tier === "must_read" || r.relevance.tier === "insight") &&
        // 外埠区域性银行只作参考 → 不占必读名额（2026-08-29 用户：无本地借鉴意义）
        !r.relevance.foreignRegional,
    ),
    5,
  );
  const must_read = mr.map((r) => ({
    title: r.article.title,
    why: synthMustReadWhy(r.relevance),
    ...(r.article.url ? { url: r.article.url } : {}),
  }));
  // 风险先定位：原则 3 要求风险与商机严格错开，同一事件不重复出现在两个板块。
  const rk = ranked.find((r) => r.relevance.vertical === "risk");
  // 商机：同样均衡优先；与必读、风险都错开（原则 3）。
  const mrSet = new Set(mr);
  const ins = balancedPick(
    ranked.filter(
      (r) =>
        !mrSet.has(r) &&
        r !== rk &&
        (r.relevance.tier === "insight" || r.relevance.tier === "must_read"),
    ),
    5,
  );
  const insights = ins.map((r) => ({
    topic: r.article.title.slice(0, 15),
    impact: `对广州分行${r.relevance.businessLines.join("/")}业务有潜在影响`,
    action: `建议分行关注${r.relevance.businessLines[0] ?? "相关"}动向并评估动作`,
    segments: mapSubcategoryToSegments(r.article.subcategory, r.article.title),
  }));
  const risk = rk
    ? {
        topic: rk.article.title.slice(0, 15),
        evidence: rk.article.title,
        impact: "对分行相关条线需关注合规与风险敞口",
        action: "建议对应条线评估并制定应对",
        ...(rk.article.url ? { url: rk.article.url } : {}),
      }
    : undefined;
  const top = ranked[0];
  // 卡面只放正文标题（不再加「今日分行焦点：」前缀，2026-09-27）：
  // 各消费端自加标签（页面「今日定调：」/ 企微「【今日定调】」/ 口播「先看今天的整体定调。」），
  // 生产者再加前缀会渲染成「今日定调：今日分行焦点：…」双标签。
  const hero_line = top ? top.article.title.slice(0, 26) : "";
  return {
    hero_line,
    must_read,
    insights,
    ...(risk ? { risk } : {}),
  };
}

/**
 * 评分护栏（AI 模式 LLM 生成后调用）。
 *
 * 作用：
 *  1) 按分行相关性对必读重排序——客户中心条目（房贷40年型）必然上浮；
 *  2) 强制把「硬规则」命中的池内文章顶入必读（若 LLM 漏选，杜绝被埋）。
 * 不改动 insights/risk/hero_line（那些是 LLM 的语义富化，护栏只管「排序与兜底置顶」）。
 */
export function applyRelevanceGuardrail(
  exec: ExecutiveSummary,
  articlePool: Array<{
    title?: string;
    category?: string;
    subcategory?: string;
    source?: string;
    sourceId?: string;
    summary?: string;
    url?: string;
    locale?: string;
  }>,
): ExecutiveSummary {
  if (!exec || !Array.isArray(exec.must_read)) return exec;
  const pool: ScorableArticle[] = (articlePool ?? [])
    .filter((a) => a && a.title)
    .map((a) => ({
      title: a.title!,
      category: a.category,
      subcategory: a.subcategory,
      sourceId: a.sourceId ?? a.source,
      summary: a.summary,
      url: a.url,
      locale: a.locale,
    }));

  // 1) 为每条必读打分（基于标题+why，无需 LLM 标签）
  const scored = exec.must_read.map((m) => ({
    m,
    rel: scoreBranchRelevance({ title: m.title, summary: m.why, url: m.url }),
  }));

  // 2) 强制把「硬规则」命中的池内文章顶入必读（若 LLM 漏选）
  const covered = new Set<string>();
  for (const s of scored) covered.add(s.m.url ?? s.m.title);
  const forced: Array<{ title: string; why: string; url?: string }> = [];
  for (const a of pool) {
    if (forced.length + scored.length >= MUST_READ_CANDIDATE_POOL) break;
    const rel = scoreBranchRelevance(a);
    if (
      rel.tier === "must_read" &&
      rel.override &&
      a.url &&
      !covered.has(a.url) &&
      !covered.has(a.title)
    ) {
      forced.push({ title: a.title, why: synthMustReadWhy(rel), url: a.url });
      covered.add(a.url);
      covered.add(a.title);
    }
  }

  // 3) 合并去重 + 按分行相关性降序重排
  const merged = [...forced, ...scored.map((s) => s.m)];
  const seen = new Set<string>();
  const dedup = merged.filter((m) => {
    const k = m.url ?? m.title;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const scoreOf = (m: { title: string; why?: string; url?: string }) =>
    scoreBranchRelevance({ title: m.title, summary: m.why, url: m.url }).score;
  dedup.sort((a, b) => scoreOf(b) - scoreOf(a));

  // 保留完整候选池（按关联度降序），截断到「播出目标」由下游 exec-guard 顺序判重时决定
  return { ...exec, must_read: dedup.slice(0, MUST_READ_CANDIDATE_POOL) };
}

export async function selectExecutiveSummary(opts: {
  skipAi: boolean;
  persisted: ExecutiveSummary | undefined;
  generate: () => Promise<ExecutiveSummary | null>;
  forceRegen?: boolean;
}): Promise<ExecutiveSummary | null> {
  if (opts.skipAi) return opts.persisted ?? null;
  if (opts.forceRegen) return await opts.generate();
  return opts.persisted ?? (await opts.generate());
}
