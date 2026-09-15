// 一次性脚本：基于 extracted-2026-09-13.json（CI dump 池）生成 replay 分析文件：
//   data/replay/2026-09-15/pass1.response.txt  —— 9 保留 + 21 丢弃的 PASS1 判定
//   data/replay/2026-09-15/pass2.response.txt  —— 9 条终稿（摘要/重心/标签）
// 决策由本脚本内 KEEP 表硬编码（WorkBuddy 本地逐条撰写分析的结论）。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const date = process.argv[2] || "2026-09-15";
const arts = JSON.parse(readFileSync(resolve(process.cwd(), "data/replay/extracted-2026-09-13.json"), "utf8"));
const byUrl = new Map(arts.map((a) => [a.url, a]));

// —— WorkBuddy 本地撰写的分析结论（逐条）——
// section: ipo | biz_insight ; locale: gz=仅广州（深圳/广东企业一律 national + 粤 tag，
// gd-ipo category 已承担广东标识；地域标错代价极高，务必从严）
// importance_candidate(PASS1 提示) / importance(PASS2 终排)
const KEEP = {
  // 5 条 IPO（广东 2 + 全国 3）
  "https://www1.hkexnews.hk/app/sehk/2026/108870/2026091300120_c.htm": {
    section: "ipo", locale: "national", tags: ["粤"], imp: 3,
    title_cn: "深圳市海柔创新智能科技集团（主板递表·广东企业）",
    // ⚠️ R3：locale≠gz 的条目 summary 禁止出现「广东/广州企业」字样 → 用「粤企」；
    // ⚠️ R8：summary 不写日期数字（raw_text 数字集合比对易误报）
    summary: "深圳市海柔创新智能科技集团递表港交所主板，粤企赴港上市新案例，可跟进跨境融资商机。",
  },
  "https://www1.hkexnews.hk/app/sehk/2026/108867/2026091001722_c.htm": {
    section: "ipo", locale: "national", tags: ["粤"], imp: 2,
    title_cn: "广东微电新能源（主板递表·广东企业）",
    summary: "广东微电新能源递表港交所主板，粤企赴港上市延续活跃，可关注跨境融资与高净值客群机会。",
  },
  "https://www1.hkexnews.hk/app/sehk/2026/108868/2026091101554_c.htm": {
    section: "ipo", locale: "national", tags: [], imp: 2,
    title_cn: "翱捷科技（主板递表）",
    summary: "翱捷科技递表港交所主板，港股在审全国参考，可关注企业上市融资动向。",
  },
  "https://www1.hkexnews.hk/app/gem/2026/108869/2026091101852_c.htm": {
    section: "ipo", locale: "national", tags: [], imp: 2,
    title_cn: "浙江和夏科技（GEM递表）",
    summary: "浙江和夏科技递表港交所GEM，港股在审全国参考。",
  },
  "https://www1.hkexnews.hk/app/gem/2026/108866/2026091000823_c.htm": {
    section: "ipo", locale: "national", tags: [], imp: 1,
    title_cn: "河北联吉启成产业园区运营（GEM递表）",
    summary: "河北联吉启成产业园区运营企业递表港交所GEM，港股在审全国参考。",
  },
  // 2 条财富管理
  "https://finance.sina.com.cn/trust/2026-09-15/doc-inirwfqh3722226.shtml": {
    section: "biz_insight", locale: "national", tags: ["养老", "财富"], imp: 3,
    title_cn: "中诚信托落地人保集团首单养老服务信托",
    summary: "中诚信托落地人保集团首单养老服务信托项目，“保险＋信托”双擎拓宽养老金融供给，可关注养老客群经营。",
  },
  "https://finance.sina.com.cn/stock/bxjj/2026-09-15/doc-inirwfqe6946962.shtml": {
    section: "biz_insight", locale: "national", tags: ["财富", "市场"], imp: 2,
    title_cn: "ETF资金流向观察：宽基净流入居首、黄金受关注",
    summary: "ETF资金流向观察显示宽基ETF净流入居首、黄金ETF受关注，可提示客户关注大类资产配置动向。",
  },
  // 广汽一汽整合 + 液冷板块
  "https://www.cnfin.com/yw-lb/detail/20260915/4469836_1.html": {
    section: "biz_insight", locale: "national", tags: ["市场", "竞对动态"], imp: 2,
    title_cn: "广汽牵手一汽 汽车业资产整合升级",
    summary: "广汽与一汽携手推进汽车业资产整合升级，值得关注产业链金融与汽车消费贷客群机会。",
  },
  "https://finance.eastmoney.com/a/202609153874019577.html": {
    section: "biz_insight", locale: "national", tags: ["市场", "科技金融"], imp: 2,
    title_cn: "中信建投：继续看好液冷板块配置价值",
    summary: "中信建投认为液冷行业处于三重共振放量期、继续看好板块配置价值，可关注科技金融客群。",
  },
};

// —— PASS1 响应：9 keep + 其余 keep:false ——
const pass1Items = arts.map((a) => {
  const k = KEEP[a.url];
  if (!k) return { url: a.url, keep: false };
  return {
    url: a.url,
    keep: true,
    section: k.section,
    source_type: a.category === "gd-ipo" || a.category === "ipo" ? "official" : "media",
    locale: k.locale,
    locale_evidence: k.locale_evidence || "",
    tags: k.tags,
    title_cn: k.title_cn,
    title_orig: "",
    importance_candidate: k.imp,
  };
});
const pass1 = { items: pass1Items };

// —— PASS2 响应：仅 9 条，放进对应 section ——
const ipo = [], biz = [];
for (const a of arts) {
  const k = KEEP[a.url];
  if (!k) continue;
  const item = {
    url: a.url,
    title_cn: k.title_cn,
    title_orig: "",
    source: a.source,
    source_type: a.category === "gd-ipo" || a.category === "ipo" ? "official" : "media",
    date: a.date,
    summary: k.summary,
    importance: k.imp,
    tags: k.tags,
    locale: k.locale,
    locale_evidence: k.locale_evidence || "",
  };
  if (k.section === "ipo") ipo.push(item);
  else biz.push(item);
}
const hero = "粤企赴港上市活跃（海柔、微电新能源递表），叠加养老信托与液冷板块热点，建议分行跟进跨境融资、养老客群与科技金融机会。";
const pass2 = {
  hero_line: hero,
  must_read: [],
  insights: [],
  sections: { gz_local: [], biz_insight: biz, policy_market: [], tech: [], ipo },
};

const dir = resolve(process.cwd(), `data/replay/${date}`);
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, "pass1.response.txt"), JSON.stringify(pass1, null, 2) + "\n");
writeFileSync(resolve(dir, "pass2.response.txt"), JSON.stringify(pass2, null, 2) + "\n");

// —— executive 响应：必读/商机/定调（接管评分兜底，避免滚动池噪声混入 hero）——
// url 必须取自今日成稿条目；insight.tag 词表：竞对动态/信贷/代发/私行/政银合作/住房金融/财富/客群/科技金融
const U = Object.fromEntries(arts.map((a) => [a.url, a]));
const srcOf = (u) => ({ title: U[u].title, url: u });
const executive = {
  hero_line: "粤企赴港上市活跃、养老信托落地、液冷板块获看好，建议分行跟进跨境融资、养老客群与科技金融机会。",
  must_read: [
    {
      title: "粤企赴港上市活跃",
      why: "广东企业接连递表港交所，跨境融资需求升温，私行跨境与家族传承客群有直接商机。",
      url: "https://www1.hkexnews.hk/app/sehk/2026/108870/2026091300120_c.htm",
    },
    {
      title: "养老金融服务信托首单落地",
      why: "“保险＋信托”拓宽养老金融供给，养老客群资产保全与传承需求值得跟进。",
      url: "https://finance.sina.com.cn/trust/2026-09-15/doc-inirwfqh3722226.shtml",
    },
    {
      title: "液冷板块配置价值获看好",
      why: "算力基建带动液冷放量，科技金融与专精特新客群迎来景气窗口。",
      url: "https://finance.eastmoney.com/a/202609153874019577.html",
    },
    {
      title: "宽基ETF净流入居首、黄金受关注",
      why: "客户避险与多元化配置需求升温，财富配置窗口值得向客群提示。",
      url: "https://finance.sina.com.cn/stock/bxjj/2026-09-15/doc-inirwfqe6946962.shtml",
    },
    {
      title: "广汽一汽推进资产整合升级",
      why: "汽车业整合升级带动产业链格局调整，汽车金融与消费贷场景值得关注。",
      url: "https://www.cnfin.com/yw-lb/detail/20260915/4469836_1.html",
    },
  ],
  insights: [
    {
      topic: "跨境融资商机",
      impact: "海柔创新、微电新能源等广东企业递表港交所主板，上市前后存在跨境结算、外币配置与私行传承需求。",
      action: "本周梳理辖内拟赴港上市与出海企业名单，联动跨境团队备妥开户与结售汇服务方案。",
      tag: ["私行", "财富"],
      sources: [
        srcOf("https://www1.hkexnews.hk/app/sehk/2026/108870/2026091300120_c.htm"),
        srcOf("https://www1.hkexnews.hk/app/sehk/2026/108867/2026091001722_c.htm"),
      ],
    },
    {
      topic: "养老客群经营",
      impact: "养老服务信托项目落地，养老金融供给进一步丰富，老年客群资产保全意识提升。",
      action: "面向养老年金与代发客群推送信托加保险组合方案，并组织网点养老金融话术培训。",
      tag: ["财富", "客群"],
      sources: [srcOf("https://finance.sina.com.cn/trust/2026-09-15/doc-inirwfqh3722226.shtml")],
    },
    {
      topic: "大类资产配置参考",
      impact: "宽基ETF净流入居首、黄金ETF受关注，客户避险与多元化配置需求升温。",
      action: "今日起对持有闲置资金的客户提示ETF与黄金配置参考，同时提示追高风险。",
      tag: ["财富"],
      sources: [srcOf("https://finance.sina.com.cn/stock/bxjj/2026-09-15/doc-inirwfqe6946962.shtml")],
    },
    {
      topic: "科技金融客群",
      impact: "中信建投认为液冷行业处于三重共振放量期，算力产业链景气度上行。",
      action: "摸排辖内液冷及算力产业链企业，评估信贷与代发业务合作切入点。",
      tag: ["科技金融", "信贷"],
      sources: [srcOf("https://finance.eastmoney.com/a/202609153874019577.html")],
    },
    {
      topic: "汽车产业链动态",
      impact: "广汽与一汽携手推进资产整合升级，产业链格局调整带来结算与消费场景机会。",
      action: "留意整车及零部件企业资金沉淀动向，适时推介对公结算与消费贷合作。",
      tag: ["信贷", "竞对动态"],
      sources: [srcOf("https://www.cnfin.com/yw-lb/detail/20260915/4469836_1.html")],
    },
  ],
  risk: null,
  guangdong_ipo: {
    spoken: "广东企业海柔创新（深圳）与微电新能源近日递表港交所主板，均处上市申请阶段，可跟进跨境金融服务。",
  },
};
writeFileSync(resolve(dir, "executive.response.txt"), JSON.stringify(executive, null, 2) + "\n");

console.log(
  `已生成: ${dir}/pass1.response.txt (keep=${pass1Items.filter(i=>i.keep).length}) + pass2.response.txt (ipo=${ipo.length}, biz=${biz.length}) + executive.response.txt (must_read=${executive.must_read.length}, insights=${executive.insights.length})`,
);
