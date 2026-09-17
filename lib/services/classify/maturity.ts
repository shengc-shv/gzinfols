/**
 * 商机成熟度判定（C2，2026-09-17）—— 「这条商机走到哪一步了」。
 *
 * ⚠️ 先说清定义边界：本模块判的是**公开信息的演进阶段**，不是行内跟进状态。
 * 「谁在跟、跟到哪、什么状态」属行内信息（E3），需脱敏与合规界定，本项目**不采**。
 * 所以这里的「落地」= 「公开信息显示已完成某个确定性动作」，不等于「我行已落地」。
 *
 * 为什么用确定性词表而不是让 LLM 写：成熟度必须**可核对**（读者能回原文验证）。
 * LLM 看不到行内状态，只能按文本猜，猜错会直接误导跟进动作 —— 而词表判定可以
 * 把命中的原词一并展示，读者一眼就知道「为什么说是推进阶段」。
 *
 * 三档（从高到低匹配，命中即定）：
 *   landed   落地 —— 已完成：开业 / 投产 / 上线 / 竣工 / 验收 / 交付 / 通航 / 封顶…
 *   progress 推进 —— 已进入程序：招标 / 中标 / 获批 / 立项 / 备案 / 受理 / 签约 / 开工…
 *   clue     线索 —— 其余（含所有未来时表述：拟 / 计划 / 预计 / 有望 / 筹备 / 意向…）
 *
 * ⚠️ 未来时降级（关键）：中文里「**拟**于明年开业」含「开业」但是规划态。
 * 故命中完成/程序词后，还要看该词**邻近窗口内**有没有未来时标记；有则视为未发生。
 */
import type { MaturityStage } from "../../contracts/report";

/**
 * 落地词（已完成确定性动作）。
 *
 * ⚠️ 两个选址坑（都踩过，勿踩回去）：
 * ① **不要「落地」二字本身** —— 它在媒体语境里常被借喻（「政策落地」≠ 项目落地）。
 * ② **中文没有词边界，2 字词极易跨词误配**。实测：「**量产**」在真实商机里命中的是
 *    「存**量产**品业绩基准分批调整」——「存/量/产/品」被跨词切成了「量产」，
 *    于是「理财信披」这种与制造业无关的条目被判成了「落地」。
 *    故此类高危短词一律**加前置否定断言**（存/库/批 等高频前缀），或直接不收。
 */
const LANDED_WORDS =
  /开业|投產|投产|上線|上线|竣工|驗收|验收|交付|通航|通車|通车|封顶|封頂|揭牌|掛牌|挂牌|试运行|試運行|首航|首店|落成|建成|(?<!存)(?<!库)(?<!批)量产|量產|开工投产|正式成立|登记成立|登記成立/;

/** 推进词（已进入程序但未完成）。 */
const PROGRESS_WORDS =
  /招标|招標|中标|中標|获批|獲批|批复|批復|核准|备案|備案|受理|立项|立項|签约|簽約|开工|動工|动工|启动|啟動|试点|試點|入选|入選|获准|獲准|增资|增資|注资|注資|申报|申報|报批|報批|过会|過會|注册生效|註冊生效|中标候选|中標候選|征求意见|公開招標|公开招标/;

/**
 * 未来时/规划态标记 —— 出现即说明「动作还没发生」。
 *
 * 例：「**拟**在广州建设华南总部并**计划**2027年开业」→ 命中「开业」但属规划，
 * 应判 clue 而非 landed。
 */
const FUTURE_MARKERS =
  /拟|擬|計劃|计划|規劃|规划|預計|预计|將于|将于|將在|将在|有望|籌備|筹备|意向|研究|探索|征求|徵求|草拟|草擬|目標|目标|爭取|争取|力争|力爭|谋|謀|预算|預算|预计于|待|推进前期|前期工作/;

/** 邻近窗口（字符）：判断完成词是否处在未来时语境里。 */
const CONTEXT_WINDOW = 14;

/**
 * 在文本里找第一个「**不处于未来时语境**」的命中词。
 *
 * @returns 命中的原词；全部命中都在未来时语境 → undefined
 */
function hitWithoutFuture(text: string, re: RegExp): string | undefined {
  const g = new RegExp(re.source, "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    const from = Math.max(0, m.index - CONTEXT_WINDOW);
    const to = Math.min(text.length, m.index + m[0].length + CONTEXT_WINDOW);
    const ctx = text.slice(from, to);
    if (!FUTURE_MARKERS.test(ctx)) return m[0];
    if (m.index === g.lastIndex) g.lastIndex++; // 空匹配保护
  }
  return undefined;
}

/** 判定结果：阶段 + 判定依据词（供展示，让读者能自行核对）。 */
export interface MaturityVerdict {
  stage: MaturityStage;
  evidence?: string;
}

/**
 * 从文本判成熟度。**保守优先**：判不准时落 clue（宁少不多 —— 把「线索」说成
 * 「落地」会让读者白跑一趟，反之只是少一条提示）。
 */
export function maturityOf(text: string): MaturityVerdict {
  const s = (text ?? "").trim();
  if (!s) return { stage: "clue" };
  const landed = hitWithoutFuture(s, LANDED_WORDS);
  if (landed) return { stage: "landed", evidence: landed };
  const progress = hitWithoutFuture(s, PROGRESS_WORDS);
  if (progress) return { stage: "progress", evidence: progress };
  return { stage: "clue" };
}

/** 阶段推进顺序（展示阶段条用；索引即进度）。 */
export const MATURITY_ORDER: readonly MaturityStage[] = ["clue", "progress", "landed"];

/** 阶段文案（渲染层与口播共用同一套，避免两处各写一套）。 */
export const MATURITY_LABEL: Record<MaturityStage, string> = {
  clue: "线索",
  progress: "推进",
  landed: "落地",
};

/** 阶段的解释文案（tooltip / 说明用）。 */
export const MATURITY_HINT: Record<MaturityStage, string> = {
  clue: "公开信息里只有规划/意向类信号，尚未见程序性动作",
  progress: "公开信息显示已进入程序（招标/获批/立项/签约/开工等），尚未见完成",
  landed: "公开信息显示已完成确定性动作（开业/投产/上线/竣工/交付等）",
};
