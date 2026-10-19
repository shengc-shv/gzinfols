/**
 * 高客前瞻·研报参考区（2026-10-19 sc 拍板：直接建模块，写不好可首页屏蔽）。
 *
 * 定位：**参考区**，不是主信息流。研报是「观点/打法」，日报主线是「今日事件」——
 * 混排会稀释事件叙事（且研报无地域/可行动性，评分天然低）。
 *
 * 2026-10-19 sc 二次口径：**入口即导航**。日报页只保留顶部入口卡（📐 研报解读），
 * 不再内嵌面板；内容统一在独立主页 `site/research.html`（build-site 5.8c 由本字段聚合）。
 *
 * 因此本数据：
 *  - 零 LLM（纯抓取 + 确定性过滤），不进漏斗评分、不进 exec 池、不进口播、不参与判重；
 *  - 由 `pipeline/side-outputs/side-research.ts` 旁路产出并随 report JSON 落盘；
 *  - `RESEARCH_PANEL=off` → 入口卡隐藏 + 主页不生成（数据仍抓取，便于随时恢复）。
 */
export interface ResearchPanelItem {
  /** 研报标题（已按零售银行关键词白名单过滤） */
  title: string;
  /** 详情页链接（infoCode 拼接，数据来自东财研报详情页） */
  url: string;
  /** 券商简称（orgSName） */
  org: string;
  /** 研究员（researcher，可能多人逗号分隔） */
  researchers?: string;
  /** 行业名（industryName） */
  industry?: string;
  /** 发布日期 YYYY-MM-DD（R6：无真实发布日期的研报在采集层即丢弃，不兜底） */
  publishedAt: string;
}

export interface ResearchPanel {
  items: ResearchPanelItem[];
  /** 原始 API 返回条数（过滤前，透明展示覆盖度） */
  scanned: number;
  /** 回溯窗口天数（含节假日抗性，当前 3） */
  windowDays: number;
  /** 抓取时刻（ISO，面板脚注） */
  capturedAt: string;
  /** 降级说明（源不可达等；仅进 JSON/日志，不渲染给读者） */
  note?: string;
}

/**
 * 研报台账条目（2026-10-19 sc 口径：主题与研报都是**独立 + 全量**，目录固定、每次并集更新）。
 *
 * 与 `ResearchPanelItem` 的区别：台账是**跨期累积**的，需要记住首次入库日
 * （用于「新」标记与缺口排查），且同一篇研报被连续多天的 3 天窗口重复捞到时只存一份。
 */
export interface ResearchLedgerItem extends ResearchPanelItem {
  /** 首次入库日（抓取日 YYYY-MM-DD，不是发布日期） */
  firstSeen: string;
}

/** 研报台账（`data/research-ledger.json`）——固定路径、全量累积、并集合并。 */
export interface ResearchLedger {
  version: number;
  /** 最近一次合并的抓取日（YYYY-MM-DD） */
  updatedAt: string;
  /** 按 publishedAt 降序 */
  items: ResearchLedgerItem[];
}
