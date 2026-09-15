# 红筹抓取与推送方案（对齐国内 IPO · 面向研发）

> 目标：CI 流程中抓取到的**红筹信息**，其处理逻辑与**国内 IPO 信息完全一致**（口播持续 **2 天**、展示持续 **7 天**）；
> 在此基础上补三项差异化：① 口播加入**红筹线索提示**；② 展示卡片加**红筹线索标识**；③ 点击卡片进入**穿透分析报告（会前版本）**。
>
> 关联文档：`docs/plan-redchip-impl.md`（监测与展示页自建）、`docs/plan-red-integration.md`（红筹商机集成 R1–R5）、`docs/redchip.md`（使用说明）。
> 事实基线：`lib/contracts/redchip.ts`、`lib/services/redchip/{classify,diff}.ts`、`lib/adapters/redchip/*`、`scripts/redchip-monitor.ts`、`scripts/lib/redchip-page.mjs`、`scripts/build-site.mjs` §5.5。
>
> **本方案 LLM 消耗 = 0**（全部为确定性抓取、规则判定、模板渲染；不引入任何新的 LLM 调用）。

---

## 0. 一页速览

| 环节 | 窗口 | 展示形式 | 差异化 |
|---|---|---|---|
| **源层抓取** | 日差 ≤ **7**（同 `IPO_SOURCE_WINDOW_DAYS`） | 快照 `data/redchip/snapshots/<date>.json` | 港交所披露易 AP&PHIP + 申请版本 PDF |
| **卡片展示** | 日差 ≤ **7**（同 `IPO_LIST_WINDOW_DAYS`） | 「IPO 动态」列表卡片 + **红筹线索徽章** | 徽章 + 「→ 穿透分析报告」入口 |
| **今日必读横滑** | 日差 ≤ **2**（同 `IPO_VOICE_WINDOW_DAYS`） | 3 席横滑卡（与国内 IPO 同席，**不额外占额**） | 徽章沿用 + **排序提权** |
| **音频口播** | 日差 ≤ **2**，且 2 天内未念过同一企业 | 合并进 `ipo` 段（≤150 字，`AUDIO_SPEAK_LIMITS.ipo`） | 追加**红筹线索句**，**排在同段最前** |
| **穿透报告（会前版本）** | 与卡片同窗（7 天 / 线索生命周期内常驻） | `site/redchip/r/<leadId>.html` | **零 LLM、自动生成、100% 覆盖**，点击即开 |

**对齐原则（硬约束）**：不新建第二套窗口体系、不新建采集漏斗；红筹是「给已有 IPO 条目加一个维度 + 一份可点开的报告」。

---

## 1. 抓取层（CI）

| 项 | 规格 |
|---|---|
| 源 | 港交所披露易「新上市申請版本及相關資料」静态 JSON（`appactive_*` / `applisted_*`）+ 申请版本 PDF（**封面分册**，注册地句式所在） |
| 入口 | `scripts/redchip-monitor.ts`，由 `daily.yml` 步骤「红筹监测（抓取→判定→存储）」调用（紧随其后是「站点聚合」） |
| 执行频率 | **每次 CI 运行都跑**（不新增独立定时 workflow；失败 `continue-on-error`，不阻断发布） |
| 窗口口径 | **日差 ≤ 7（今天-7 ~ 今天，北京时间 REPORT_TZ）**，与三所审核 / 证监会辅导 / 港交所递表统一 |
| 时间红线 | 无明确递表日（`d`/`postingDate`）→ **该条目废弃**，不用抓取时间兜底 |
| 判定 | `红筹 = 境外注册（封面页句式 → 离岸法域） ∧ 广东运营实体词频 ≥ 3`；VIE 仅画像 |
| 去重主键 | `appId`（港交所申请编号） |
| 产出 | `snapshots/<date>.json`、`latest.json`、`changelog.jsonl`（运行时产物，**不入库**）；**`leads.json`（冻结快照，入库）** |

> ⚠️ **抓取日期口径**：按**本次 CI 运行的当日**（北京时间）抓取；`--date` 仅用于补跑。
> ⚠️ **不用 `gd_flag` 关联广东**（实测交集 0 条）——必须走「离岸正文通道」：`domicile ∈ 离岸法域 ∧ gdCityHits ≥ 3`。

### 1.1 红筹是怎么"识别"出来的（**全程零 LLM**）

识别红筹**不需要大模型**，是「PDF 文本抽取 + 正则 + 词频计数」的确定性链路（**已实现**）：

| 步 | 做什么 | 实现位置 |
|---|---|---|
| ① 抽文本 | 下载申请版本 PDF → 抽纯文本；失败或无文本层 → 空串 | `lib/adapters/redchip/pdf-text.ts`（`unpdf`，纯 JS，**非 LLM**） |
| ② 判境外注册 | 封面页固定句式正则 `COVER_DOMICILE_PATTERNS`（如 `Incorporated in (the )?X with limited liability`）抽出注册地 → 比对 `OFFSHORE_JURISDICTIONS`（开曼 / 百慕大 / BVI…） | `lib/services/redchip/classify.ts` |
| ③ 判广东连接 | 对 `GD_CITIES`（20 个粤城市中英文词）逐词计数 → `gdCityHits ≥ GD_CITY_HIT_THRESHOLD(3)` | 同上 |
| ④ 合取判定 | `isOffshore ∧ isGdConnected → verdict = "redchip"`；抽不到文本 → `unverified`（宁缺毋滥） | 同上 |

VIE 仅 `VIE_KEYWORDS` 关键词命中（`current/historical/none/unverified`），**只画像、不参与判定**。

**"识别"与"分析"要分清——三件事的 LLM 消耗不同**：

| 事项 | 手段 | LLM 消耗 |
|---|---|---|
| **识别红筹（判定）** | PDF 文本抽取 + 固定句式正则 + 词频/词表计数 | **0** |
| **会前版本穿透报告** | 把上述抽出的字段套进 HTML 模板 | **0** |
| **深度研判**（架构解读 / 结论 / 边缘案例人工核验） | 人工撰写；**如需**可选调 LLM | 仅此项；**人工触发**，不在本方案自动链路内 |

> 扫描版 PDF（无文本层）→ 正则无能为力，只能标 `unverified`；可选人工/LLM 辅助，**默认不做**。

**⚠️ 实测告警（2026-09-15）：③ 的词频阈值被噪音淹没，必须加「语义归属」层——但**仍不需要 LLM**。**

对 108870 全册实抽（433 页 / 130.3 万字符）：`countGdCityHits = 127`（`shenzhen=94`、`zhuhai=17`、`dongguan=14`、`guangzhou=1`、`huizhou=1`）。按句子语境归类后：

| 语境 | 命中次数 | 例子（原文） |
|---|---|---|
| 「我们的子公司 / 运营实体」 | **10** | `we operated two manufacturing facilities … located in Dongguan, Guangdong Province`；`We are headquartered in Shenzhen, China.` |
| 「董事 / 高管住址」 | **31** | `Unit 1203, Block E … Bao'an District Shenzhen Guangdong Province PRC Chinese Mr.` |
| 其他（股东表 / 风险因素 / 中介…） | 86 | `It is a subsidiary of a company listed on the **Shenzhen Stock Exchange**.` ← 「深圳」来自**深交所**，纯噪音 |

**后果（这是判定链最严重的缺陷）**：任何一本招股书都必然命中几十次（董事住址 + 中介地址 + 交易所名），`gdCityHits ≥ 3` **恒成立** → 判定实际退化为「**只看注册地是否离岸**」→ **离岸公司一律被判 `redchip`（系统性假阳性）**。两条实网样本的词频 127 / 338 都远超阈值 3，说明**阈值从未真正起作用**。

**✅ 修法已落地（2026-09-15，零 LLM、可解释、可测试）**：`countGdCityHits` 现为**三层过滤**——

1. **交易所名称掩码**：`Shenzhen/Shanghai/Hong Kong … Stock Exchange`、`深交所/港交所/聯交所` → 先剔除，避免「深交所」被当成深圳；
2. **句子级「集团实体语境」**：只统计带**所属表达**的句子（`our (principal/PRC/wholly-owned) subsidiar(y|ies)/operating entit/group/business/offices/headquarters/facilities…`、`we (operate|established|maintain|have|own|are headquartered…)`、`the Company/Group is headquartered…`、中文 `本集团/本公司/我们`）；**不放宽为裸词 `group`/`subsidiary`**（red 实测 `Guangzhou Finance Holding Group Co., Ltd.`、`It is a subsidiary of a company listed on…` 会误判）；
3. **邻近窗口**（前后各 160 字符）：城市词必须靠近所属表达才采信——表格转储会把 `Our Group` 与几百字符外的 `Guangdong Yangjiang` 塞进同一条「句子」。

**实网验收（同一批真实记录，修复前后对比）**：

| 记录 | 实际所在地 | 裸词频（修复前） | 实体语境（修复后） |
|---|---|---|---|
| 108870 Hai Robotics | 深圳 | 127 | **4** |
| 108867 Guangdong Mic-Power | 惠州（`our factory in Huizhou commenced operations`） | 338 | **9** |
| 108866 Hebei Lianji Qicheng (GEM) | 河北（仅"计划投资广东阳江"） | — | **0**（窗口过滤前为 4） |
| 108822 上海 / 108827 杭州 | 非广东 | — | **0 / 0** |

→ 噪音去掉 **92%~96%**，判定阈值 **3 因此真正生效**（真广东样本落在 4~9，非广东样本为 0，间隔清晰 → **阈值维持 3**）。
→ 裸提及计数保留为 `gdCityMentions`（供报告页展示「实体语境 N 次 / 全文提及 M 次」与人工复核）。
→ 残余风险：把「**计划投资**类」关联也算作连接（如上表 108866 若未设窗口即命中）；因判据定位是「线索·待核」且离岸是必要条件，实际影响可控。

### 1.2 ⚠️ 必须先修的前置短板（否则整条红筹链路空转）

#### 短板① 文档选取 —— **根因已实网确认**
- **现状**：`docUrlOf(r) = https://www1.hkexnews.hk/app/ + r.w` —— 直接下载 `w` 字段指向的 PDF。
- **实测（EDE 真实 JSON）**：`w` 指向的是**「警告聲明」单页 PDF**（如 `108870` → `sehk/2026/108870/documents/warn26091300121_c.pdf`，102KB，**1 页**），**根本不含注册地句式**。
- **正确取法**：申请版本在记录的 **`ls[]`** 里 ——
  `nF="申請版本（第一次呈交）"` ∧ `nS1="全文檔案"` → `u1`=全文 PDF（如 `sehk26091300123_c.pdf`，**433 页 / 6.47MB**）、`u2`=**多檔案索引 htm**（31 个分册：警告/重要提示/預期時間表/目錄/概要/釋義/…/公司資料/歷史發展及公司架構/財務資料…）。
  > 记忆里"~110KB 的封面分册"实际是那份**警告页**；体积吻合，但内容不含注册地 —— 该线索不成立。

#### 短板② 抓取窗口
**"抓昨天"会漏** —— 披露易发布有 1~2 天滞后（实测 `appactive` 最新 09-13、目标日 09-14 命中 0 条）。应改为「抓本次运行日 + 空结果回退到最近有数据的日期」，或「抓自上次快照以来的全部新增」。**不依赖 PDF，可先做。**

#### 短板③（更硬）申请版本 PDF 的**中文抽不出来** —— 阻塞判定口径
- **现象**：全文檔案与各分册的中文**全部变成 `[ ]`**（`業務` 分册实测 `广州/深圳/广东=0`），英文/数字正常。
- **已试 3 种办法，均无效**：① 不带 cMap；② 显式 CDN cMap（jsdelivr 6.3.289，可达 200）；③ 安装本地 `pdfjs-dist`（cmaps 就位；unpdf 内部 `cMapUrl: new URL("./cmaps/", <pdfjs-dist>)`）→ 输出**逐字节相同**，仍 `[ ]`。
- **反证**：`warn..._c.pdf`（1 页警告）**中文可正常抽取** → 差异在**字体**（申请版本用无 ToUnicode 的 CID/子集字体，cMap 救不回）。
- **后果**：判定口径 `注册地（「於XX註冊成立」中文句式） ∧ 广东城市词频 ≥3` 的**中文侧不可计算**；英文层可抽但稀疏（该分册 `Shenzhen/Guangzhou=0`）。**故短板①单独修好也判不出红筹。**
- **可选路线（待拍板）**：

| 路线 | 做法 | 评估 |
|---|---|---|
| A | 找**英文版**文档源（本record `_e` 与 `_e.htm` 均 404，需再查命名规律） | 英文抽取可用，但未验证存在性 |
| B | **换抽取栈**（`pdf-parse` / poppler `pdftotext` / `mupdf`） | 若 CID 确无 ToUnicode 则仍失败 → 只剩 OCR（重、CI 成本高） |
| C | 试其他分册（公司資料 / 歷史發展及公司架構） | 抽样验证；若同为 CID 字体则无效 |
| D | **降级为「名称预筛线索」路线**（回到 `plan-red-integration.md` 的 `redchip_l2` 思路，文案统一「红筹线索·待核」） | **当前技术栈下唯一确定可落地**；放弃全文词频判定 |

**✅ 路线已定：A（英文通道）—— 2026-09-15 已实现并实网验证**

参考项目 `red` 的做法（`red/src/redchip/overseas/hkex_cover.py` / `hkex_listing.py`）证实：
- red 同样撞上 CID 乱码，**解法就是不碰中文**：`shareholders.py` 注释原文「中文版 PDF 用 pypdf 提取会出现 CID 编码乱码，英文版提取完整」；`hkex_listing.py` 的 `_GD_CITIES` 收录**简/繁/拼音**三写法仅用于匹配，**没有繁→简转换实现**。
- red 两条低成本路径：① `scan_domicile_range`（HTTP Range 2MB → zlib 解压 → 只留字母 → 子串匹配）；② `fetch_multi_sections`（只下封面/重要提示等**小分册**，~100KB/1 页/~3s）。
- **本项目已落地（本轮）**：`hkex-client.ts` 改读**英文清单 `*_e.json`** + 从 `ls[]` 取 **Application Proof**（不用 `w`）；`classify.ts` 增加**紧凑化匹配**（只留字母→小写→子串，容忍词内插空格）并把中文句式降为窗口内兜底；`redchip-monitor.ts` 默认按**当次运行日**抓 + **空结果回退最近有数据日**。

> **优先级**：短板①②③**均高于展示/口播**。③ 未解决前，红筹标命中率≈0，展示与播报做得再好也无数据。

**实网验证（2026-09-15，英文通道修复后）**：

```
[redchip] 实网：总 1961 条，采信日期 2026-09-13 命中 1 条
  · 108870 Hai Robotics Innovation Group Co., Ltd. | 离岸=false | 广东词频=127 | 判定=non-redchip
  ·（另一批 4 条）Guangdong Mic-Power New Energy | 广东词频=338 | 判定=non-redchip
```

- **修复前**：广东词频只能从「警告页」的公司名里拿到 **1**，注册地恒判不出。
- **修复后**：英文全文（433 页 / 1.3M 字符）给出真实词频 **127 / 338**；注册地正确读作「中国(境内)」→ non-redchip（H 股，**判定正确**）。
- ⚠️ **纠错**：记忆里「海柔判成 non-redchip 是抽取失败导致」是**误诊**——该公司本身就是 PRC 注册（封面句 `incorporated in the People's Republic of China with limited liability`），判 non-redchip 本来就是对。真正失效的是词频与后续判定链。
- 离岸路径（开曼/百慕大 → `verdict=redchip`）由单测 ⑥ 覆盖；近期递表以 PRC 企业为主，实网暂未抽到离岸样本。

### 1.3 下载成本 vs 判定效果（2026-09-15 实网实测）

**问题**：red 的"省钱路径"（只下小分册 / Range+zlib 扫描）能替代全文下载吗？答案是：**判定效果可以 100% 替代，但本项目不值得接**。

样本：真实记录 2 条（均为 PRC 注册，故最终判定都是 `non-redchip`，判定一致率由阈值与注册地两条链路分别验证）。

| 路径 | 体积（108870 / 108867） | 占全文 | 广东词频 | 词频信号覆盖 | 判定 |
|---|---|---|---|---|---|
| **全文单文件**（本项目现状） | 7127KB / 3338KB | 100% | 127 / 338 | 100% | non-redchip |
| 全部 31 册分册合计 | 9722KB / 6626KB | — | **127 / 338** | 100% | — |
| **封面册 `WARNING` 单独** | 40KB / 50KB | **0.6% / 1.5%** | 0 / 0 | 0% | **注册地 2/2 正确** |
| `WARNING`+`CORPORATE INFORMATION`+`HISTORY` 三册 | 649KB / 493KB | **9.1% / 14.8%** | 55 / 153 | 43% / 45% | **一致** |
| red 五册并集（+`SUMMARY`/`RISK FACTORS`） | 1070KB / 983KB | 15.0% / 29.4% | 55 / 167 | 43% / 49% | 一致 |
| Range 2MB + zlib 解压扫描 | 2048KB | 28.7% / 61.4% | 不适用 | — | ⛔ **不可用** |

**四条关键结论**：

1. **判定效果 = 100%，成本可压到 9%~15%**：判定口径是「封面注册地 ∧ 广东词频 ≥ 3」。注册地由**封面册（40~50KB）独立且正确**给出；词频在三册路径下仍有 55 / 153（远超阈值 3）→ 两条样本判定与全文一致。
2. **分册合计词频 == 全文词频（127==127、338==338）**，证明分册内容与全文等价，口径无需两套。
3. **`BUSINESS` 册是纯浪费**：108870 的 `BUSINESS` 占 5649KB / 69 页（全册体积的 58%），却只贡献 **9** 个广东词（7%）——该册以图片为主。**砍掉它是省钱路径收益的全部来源。**
4. **耗时上没有优势**：全文 unpdf 抽取仅 3.3~5.4s（red 的 pypdf 需 30~60s，所以 red 才要省），而逐册下载的多次 `unpdf` 初始化开销会把省下的时间吃掉。**本项目的瓶颈不是体积。**

**⛔ Range 2MB + zlib 不可用于注册地判定**：解压后全文字母流中，法域名同时命中 2~3 个（如 108870 命中 `caymanislands`+`peoplesrepublicofchina`+`hongkong`）——正文里股东/中介的 "…incorporated in the Cayman Islands with limited liability" 是**合法句式命中**。red 靠"取最靠前的强命中"做启发式排序，但流顺序不保证等于页序，脆弱。

**结论与建议：暂不接省钱路径。** 收益是每条省 3~6MB 带宽（CI 无压力），代价是：多请求编排 + 分册名漂移（实测 `HISTORY, DEVELOPMENT AND…` vs `HISTORY AND CORPORATE STRUCTURE`；108867 甚至无 `BUSINESS` 册）+ 漏判风险（若某公司广东词只出现在 `BUSINESS`，三册路径会漏）。**保留"全文单文件"最简、最稳。**

> 若将来窗口条数显著增加（如日均数十条）需接：用 `WARNING`+`CORPORATE INFORMATION`+`HISTORY` 三册，并加「任一分册失败 → 回退全文」降级。
> ⚠️ **实现坑（本次踩到）**：分册链接形如 `a136045/xxx.pdf`，基准是**索引自身目录**（`u2` 所在目录），**不是**全文 PDF 所在目录（`…/documents/`）——用错会静默拿到 2KB 错误页、词频恒 0。


---

## 2. 数据字段

### 2.1 `RedchipLead`（线索级 · `lib/contracts/redchip.ts` 新增 · `leads.json` 入库）

由现有 `RedchipProject` 扩展（保留全部字段，追加下列）：

| 字段 | 类型 | 说明 | 卡片 | 口播 | 报告 |
|---|---|---|---|---|---|
| `leadId` | `string` | = `appId`，全链路唯一标识 | ● | ● | ● |
| `nameCn` / `nameEn` | `string` | 企业名（中/英） | ● | ● | ● |
| `board` | `string` | 拟上市板块原文 | ● | ● | ● |
| `stockCode?` | `string` | 股票代码（若已配） | ○ | ○ | ● |
| `status` | `string` | 港交所状态原文 | ● | ● | ● |
| `submitDate?` | `string` | 官方递表日 `YYYY-MM-DD`（窗口基准） | ● | ● | ● |
| `domicile?` / `isOffshore` | `string` / `boolean` | 注册地 / 是否离岸法域 | — | ● | ● |
| `gdCityHits` / `isGdConnected` | `number` / `boolean` | 广东城市词频 / 是否达标 | — | ● | ● |
| `vie` | `RedchipVie` | `current\|historical\|none\|unverified`（仅画像） | — | ○ | ● |
| `verdict` | `RedchipVerdict` | `redchip\|non-redchip\|unverified` | ● | ● | ● |
| `discoveredAt` | `string` | 首次入快照（北京时间 ISO） | — | ○ | ● |
| `lastChangedAt?` | `string` | 最近一次字段变更时间（来自 changelog） | ○ | ○ | ● |
| `sourceUrl?` | `string` | 申请版本 PDF 直链（回原文核对） | — | — | ● |
| `gdEvidence[]` | `{text,page?}[]` | 广东连接原文摘录（1–3 条，来自正文） | — | — | ● |
| `archNotes[]` | `string[]` | 架构要点（离岸地 / 持股路径 / VIE 安排） | — | — | ● |
| `reports[]` | `RedchipReportRef[]` | 可访问报告引用（见 2.3） | — | — | ● |

**运行时派生（不入库、不写盘）**：`inListWindow`（日差 ≤7）、`inVoiceWindow`（日差 ≤2）、`isNew`（本次 `added`）、`changedFields`（本次 `changed`）。

### 2.2 `ReportItem.redchip`（卡片级 · `lib/contracts/report.ts` 新增可选字段）

```ts
export interface RedchipBadge {
  leadId: string;                        // 港交所申请编号
  label: "红筹线索" | "红筹线索·待核";     // 展示文案（红线：线索≠结论，见 §3.1）
  verdict: RedchipVerdict;               // redchip | unverified | non-redchip
  isNew: boolean;                        // 本次 added → 角标「新」
  changedFields?: string[];              // 本次 changed 的字段标签（状态/注册地/VIE…）
  reportUrl?: string;                    // 站内相对路径：redchip/r/<leadId>.html
  reportKind?: "pre-meeting" | "deep" | "manual";
}

// ReportItem 追加（与 ipoStage/ipoCity 同层）
redchip?: RedchipBadge;
```

### 2.3 `RedchipReportRef`（报告引用 · 供 §5.3）

```ts
export interface RedchipReportRef {
  kind: "pre-meeting" | "deep" | "manual";  // 会前版本 / L1 深度 / L2 人工
  url: string;                               // 站内相对路径（如 redchip/r/108804.html）
  title: string;
  generatedAt: string;                       // 北京时间 ISO
}
```

### 2.4 窗口与权重常量（`lib/ipo-config.ts` 新增 · 单一真源）

**已拍板：独立起名（不与 IPO 常量共用标识符），数值默认与 IPO 一致。**

```ts
/** 红筹口播窗口（天，日差 ≤ N）——默认与 IPO 一致。 */
export const REDCHIP_VOICE_WINDOW_DAYS = 2;
/** 红筹卡片/报告展示窗口（天）——默认与 IPO 列表窗一致。 */
export const REDCHIP_LIST_WINDOW_DAYS = 7;
/**
 * 红筹播报优先权重（加到 BIZ_VALUE_RANK 上的提权值）。
 * 已拍板：红筹**不额外占名额**，但在同一候选池内**排序提权**（优先播报）。
 *   0 = 不提权（与普通 IPO 同序）
 *   2 = 稳健提权（默认）：红筹「在审」可越过非红筹「注册生效」
 *   ≥5 = 绝对优先（红筹排到所有非红筹之前）
 */
export const REDCHIP_VOICE_BOOST = 2;
```

> **为什么独立起名**：满足「数值保持一致」的同时保留差异化调参能力；
> 但**必须与 IPO 常量同文件、同风格单点定义**（历史教训：`IPO_VOICE_WINDOW_DAYS` 曾在两处重复定义 → 改一处不生效）。

---

## 3. 状态标记规则

### 3.1 判定档 → 徽章文案（红线「线索 ≠ 结论」）

**已拍板：文案统一用「线索」口径。**

| `verdict` | 徽章 | 样式 | 进卡片 | 进口播 | 生成报告 |
|---|---|---|---|---|---|
| `redchip`（离岸 ∧ 广东词频 ≥3，证据完整） | `红筹线索` | 红底白字 pill | ✅ | ✅（**排段首**） | ✅ |
| `unverified`（无 PDF 文本 / 证据不足） | `红筹线索·待核` | 灰底描边 pill | ✅ | ❌ | ✅（标注「待核」） |
| `non-redchip` | 不打徽章 | — | ❌ | ❌ | ❌（仅留红筹展示页变更历史） |

**证据完整**的定义：`domicile` 非空 ∧ `gdCityHits ≥ GD_CITY_HIT_THRESHOLD` ∧ `sourceUrl` 非空。

### 3.2 时间窗状态（决定展示 / 口播资格）

| 标记 | 判定 | 用途 |
|---|---|---|
| `inListWindow` | 日差(`submitDate`↓ 或 `discoveredAt`) ≤ **REDCHIP_LIST_WINDOW_DAYS(7)**，北京日历日 | 进「IPO 动态」列表卡片 |
| `inVoiceWindow` | 同上 ≤ **REDCHIP_VOICE_WINDOW_DAYS(2)** | 进横滑 + 口播 |
| `voicedRecently` | 同一企业在 `REDCHIP_VOICE_WINDOW_DAYS` 天滚动窗内已口播（对齐事件记忆 `ipoVoicing`） | 从口播名单剔除（**卡片不受影响**） |

> **回退口径（与 IPO 逐字对齐）**：`submitDate` 缺失时以 `discoveredAt`（首见）为准；两者都缺 → 不进任何窗口（项目时间红线）。
> **日差口径**＝「今天-N ~ 今天」（不是「含今天共 N 个日历日」），与 `IPO_LIST_WINDOW_DAYS` 的 2026-09-10 实锤一致。

### 3.3 变更状态（`changelog.jsonl` → 卡片/口播标记）

| `type` | 触发 | 卡片标记 | 口播提示 |
|---|---|---|---|
| `added` | 快照新增该 `appId` | 右上角**「新」**角标 + 徽章 | 前缀「新增红筹线索」 |
| `changed` | `WATCHED_FIELDS` 变更（状态 / 注册地 / 境外注册 / 广东词频 / 广东连接 / VIE / 判定） | 徽章后追加 `↑状态` 小字 | 「红筹线索有更新：<字段> <from> → <to>」 |
| `removed` | 本次快照中消失（撤表 / 已上市归档） | **不进今日卡片**（仅进变更历史与本报告页） | 不播 |

### 3.4 触发条件（Trigger Matrix）

| # | 触发 | 条件（全部满足） | 结果 |
|---|---|---|---|
| T1 | 生成线索 | CI 抓取命中窗口 ∧ `appId` 非空 ∧ 有明确递表日 | 写 `leads.json` + 快照 |
| T2 | 卡片展示 | `inListWindow` ∧ `verdict ≠ non-redchip` ∧ 实体匹配到 IPO 条目 | 卡片挂 `item.redchip` 徽章 |
| T3 | 横滑 / 口播 | `inVoiceWindow` ∧ `verdict = redchip` ∧ `¬voicedRecently` | 口播追加红筹线索句（**排 `ipo` 段最前**）+ 写回 `ipoVoicing` |
| T4 | **排序提权** | `item.redchip` 存在（T2 命中） | 候选池排序键 `+ REDCHIP_VOICE_BOOST`（**不占额外名额**，仅前移） |
| T5 | 生成会前版本报告 | `verdict ≠ non-redchip` ∧ `leadId` 非空 | 生成 `site/redchip/r/<leadId>.html`（**自动、零 LLM、覆盖 100%**） |
| T6 | 升级深度版 | 存在 `site/redchip/deep/<leadId>.html` 或 `manual/<leadId>.html` | 卡片/报告页入口**优先指向深度版** |
| T7 | 匹配失败 | 无法按编号/企业名/代码匹配到任何 IPO 条目 | **不打标**（无状态源红线），线索仅留红筹展示页 |

---

## 4. 对齐国内 IPO：现状复用点

| 能力 | 国内 IPO 现状（复用） | 红筹对齐方式 |
|---|---|---|
| 源层窗口 | `IPO_SOURCE_WINDOW_DAYS = 7` | 红筹监测同一 7 天窗（§1） |
| 列表 7 天 | `render/full.ts` → `topGdIpo(..., 9999, IPO_LIST_WINDOW_DAYS)` | 红筹条目**同池同列**，仅多徽章 + 提权 |
| 口播 / 横滑 2 天 | `topGdIpo(..., 3, IPO_VOICE_WINDOW_DAYS)` | 红筹候选并入同一候选池（不额外占额） |
| 口播句 | `buildGdIpoSpoken`（确定性、免 LLM） | 同段内**红筹句置前**，其后跟常规 IPO 句（§5.2） |
| 跨天去重 | 事件记忆 `ipoVoicing` + `skipCompanies` | 同一机制，企业名归一化共用 `normalizeCompanyName` |
| 阶段排序 | `STAGE_RANK`（分栏/进度）/ `BIZ_VALUE_RANK`（候选池商机序） | 不变；红筹只在 `BIZ_VALUE_RANK` 上加提权 |
| 卡片结构字段 | `ipoStage / listedDate / officialUrl / ipoMeta / ipoCity / gdBasis` | 追加 `redchip`，其余不动 |

---

## 5. 各环节展示形式

### 5.1 展示卡片（7 天列表 + 2 天横滑）

```
┌────────────────────────────────────────────────┐
│ 〔红筹线索〕深圳××智能科技集团        〔新〕   │   ← 徽章 + 变更角标
│ 深圳市 ｜ 拟上市主板 ｜ 受理 2026-09-05 ｜ 09/07 │   ← ipoCity / board / ipoMeta / date
│ 保荐 ××证券；境外注册（开曼）· 广东运营 5 处     │   ← summary（沿用 IPO 卡结构）
│                        → 穿透分析报告（会前）   │   ← 可点入口（T5/T6）
└────────────────────────────────────────────────┘
```
- **徽章**：`红筹线索`（红底）/ `红筹线索·待核`（灰边）；`added` 变更加**「新」**角标。
- **排序**：红筹条目按 `REDCHIP_VOICE_BOOST` 提权前移（**不占额外名额**）。
- **点击**：整卡可点 → `site/redchip/r/<leadId>.html`（新窗口/内嵌）；存在 `deep/manual` 时优先。
- **筛选/排序**：沿用 IPO 面板既有能力；可加「红筹线索」筛选 chip（可选）。

### 5.2 音频口播（2 天，**合并进 `ipo` 段**，≤150 字，红筹置前）

口播文本 = **红筹线索句（置前）** + 常规 IPO 句（其后），确定性拼装、免 LLM：

- 红筹单家模板：
  `「<企业名>为红筹线索（<离岸地>注册、广东运营<N>处），拟在<交易所>IPO，目前<进展>」`（首见加前缀「新增红筹线索：」）
  `「<企业名>红筹线索有更新：<字段> <from>→<to>」`（`changed` 类型）
- 常规 IPO 句：沿用 `buildGdIpoSpoken` 现有模板。
- 字号/配额：**同一段合并**，由 `AUDIO_SPEAK_LIMITS.ipo`(150) 统一截断；因红筹置前，**截断时红筹优先保留**；
  若后续红筹条目变多导致常规 IPO 句被长期挤掉，再把红筹拆独立段位 `AUDIO_SPEAK_LIMITS.redchip`（如 80 字）。

### 5.3 穿透分析报告（会前版本）`site/redchip/r/<leadId>.html`

| 版块 | 内容 | 数据来源 |
|---|---|---|
| 抬头 | 企业名（中/英）+ 徽章 + 判定结论 + **判定依据一句话**（离岸注册 ∧ 广东词频 N≥3） | `RedchipLead` |
| **架构穿透** | 注册地 → 离岸法域 → VIE 状态（`current/historical/none/unverified`）+ 架构要点列表 | `domicile` / `vie` / `archNotes` |
| **广东连接证据** | 词频计数 + 1–3 条原文摘录（可点回 PDF） | `gdCityHits` / `gdEvidence` |
| **进展时间线** | `submitDate` → `discoveredAt` → 历次 `changed`（字段/前后值/时间） | `changelog.jsonl` |
| **官方入口** | 申请版本 PDF 直链 | `sourceUrl` |
| 页脚 | 数据来源 / 抓取时刻 / 水印「**会前版本 · 待深度核验**」 | `capturedAt` |

**「会前版本」= 自动生成（零 LLM）+ 深度版覆盖**（已拍板）：

| 概念 | 含义 | LLM 消耗 |
|---|---|---|
| **自动生成** | `build-site.mjs` 用**写死的 HTML 模板做字符串拼接**，为每条线索生成一页（与现有 `site/redchip/index.html` 同类工作） | **0**（毫秒级纯字符串拼接） |
| **深度版覆盖** | 若存在人工/深度报告 `deep/<leadId>.html`、`manual/<leadId>.html`，卡片与报告页入口**优先指向深度版** | 仅在你**主动**生成深度报告时才有消耗；不在本方案内、不自动跑 |
| **收益** | 覆盖 100%，**点开不空**（解决「38 家线索里 36 家点开是空的」） | — |

**生成方**：`scripts/build-site.mjs`（遵守「`site/` 唯一写者」约定）+ `scripts/lib/redchip-report.mjs`（新，纯 JS，与 `redchip-page.mjs` 同风格）。

---

## 6. 改动清单（研发）

> **前置阻塞项（先于本表其余项）**：① 文档选取改为「申请版本 / 封面分册」；② 抓取窗口改为「本次运行日 + 空结果回退」；③ **判定口径加「集团实体语境」层**（否则离岸公司一律被判 redchip，见 §1.1 实测告警）——见 §1.2 / §1.1。

| # | 层 | 文件 | 动作 |
|---|---|---|---|
| 1 | 契约 | `lib/contracts/redchip.ts` | 新增 `RedchipLead` / `RedchipReportRef` / 徽章枚举常量 |
| 2 | 契约 | `lib/contracts/report.ts` | `ReportItem` 追加 `redchip?: RedchipBadge` |
| 3 | 契约 | `lib/ipo-config.ts` | 新增 `REDCHIP_VOICE_WINDOW_DAYS=2` / `REDCHIP_LIST_WINDOW_DAYS=7` / `REDCHIP_VOICE_BOOST=2` |
| 4 | 适配器 | `lib/adapters/redchip/snapshot-store.ts` | 读写 `leads.json`；`changelog` 按 `leadId` 归并出 `lastChangedAt` |
| 5 | 适配器 | `lib/adapters/redchip/report-resolver.ts`（新） | 探测 `r/` `deep/` `manual/` → `RedchipReportRef[]` |
| 6 | 服务 | `lib/services/classify/redchip.ts`（新，纯函数） | `matchRedchipLead(item, leads)`（编号/归一化企业名/代码实体匹配）+ `redchipBadgeOf(lead, {today, changes})`（窗口/徽章/isNew/label） |
| 7 | 服务 | `lib/services/classify/gd-ipo-spoken.ts` | ① 候选池排序加 `REDCHIP_VOICE_BOOST` 提权；② 口播同段内**红筹句置前** |
| 8 | 编排 | `lib/pipeline/side-outputs/side-redchip.ts`（新） | 匹配 → 写回 `item.redchip` → 产出 `report.redchipPanel` |
| 9 | 编排 | `lib/pipeline/index.ts` | 在 `buildGdIpo` 之后调用 `buildRedchip` |
| 10 | 渲染 | `lib/services/render/ipo-panel.ts`（改）+ `redchip-panel.ts`（新） | 卡片徽章 / 点击入口 / 红筹面板（按 `gdTier` + `submitDate` 排序） |
| 11 | 渲染 | `scripts/lib/redchip-report.mjs`（新）+ `redchip-page.mjs`（改） | 每线索一份「会前版本」报告页；首页增加入口 |
| 12 | 编排 | `scripts/build-site.mjs` | 增生成 `site/redchip/r/<leadId>.html` |
| 13 | CI | `.github/workflows/daily.yml` | 「红筹监测」步骤产出 `leads.json`（供渲染读取）；保持 `continue-on-error` |
| 14 | 测试 | `tests/redchip-lead.test.ts` / `redchip-badge.test.ts`（新） | 实体匹配、窗口边界、徽章/触发条件、**提权排序**、报告覆盖率加锁 |
| 15 | 文档 | `docs/redchip.md` | 补「口播/展示窗口」「徽章语义」「报告页路径」「提权常量」 |
| 16 | **前置** | `lib/adapters/redchip/hkex-client.ts` + `scripts/redchip-monitor.ts` | **文档选取**：从 `w` 直链改为「申请版本 / 封面分册」（Multi-Files 目录）→ 才能抽出注册地句式 |
| 17 | **前置** | `scripts/redchip-monitor.ts` | **抓取窗口**：改「本次运行日 + 空结果回退到最近有数据日期」（现为固定「昨天」，会因 1~2 天滞后恒空） |
| 18 | **前置** | `lib/services/redchip/classify.ts` + `lib/contracts/redchip.ts`（+ 测试） | ✅ **已完成（2026-09-15）**：`countGdCityHits` 加三层过滤（交易所掩码 + 句子级实体语境 + 邻近距离窗口）；新增 `countGdCityMentions` 裸提及与契约字段 `gdCityMentions?`；阈值维持 3（实网 ✔） |

**入库约定**：`data/redchip/leads.json` **必须入库**（冻结快照，与 `data/local-ipo.json` 同模式）；
`latest.json` / `snapshots/` / `changelog.jsonl` 为运行时产物，**不入库**（建议加精确 gitignore 三条，勿整目录忽略）。

### 6.1 完成情况（2026-09-15 夜，一轮落地）

| # | 状态 | 落点与说明 |
|---|---|---|
| 1 | ✅ | `contracts/redchip.ts`：`RedchipLead`（extends `RedchipProject`）/`RedchipReportRef`/`RedchipBadge`/`RedchipPanel`/`REDCHIP_LABELS` |
| 2 | ✅ | `contracts/report.ts`：`ReportItem.redchip` + `DailyReport.redchipPanel` |
| 3 | ✅ | `ipo-config.ts`：`REDCHIP_VOICE_WINDOW_DAYS=2` / `REDCHIP_LIST_WINDOW_DAYS=7` / `REDCHIP_VOICE_BOOST=2` |
| 4 | ✅ | **归并逻辑放在 `services/redchip/leads.ts`（纯函数，可测）**；`snapshot-store` 只做 IO（`readLeads`/`writeLeads`）——比原计划更严格地守「服务层不碰 IO」 |
| 5 | ✅ | `adapters/redchip/report-resolver.ts`（`manual > deep > r`，含目录穿越防护） |
| 6 | ✅ | `services/classify/redchip.ts`：`matchRedchipLead`（编号→代码→企业名）/`redchipLabelOf`/`redchipBadgeOf`/窗口判定 |
| 7 | ✅ | `gd-ipo-spoken.ts`：`candidateScore` 加 `REDCHIP_VOICE_BOOST`；`pickSpokenItems` 红筹置前（口播与记忆写回同源） |
| 8 | ✅ | `pipeline/side-outputs/side-redchip.ts`（纯 `buildRedchip` + IO 包装 `buildRedchipFromStore`） |
| 9 | ✅ | 接在 `side-outputs.ts` 第 5 步（`buildGdIpo` 之后） |
| 10 | ✅ | 徽章加在 `render/stock-block.ts::renderGdIpoStrip`（IPO 卡实际渲染处，非 `ipo-panel.ts`）；新增 `render/redchip-panel.ts`，接线于 `full.ts` 五板块之后 |
| 11 | ⚠️ 部分 | `scripts/lib/redchip-report.mjs` 已建；**`redchip-page.mjs` 首页表格尚未加「报告」入口链接** |
| 12 | ✅ | `build-site.mjs` §5.5b 生成 `site/redchip/r/<leadId>.html`（`verdict ≠ non-redchip`，零 LLM） |
| 13 | ✅ | `redchip-monitor.ts` 产出 `leads.json`（同源写盘，紧随快照之后） |
| 14 | ✅ | 新增 5 个测试文件：`redchip-lead` / `redchip-badge` / `redchip-panel` / `redchip-spoken` / `redchip-report`（含子进程端到端） |
| 15 | ⬜ | `docs/redchip.md` 文档未补（窗口/徽章/报告路径/提权常量） |

**与方案的三处刻意偏差（均已在上文注明）**：
1. **口播不播「广东运营 N 处」**：`gdCityHits` 是**实体语境提及次数**、不等于实体个数 → 口播只说「含广东运营实体」，计数只出现在卡片/报告页（`§5.2` 已注）。
2. **归并逻辑下沉到 services**（见 #4），IO 只在 adapter。
3. **徽章渲染点**在 `stock-block.ts`（真实卡片处），未改 `ipo-panel.ts`（该文件是分栏/筛选，不产卡片）。

**顺带修的一个真实缺陷**：港交所条目标题不含「（拟XX）」字样 → 交易所推导为空；现以「URL 含申请编号」兜底判为**港交所**（`isHkexItem`），红筹句才能说清「拟在港交所 IPO」。


---

## 7. 验收与测试要点

1. **窗口边界**：日差 7 在列表、8 不在；日差 2 进口播、3 不进（对齐 IPO 2026-09-10 实锤口径）。
2. **不占名额 + 提权**：红筹不增加候选总数上限；同一批候选里红筹因 `REDCHIP_VOICE_BOOST` 前移；把常量调 0 应完全退回与普通 IPO 同序。
3. **红筹置前**：口播同段内红筹句在常规 IPO 句之前；截断时红筹优先保留。
4. **跨天去重**：同一企业 2 天内不重复口播；卡片不受影响。
5. **无状态源红线**：不因「来自红筹数据源」打标；必须实体匹配（T7 走通）。
6. **判定阈值必须真正生效**（2026-09-15 新增，✅ 已加锁）：`countGdCityHits` 只计**实体语境 + 邻近窗口**内的命中，且不得把 `Shenzhen Stock Exchange`、董事住址计入；**反例锁**：`test ⑨` —— 「开曼注册 + 广东词只出现在董事住址」必须判 `non-redchip`；`test ⑩` —— 同句内距所属表达 400 字符的城市名不计入。
6. **时间红线**：无递表日 → 废弃；不用抓取时间兜底。
7. **合规红线**：不出现加密资产内容；不出现任何可定位银行主体的信息。
8. **覆盖率 / 零 LLM**：所有 `verdict ≠ non-redchip` 的线索都能打开「会前版本」报告页（点开不空），且生成过程**不发起任何 LLM 调用**（可用 LLM 端口计数测试锁定）。
9. **降级**：红筹监测失败 / `leads.json` 缺失 → 卡片无徽章、报告页为空态，**不阻断日报发布**。
10. **判定链零 LLM**：识别路径（`extractPdfText` + `classifyProject`）全程**不调用 LLM 端口**（与第 8 条同样用端口计数锁定）。
11. **文档选取（前置阻塞）**：实网抽样（如 `108870`）应能抽出封面页注册地句式；**在此之前不得上线红筹标** —— 否则真红筹会被判成 `non-redchip`（漏报），比打错标更糟。

---

## 8. 决策记录（已拍板 · 2026-09-15）

| # | 议题 | 裁决 | 落地位置 |
|---|---|---|---|
| 1 | 徽章文案 | 统一用「**线索**」口径：`红筹线索` / `红筹线索·待核` | §3.1、§2.2 `label` |
| 2 | 名额与优先 | **不额外占名额**，但**排序提权、优先播报**（权重可调） | §2.4 `REDCHIP_VOICE_BOOST`、T4、§6-#7 |
| 3 | 会前版本生成方 | **自动生成（零 LLM）+ 深度版覆盖**；**不产生 LLM 消耗** | §5.3 |
| 4 | 窗口常量 | **独立起名**（`REDCHIP_VOICE_WINDOW_DAYS=2` / `REDCHIP_LIST_WINDOW_DAYS=7`），数值与 IPO 一致 | §2.4 |
| 5 | 口播结构 | **合并进 `ipo` 段**，但红筹**优先级更高（置段首）** | §5.2、§6-#7 |
| 6 | 提权强度 | **稳健**：`REDCHIP_VOICE_BOOST = 2`（默认值，不取绝对优先） | §2.4 |
| 7 | 红筹句被挤掉时的备选 | **可**：需要时拆独立段位 `AUDIO_SPEAK_LIMITS.redchip`（约 80 字） | §5.2 |
| 8 | 「识别红筹」是否用 LLM | **不用**：PDF 文本抽取（`unpdf`）+ 固定句式正则 + 词频计数，**零 LLM**；仅**深度研判**可能用，由人工触发 | §1.1 |
| 9 | 文档选取短板 | **列为前置阻塞项**（根因已实网确认：`w`=警告页；申请版本在 `ls[]`） | §1.2 短板①、§6-#16 |
| 10 | **申请版本中文抽取失败** | **已选路线 A（英文通道）并落地**：改读 `*_e.json` 英文清单 + `ls[]` 申请版本 + 紧凑化匹配；**实网验证通过**（见 §1.2） | §1.2 短板③、§6-#16/#17 |
| 11 | **是否接 red 的省钱路径**（小分册 / Range+zlib） | **暂不接**：实网实测判定效果可 100% 替代（体积 9%~15%），但本项目瓶颈不是带宽/耗时，收益不抵"多请求编排 + 分册名漂移 + 漏判风险"；**保留全文单文件**。Range+zlib **不可用**（多法域歧义） | §1.3 |
| 12 | **判定口径的语义归属层** | ✅ **已落地（用户授权）**：`countGdCityHits` 改为「交易所掩码 + 实体语境句 + 160 字符邻近窗口」三层过滤；`countGdCityMentions` 保留裸提及；阈值维持 3。实网去噪 92%~96%（127→4、338→9、河北 4→0） | §1.1、§6-#18、§7-6 |

**遗留可调项（非阻塞）**：
- `REDCHIP_VOICE_BOOST` 默认 `2`（稳健提权）。若当日红筹 ≥3 条会占满 3 席横滑/口播，可把该值调低；要「绝对优先」则调 ≥5。
- 若红筹条目长期挤掉常规 IPO 句，再把红筹拆出独立口播段位（`AUDIO_SPEAK_LIMITS.redchip`，约 80 字）。
- 「红筹线索」筛选 chip 是否上首页（可选，默认不加）。
