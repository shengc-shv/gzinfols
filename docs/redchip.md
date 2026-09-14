# 红筹项目监测与展示

数据源为港交所「披露易」**新上市申請版本及相關資料（AP & PHIP）**公开静态地址（免鉴权）。

## 识别口径

```
红筹 = 境外注册 ∧ 广东运营实体词频 ≥ 3
```

- **境外注册**：申请版本封面页固定句式（如 `Incorporated in the Cayman Islands with limited liability`）→ 注册地属离岸法域（开曼 / 百慕大 / BVI …）。
- **广东连接**：招股书文本中广东城市词频 ≥ 3（`GD_CITY_HIT_THRESHOLD`）。
- **VIE**：仅作画像展示，**不参与判定**。
- 证据不足一律 `unverified`，**不臆造结论**。

## 运行

```bash
npx tsx scripts/redchip-monitor.ts --live            # 实网抓取（默认抓"北京时间昨天"）
npx tsx scripts/redchip-monitor.ts --live --date 2026-09-14 --limit 20
npx tsx scripts/redchip-monitor.ts                    # 样本模式（零网络，用于自测）
npx tsx scripts/redchip-monitor.ts --dry-run          # 只打印不写盘
```

参数：`--live` 实网 / `--sample <path>` 样本 / `--date YYYY-MM-DD` 目标日（默认北京时间昨天）
/`--limit N` 每轮最多抽取 PDF 条数（控成本）/ `--dry-run`。

> ⏰ **日期口径**：CI 每天只跑一次（北京早 7:30），当天数据尚未发布，故**默认抓"北京时间昨天"**。
> 不可用 `Date.toISOString()` 取日期（那是 UTC 日期，会错成"今天"）。

## 产出

| 文件 | 说明 |
|---|---|
| `data/redchip/latest.json` | 最新快照（展示层读取） |
| `data/redchip/snapshots/<date>.json` | 按次归档快照 |
| `data/redchip/changelog.jsonl` | append-only 变更日志（新增 / 移除 / 字段变更，带来源链接） |
| `site/redchip/index.html` | 展示页（由 `build-site.mjs` 生成，遵守 site/ 唯一写者） |

## 展示

清单含：企业名、板块、状态、递表日、注册地（离岸标记）、广东词频（粤标记）、VIE、判定、
发现时间、原文链接；支持按判定 / 板块 / 离岸 / 粤连接 / 名称筛选，按发现时间 / 递表日 / 企业名排序。
附变更历史区块（时间 / 类型 / 编号 / 字段前后值 / 来源）。

## CI

`.github/workflows/daily.yml` 中的「红筹监测」步骤随**每次 CI 运行**执行（`continue-on-error`，
不阻断日报主线）；随后 `build-site` 用其快照产出展示页。

## 复核

页面与日志记录均为**公开信息初筛**，线索 ≠ 结论；每条附港交所原文链接，广东连接须回原文复核。
