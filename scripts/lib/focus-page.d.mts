/**
 * focus-page.mjs 类型声明（测试用；与 topics-page.d.mts / search-page.d.mts 同例）。
 *
 * 只声明页面真正读取的字段（契约全量见 lib/contracts/focus-ledger.ts）：
 * 页面是「消费方」，为避免 d.mts 与契约漂移，这里保持**结构最小集**而不是全量镜像。
 */
export interface FocusPageHit {
  focusId: string;
  level: "M2" | "M3";
  bonus?: number;
  reason?: string;
  itemId?: string;
  url?: string;
  title?: string;
  source?: string;
  itemDate?: string;
  section?: string;
  inMustRead?: boolean;
  inInsights?: boolean;
  isRisk?: boolean;
}

export interface FocusPageDay {
  date: string;
  version?: string;
  focuses?: Array<{
    id: string;
    name: string;
    layer: "annual" | "quarterly" | "temporary";
    grade?: string;
    count?: number;
    high?: number;
    domains?: string[];
  }>;
  hits?: FocusPageHit[];
}

export interface FocusPageDefinition {
  id: string;
  name: string;
  description?: string;
  layer: "annual" | "quarterly" | "temporary";
  grade?: string;
  start_date?: string;
  end_date?: string;
  domains?: string[];
  core_keywords?: string[];
  keywords?: string[];
  exclude_keywords?: string[];
  source?: string;
}

export interface FocusPageVersion {
  version: string;
  firstSeen?: string;
  lastSeen?: string;
  focuses?: FocusPageDefinition[];
}

export declare function renderFocusPage(opts: {
  ledger?: { days?: FocusPageDay[] } | null;
  archive?: { versions?: FocusPageVersion[] } | null;
  generatedAt?: string;
  latest?: string;
  today?: string;
  windowDays?: number;
  domainLabels?: Record<string, string>;
}): string;
