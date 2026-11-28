/**
 * 经营重点配置校验器（二期 WP1 · 规格 2.5）。
 *
 * 设计原则：**逐条丢弃，绝不整份废弃**。
 * 一条重点写错（id 重复 / 日期倒挂 / 领域拼错）只影响它自己；文件级格式错误才让整层降级。
 * 理由：日报是唯一交付物，配置错误不能让 `runPipeline` 失败（规格 10.2 降级要求）。
 *
 * ⛔ 本文件不读文件、不读时钟、不写日志：纯函数，输入 `FocusFileInput`，输出归一化结果 + 问题清单。
 */
import { DOMAIN_IDS } from "../vocab/business-domains";
import {
  FOCUS_LAYER_PRIORITY,
  type FocusConfigIssue,
  type FocusFileInput,
  type FocusGrade,
  type FocusItem,
  type FocusLayer,
  type FocusStatus,
} from "./types";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LAYERS: readonly FocusLayer[] = ["annual", "quarterly", "temporary"];
const GRADES: readonly FocusGrade[] = ["S", "A", "B"];

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean);
}

function dateOrEmpty(v: unknown, file: string, id: string, field: string, issues: FocusConfigIssue[]): string {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v !== "string" || !DATE_RE.test(v)) {
    issues.push({ file, id, field, message: `日期格式应为 YYYY-MM-DD，实际 ${JSON.stringify(v)}（已忽略该字段）` });
    return "";
  }
  return v;
}

/**
 * 校验并归一化**单个**配置文件。
 * @param input 已解析的文件内容与状态（IO 由 adapter 负责）
 */
export function normalizeFocusFile(input: FocusFileInput): {
  items: FocusItem[];
  issues: FocusConfigIssue[];
  version: string;
} {
  const { file, layer } = input;
  const issues: FocusConfigIssue[] = [];

  if (input.state === "missing") {
    return { items: [], issues: [{ file, message: "配置文件不存在（该层按空处理）" }], version: "" };
  }
  if (input.state === "corrupt") {
    return {
      items: [],
      issues: [{ file, message: `配置解析失败（该层按空处理）：${input.error ?? "未知错误"}` }],
      version: "",
    };
  }

  const raw = input.data as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { items: [], issues: [{ file, message: "配置文件根节点必须是对象（该层按空处理）" }], version: "" };
  }

  const version = typeof raw.version === "string" ? raw.version.trim() : "";
  const list = raw.focus_items;
  if (!Array.isArray(list)) {
    return {
      items: [],
      issues: [{ file, message: "缺少 focus_items 数组（该层按空处理）" }],
      version,
    };
  }

  const items: FocusItem[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (!it || typeof it !== "object" || Array.isArray(it)) {
      issues.push({ file, field: `focus_items[${i}]`, message: "不是对象，已跳过" });
      continue;
    }
    const o = it as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    if (!id) {
      issues.push({ file, field: `focus_items[${i}].id`, message: "id 为空，已跳过" });
      continue;
    }
    if (seen.has(id)) {
      issues.push({ file, id, field: "id", message: "同一个文件内 id 重复，后者已跳过" });
      continue;
    }
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!name) {
      issues.push({ file, id, field: "name", message: "name 为空，已跳过" });
      continue;
    }

    // level：规格 2.5 要求只能是三个枚举值；与文件层不一致时以文件层为准（
    // 因为文件本身就是按层拆分的，改文件名比改字段更容易出错）。
    let resolvedLayer: FocusLayer = layer;
    if (o.level !== undefined) {
      if (typeof o.level === "string" && (LAYERS as readonly string[]).includes(o.level)) {
        resolvedLayer = o.level as FocusLayer;
        if (resolvedLayer !== layer) {
          issues.push({
            file,
            id,
            field: "level",
            message: `level=${resolvedLayer} 与文件层 ${layer} 不一致，已按 level 处理`,
          });
        }
      } else {
        issues.push({ file, id, field: "level", message: `level 非法（${JSON.stringify(o.level)}），已按文件层 ${layer} 处理` });
      }
    }

    const grade: FocusGrade =
      typeof o.grade === "string" && (GRADES as readonly string[]).includes(o.grade.toUpperCase())
        ? (o.grade.toUpperCase() as FocusGrade)
        : "B";
    if (o.grade !== undefined && o.grade !== grade) {
      issues.push({ file, id, field: "grade", message: `grade 非法（${JSON.stringify(o.grade)}），已降为 B` });
    }

    // status 缺省视为 inactive：宁可少加权，也不能凭一条没写 status 的配置改变每日排序。
    const status: FocusStatus = o.status === "active" ? "active" : "inactive";
    if (o.status !== undefined && o.status !== "active" && o.status !== "inactive") {
      issues.push({ file, id, field: "status", message: `status 非法（${JSON.stringify(o.status)}），已按 inactive 处理` });
    }

    const priorityRaw = Number(o.priority);
    const priority =
      Number.isFinite(priorityRaw) && priorityRaw >= 0.5 && priorityRaw <= 3
        ? priorityRaw
        : FOCUS_LAYER_PRIORITY[resolvedLayer];
    if (o.priority !== undefined && priority !== priorityRaw) {
      issues.push({
        file,
        id,
        field: "priority",
        message: `priority 超出 0.5~3 允许范围（${JSON.stringify(o.priority)}），已用层级默认值 ${priority}`,
      });
    }

    let weight: number | undefined;
    if (o.weight !== undefined) {
      const w = Number(o.weight);
      if (Number.isFinite(w) && w >= 0 && w <= 50) weight = w;
      else issues.push({ file, id, field: "weight", message: `weight 超出 0~50（${JSON.stringify(o.weight)}），已改用默认表` });
    }

    const start_date = dateOrEmpty(o.start_date, file, id, "start_date", issues);
    const end_date = dateOrEmpty(o.end_date, file, id, "end_date", issues);
    if (start_date && end_date && start_date > end_date) {
      issues.push({
        file,
        id,
        field: "start_date",
        message: `start_date(${start_date}) 晚于 end_date(${end_date})，该重点已跳过（不允许倒挂周期参与加权）`,
      });
      continue;
    }

    const domainsRaw = asStringArray(o.domains);
    const domains = domainsRaw.filter((d) => (DOMAIN_IDS as readonly string[]).includes(d));
    for (const bad of domainsRaw) {
      if (!(DOMAIN_IDS as readonly string[]).includes(bad)) {
        issues.push({ file, id, field: "domains", message: `未知领域 id「${bad}」已忽略（合法值：${DOMAIN_IDS.join("/")}）` });
      }
    }
    if (!domains.length) {
      issues.push({ file, id, field: "domains", message: "没有合法的关联领域，该重点已跳过（无法做领域匹配）" });
      continue;
    }

    const core_keywords = asStringArray(o.core_keywords);
    const keywords = asStringArray(o.keywords);
    const synonyms = asStringArray(o.synonyms);
    if (!core_keywords.length && !keywords.length && !synonyms.length) {
      issues.push({ file, id, field: "keywords", message: "关键词全空，该重点已跳过（规格 2.5 要求关键词不能为空）" });
      continue;
    }

    items.push({
      id,
      name,
      description: typeof o.description === "string" ? o.description.trim() : "",
      layer: resolvedLayer,
      grade,
      status,
      priority,
      ...(weight === undefined ? {} : { weight }),
      highlight: o.highlight === true,
      start_date,
      end_date,
      domains,
      core_keywords,
      keywords,
      synonyms,
      concepts: asStringArray(o.concepts),
      segments: asStringArray(o.segments),
      products: asStringArray(o.products),
      exclude_keywords: asStringArray(o.exclude_keywords),
      source: typeof o.source === "string" ? o.source.trim() : "",
      description_for_ai: typeof o.description_for_ai === "string" ? o.description_for_ai.trim() : "",
      config_file: file,
    });
    seen.add(id);
  }

  return { items, issues, version };
}
